import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { proxyRequest, roundRobin } from "../src/proxy";
import type { ProxyOptions } from "../src/proxy";

const LIMIT = 64 * 1024;
const DEAD = "http://127.0.0.1:1";

const opts = (over: Partial<ProxyOptions> = {}): ProxyOptions => ({
  retryBodyLimitBytes: LIMIT,
  upstreamTimeoutMs: 5000,
  maxRequestBodyBytes: 0,
  ...over,
});

let upstream: ReturnType<typeof Bun.serve>;
let slow: ReturnType<typeof Bun.serve>;
let upstreamUrl: string;
let slowUrl: string;

beforeAll(() => {
  upstream = Bun.serve({
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname === "/hdrs") {
        return Response.json({
          te: req.headers.get("te"),
          proxyAuthorization: req.headers.get("proxy-authorization"),
          via: req.headers.get("via"),
        });
      }
      if (req.method === "POST") {
        return new Response(`echo:${await req.text()}`);
      }
      return new Response("upstream-ok");
    },
  });
  slow = Bun.serve({
    port: 0,
    async fetch() {
      await new Promise((r) => setTimeout(r, 400));
      return new Response("late");
    },
  });
  upstreamUrl = `http://localhost:${upstream.port}`;
  slowUrl = `http://localhost:${slow.port}`;
});

afterAll(() => {
  upstream.stop(true);
  slow.stop(true);
});

describe("roundRobin", () => {
  test("rotates upstreams in order", () => {
    const balancer = roundRobin(["a", "b", "c"]);
    expect(balancer.rotate()).toEqual(["a", "b", "c"]);
    balancer.pick();
    expect(balancer.rotate()).toEqual(["b", "c", "a"]);
  });

  test("skips upstreams marked unhealthy", () => {
    const balancer = roundRobin(["a", "b", "c"]);
    balancer.mark("b", false);
    const rot = balancer.rotate();
    expect(rot).toContain("a");
    expect(rot).toContain("c");
    expect(rot).not.toContain("b");
  });

  test("returns healthy upstreams ordered by weight first", () => {
    const balancer = roundRobin([
      { url: "a", weight: 1 },
      { url: "b", weight: 5 },
    ]);
    expect(balancer.rotate()).toEqual(["b", "a"]);
  });

  test("distributes picks proportionally to weight", () => {
    const balancer = roundRobin([
      { url: "a", weight: 1 },
      { url: "b", weight: 3 },
    ]);
    const counts = { a: 0, b: 0 };
    for (let i = 0; i < 400; i++) counts[balancer.pick() as "a" | "b"]++;
    expect(counts.a).toBe(100);
    expect(counts.b).toBe(300);
  });
});

describe("proxyRequest", () => {
  test("forwards the request and returns the upstream body", async () => {
    const req = new Request("http://localhost/anything", { headers: { host: "localhost" } });
    const res = await proxyRequest(req, roundRobin([upstreamUrl]), opts());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("upstream-ok");
  });

  test("streams a request body through", async () => {
    const req = new Request("http://localhost/p", { method: "POST", body: "payload", headers: { host: "localhost" } });
    const res = await proxyRequest(req, roundRobin([upstreamUrl]), opts());
    expect(await res.text()).toBe("echo:payload");
  });

  test("adds a CORS header and via to the response", async () => {
    const res = await proxyRequest(new Request("http://localhost/anything"), roundRobin([upstreamUrl]), opts());
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("via")).toBe("1.1 zeroproxy");
  });

  test("strips hop-by-hop headers and appends via to the request", async () => {
    const req = new Request("http://localhost/hdrs", {
      headers: { te: "trailers", "proxy-authorization": "Basic secret" },
    });
    const res = await proxyRequest(req, roundRobin([upstreamUrl]), opts());
    const seen = (await res.json()) as { te: string | null; proxyAuthorization: string | null; via: string | null };
    expect(seen.te).toBeNull();
    expect(seen.proxyAuthorization).toBeNull();
    expect(seen.via).toBe("1.1 zeroproxy");
  });

  test("consecutive requests rotate across upstreams", async () => {
    const second = Bun.serve({ port: 0, fetch: () => new Response("upstream-two") });
    try {
      const balancer = roundRobin([upstreamUrl, `http://localhost:${second.port}`]);
      const first = await proxyRequest(new Request("http://localhost/anything"), balancer, opts());
      const next = await proxyRequest(new Request("http://localhost/anything"), balancer, opts());
      const bodies = new Set([await first.text(), await next.text()]);
      expect(bodies).toEqual(new Set(["upstream-ok", "upstream-two"]));
    } finally {
      second.stop(true);
    }
  });

  test("fails over to the next upstream", async () => {
    const res = await proxyRequest(new Request("http://localhost/anything"), roundRobin([DEAD, upstreamUrl]), opts());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("upstream-ok");
  });

  test("fails over after a timeout on an idempotent method", async () => {
    const res = await proxyRequest(
      new Request("http://localhost/anything"),
      roundRobin([slowUrl, upstreamUrl]),
      opts({ upstreamTimeoutMs: 100 }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("upstream-ok");
  });

  test("does not retry a non-idempotent method after a timeout", async () => {
    const res = await proxyRequest(
      new Request("http://localhost/p", { method: "POST", body: "payload" }),
      roundRobin([slowUrl, upstreamUrl]),
      opts({ upstreamTimeoutMs: 100 }),
    );
    expect(res.status).toBe(504);
  });

  test("returns 502 when every upstream cannot be reached", async () => {
    const res = await proxyRequest(new Request("http://localhost/x"), roundRobin([DEAD, "http://127.0.0.1:2"]), opts());
    expect(res.status).toBe(502);
  });

  test("retries a small POST body across a dead upstream", async () => {
    const res = await proxyRequest(
      new Request("http://localhost/p", { method: "POST", body: "payload" }),
      roundRobin([DEAD, upstreamUrl]),
      opts(),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("echo:payload");
  });

  test("retries a small unknown-length body across a dead upstream", async () => {
    const req = new Request("http://localhost/p", {
      method: "POST",
      body: new Blob(["payload"]).stream(),
      duplex: "half",
    });
    const res = await proxyRequest(req, roundRobin([DEAD, upstreamUrl]), opts());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("echo:payload");
  });

  test("streams a large unknown-length body once without retrying", async () => {
    const req = new Request("http://localhost/p", {
      method: "POST",
      body: new Blob(["x".repeat(LIMIT + 1)]).stream(),
      duplex: "half",
    });
    const res = await proxyRequest(req, roundRobin([DEAD, upstreamUrl]), opts());
    expect(res.status).toBe(502);
  });

  test("does not retry a body larger than the limit", async () => {
    const res = await proxyRequest(
      new Request("http://localhost/p", { method: "POST", body: "x".repeat(LIMIT + 1) }),
      roundRobin([DEAD, upstreamUrl]),
      opts(),
    );
    expect(res.status).toBe(502);
  });

  test("returns 413 for a declared body over the cap", async () => {
    const res = await proxyRequest(
      new Request("http://localhost/p", { method: "POST", body: "x".repeat(10) }),
      roundRobin([DEAD]),
      opts({ maxRequestBodyBytes: 5 }),
    );
    expect(res.status).toBe(413);
  });

  test("returns 413 for an unknown-length body over the cap", async () => {
    const req = new Request("http://localhost/p", {
      method: "POST",
      body: new Blob(["x".repeat(10)]).stream(),
      duplex: "half",
    });
    const res = await proxyRequest(req, roundRobin([DEAD]), opts({ maxRequestBodyBytes: 5 }));
    expect(res.status).toBe(413);
  });
});
