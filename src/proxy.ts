import type { Route } from "./config";

const UPSTREAM_TIMEOUT_MS = 30000;

export function roundRobin(upstreams: string[]): () => string {
  let index = 0;
  return () => {
    const target = upstreams[index % upstreams.length]!;
    index++;
    return target;
  };
}

function upstreamFailure(req: Request, timedOut: boolean): Response {
  return new Response(timedOut ? "Upstream timeout" : "Bad gateway", {
    status: timedOut ? 504 : 502,
    statusText: timedOut ? "Gateway Timeout" : "Bad Gateway",
  });
}

export async function proxyRequest(
  req: Request,
  route: Route,
  pick: () => string,
): Promise<Response> {
  const target = pick();
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
    return await fetch(url, init);
  } catch (err) {
    const timedOut = err instanceof DOMException && err.name === "TimeoutError";
    return upstreamFailure(req, timedOut);
  }
}
