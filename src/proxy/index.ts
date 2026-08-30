import type { Balancer } from "./balancer";

const PROXY_VIA = "1.1 zeroproxy";

// RFC 9110 hop-by-hop headers, plus anything the Connection header names.
const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

// A timeout does not prove the request was never delivered, so a timed-out
// non-idempotent request is never replayed on another upstream.
const IDEMPOTENT = new Set(["GET", "HEAD", "PUT", "DELETE", "OPTIONS", "TRACE"]);

export type ProxyOptions = {
  retryBodyLimitBytes: number;
  upstreamTimeoutMs: number;
  maxRequestBodyBytes: number;
};

type BodyPlan = { body: Uint8Array | ReadableStream<Uint8Array> | null; replay: boolean };

function upstreamFailure(timedOut: boolean): Response {
  return new Response(timedOut ? "Upstream timeout" : "Bad gateway", {
    status: timedOut ? 504 : 502,
    statusText: timedOut ? "Gateway Timeout" : "Bad Gateway",
  });
}

function bodyTooLarge(): Response {
  return new Response("Payload Too Large", { status: 413, statusText: "Payload Too Large" });
}

function stripHopByHop(headers: Headers): void {
  const connection = headers.get("connection");
  if (connection) {
    for (const name of connection.split(",")) headers.delete(name.trim().toLowerCase());
  }
  for (const name of HOP_BY_HOP) headers.delete(name);
}

function addVia(headers: Headers): void {
  const existing = headers.get("via");
  headers.set("via", existing ? `${existing}, ${PROXY_VIA}` : PROXY_VIA);
}

type Attempt = { res?: Response; timedOut?: boolean };

async function tryFetch(
  method: string,
  headers: Headers,
  body: Uint8Array | ReadableStream<Uint8Array> | null,
  url: string,
  timeoutMs: number,
): Promise<Attempt> {
  const init: RequestInit = {
    method,
    headers,
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  };
  try {
    return { res: await fetch(url, init) };
  } catch (err) {
    const timedOut = err instanceof DOMException && err.name === "TimeoutError";
    return timedOut ? { timedOut: true } : {};
  }
}

// The minimum reader shape spliceTail needs, independent of which
// ReadableStreamDefaultReader declaration wins between libs.
type BodyReader = {
  read(): Promise<{ done: false; value: Uint8Array } | { done: true; value?: undefined }>;
  cancel(reason?: unknown): Promise<void>;
};

// Plays the buffered chunks first, then keeps reading the original body, so
// an oversized unknown-length request still streams instead of re-buffering.
function spliceTail(chunks: Uint8Array[], reader: BodyReader): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index]!);
        index++;
        return;
      }
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

// Decides retryability before the body is sent. A known size over the
// replay limit streams once. An unknown size (chunked) is read up to the
// limit and replayed if it ends there; past the limit the already-read
// bytes are spliced onto the unread tail and the body is sent once.
async function planBody(req: Request, opts: ProxyOptions): Promise<BodyPlan | Response> {
  if (req.body === null) return { body: null, replay: true };
  const declaredRaw = req.headers.get("content-length");
  const declared = declaredRaw === null ? undefined : Number(declaredRaw);
  if (declared !== undefined && Number.isFinite(declared)) {
    if (opts.maxRequestBodyBytes > 0 && declared > opts.maxRequestBodyBytes) return bodyTooLarge();
    if (declared > opts.retryBodyLimitBytes) return { body: req.body, replay: false };
    return { body: new Uint8Array(await req.arrayBuffer()), replay: true };
  }
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let overflow = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
    if (opts.maxRequestBodyBytes > 0 && total > opts.maxRequestBodyBytes) {
      await reader.cancel();
      return bodyTooLarge();
    }
    if (total > opts.retryBodyLimitBytes) {
      overflow = true;
      break;
    }
  }
  if (overflow) return { body: spliceTail(chunks, reader), replay: false };
  return { body: new Uint8Array(await new Blob(chunks).arrayBuffer()), replay: true };
}

export async function proxyRequest(
  req: Request,
  balancer: Balancer,
  opts: ProxyOptions,
): Promise<Response> {
  const orig = new URL(req.url);
  const headers = new Headers(req.headers);
  headers.delete("host");
  stripHopByHop(headers);
  headers.set("x-forwarded-host", orig.host);
  headers.set("x-forwarded-proto", orig.protocol.replace(":", ""));
  addVia(headers);

  const plan = await planBody(req, opts);
  if (plan instanceof Response) return plan;

  // pick() consumes one turn so consecutive requests rotate; rotate() then
  // lists the remaining healthy upstreams as failover candidates.
  const primary = balancer.pick();
  const candidates = [primary, ...balancer.rotate().filter((url) => url !== primary)];
  const attempts = plan.replay ? candidates : candidates.slice(0, 1);
  const suffix = orig.pathname + orig.search;
  const idempotent = IDEMPOTENT.has(req.method.toUpperCase());

  let timedOut = false;
  for (const target of attempts) {
    const url = target.replace(/\/$/, "") + suffix;
    const attempt = await tryFetch(req.method, headers, plan.body, url, opts.upstreamTimeoutMs);
    if (attempt.res) {
      const resHeaders = new Headers(attempt.res.headers);
      stripHopByHop(resHeaders);
      resHeaders.set("access-control-allow-origin", "*");
      addVia(resHeaders);
      return new Response(attempt.res.body, {
        status: attempt.res.status,
        statusText: attempt.res.statusText,
        headers: resHeaders,
      });
    }
    if (attempt.timedOut) {
      timedOut = true;
      if (!idempotent) break;
    }
  }
  return upstreamFailure(timedOut);
}

export { roundRobin } from "./balancer";
export type { Balancer } from "./balancer";
