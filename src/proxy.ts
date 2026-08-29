const UPSTREAM_TIMEOUT_MS = 30000;

export type Balancer = {
  pick: () => string;
  rotate: () => string[];
};

export function roundRobin(upstreams: string[]): Balancer {
  let index = 0;
  const pick = () => {
    const target = upstreams[index % upstreams.length]!;
    index++;
    return target;
  };
  return {
    pick,
    rotate: () => {
      const start = index % upstreams.length;
      return upstreams.slice(start).concat(upstreams.slice(0, start));
    },
  };
}

function upstreamFailure(timedOut: boolean): Response {
  return new Response(timedOut ? "Upstream timeout" : "Bad gateway", {
    status: timedOut ? 504 : 502,
    statusText: timedOut ? "Gateway Timeout" : "Bad Gateway",
  });
}

const IDEMPOTENT = new Set(["GET", "HEAD", "OPTIONS", "TRACE"]);

// A body stream can only be consumed once, so only retry when the request has
// no body or uses an idempotent method whose body is safe to replay.
function isReplayable(req: Request): boolean {
  return req.body === null || IDEMPOTENT.has(req.method.toUpperCase());
}

type Attempt = { res?: Response; timedOut?: boolean };

async function tryFetch(req: Request, target: string): Promise<Attempt> {
  const orig = new URL(req.url);
  const headers = new Headers(req.headers);
  headers.delete("host");
  headers.set("x-forwarded-host", orig.host);
  headers.set("x-forwarded-proto", orig.protocol.replace(":", ""));

  const url = target.replace(/\/$/, "") + orig.pathname + orig.search;
  const init: RequestInit = {
    method: req.method,
    headers,
    body: req.body,
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

export async function proxyRequest(req: Request, balancer: Balancer): Promise<Response> {
  const candidates = balancer.rotate();
  const attempts = isReplayable(req) ? candidates : candidates.slice(0, 1);
  let allTimedOut = false;
  for (const target of attempts) {
    const { res, timedOut } = await tryFetch(req, target);
    if (res) {
      const headers = new Headers(res.headers);
      headers.set("access-control-allow-origin", "*");
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    }
    if (timedOut) allTimedOut = true;
  }
  return upstreamFailure(allTimedOut);
}
