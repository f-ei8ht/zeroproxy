import type { Balancer } from "./balancer";

const UPSTREAM_TIMEOUT_MS = 30000;

function upstreamFailure(timedOut: boolean): Response {
  return new Response(timedOut ? "Upstream timeout" : "Bad gateway", {
    status: timedOut ? 504 : 502,
    statusText: timedOut ? "Gateway Timeout" : "Bad Gateway",
  });
}

type Attempt = { res?: Response; timedOut?: boolean };

async function tryFetch(
  target: string,
  method: string,
  headers: Headers,
  body: Uint8Array | ReadableStream | null,
  url: string,
): Promise<Attempt> {
  const init: RequestInit = {
    method,
    headers,
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  };
  try {
    return { res: await fetch(url, init) };
  } catch (err) {
    const timedOut = err instanceof DOMException && err.name === "TimeoutError";
    return timedOut ? { timedOut: true } : {};
  }
}

export async function proxyRequest(
  req: Request,
  balancer: Balancer,
  retryBodyLimitBytes: number,
): Promise<Response> {
  const orig = new URL(req.url);
  const headers = new Headers(req.headers);
  headers.delete("host");
  headers.set("x-forwarded-host", orig.host);
  headers.set("x-forwarded-proto", orig.protocol.replace(":", ""));

  // Decide retryability before consuming the body. A known upload larger than
  // the limit is streamed once (no buffering, no retry); a bodyless request or
  // a small/unknown-size body is buffered so failover can replay it.
  const hasBody = req.body !== null;
  const declared = Number(req.headers.get("content-length") ?? "0");
  const streamOnce = hasBody && declared > retryBodyLimitBytes;
  let buffered: Uint8Array | null = null;
  let retry = !hasBody;
  if (hasBody && !streamOnce) {
    buffered = new Uint8Array(await req.arrayBuffer());
    retry = buffered.byteLength <= retryBodyLimitBytes;
  }

  const candidates = balancer.rotate();
  const attempts = retry ? candidates : candidates.slice(0, 1);
  const suffix = orig.pathname + orig.search;

  let allTimedOut = false;
  for (const target of attempts) {
    const url = target.replace(/\/$/, "") + suffix;
    const { res, timedOut } = await tryFetch(
      target,
      req.method,
      headers,
      streamOnce ? req.body : buffered,
      url,
    );
    if (res) {
      const resHeaders = new Headers(res.headers);
      resHeaders.set("access-control-allow-origin", "*");
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: resHeaders });
    }
    if (timedOut) allTimedOut = true;
  }
  return upstreamFailure(allTimedOut);
}

export { roundRobin } from "./balancer";
export type { Balancer } from "./balancer";

