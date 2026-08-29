import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { proxyRequest, roundRobin } from "../src/proxy";
import type { Balancer } from "../src/proxy";

const LIMIT = 64 * 1024;

let upstream: ReturnType<typeof Bun.serve>;
let upstreamUrl: string;

beforeAll(async () => {
  upstream = Bun.serve({
    port: 0,
    fetch(req) {
      if (req.method === "POST") {
        return req.text().then((body) => new Response(`echo:${body}`));
      }
      return new Response("upstream-ok");
    },
  });
  upstreamUrl = `http://localhost:${upstream.port}`;
});

afterAll(() => {
  upstream.stop(true);
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
});

describe("proxyRequest", () => {
  test("forwards the request and returns the upstream body", async () => {
    const req = new Request(`http://localhost/anything`, { headers: { host: "localhost" } });
    const res = await proxyRequest(req, roundRobin([upstreamUrl]), LIMIT);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("upstream-ok");
  });

  test("streams a request body through", async () => {
    const req = new Request(`http://localhost/p`, { method: "POST", body: "payload", headers: { host: "localhost" } });
    const res = await proxyRequest(req, roundRobin([upstreamUrl]), LIMIT);
    expect(await res.text()).toBe("echo:payload");
  });

  test("adds a CORS header to the response", async () => {
    const res = await proxyRequest(new Request("http://localhost/anything"), roundRobin([upstreamUrl]), LIMIT);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("fails over to the next upstream", async () => {
    const res = await proxyRequest(
      new Request("http://localhost/anything"),
      roundRobin(["http://127.0.0.1:1", upstreamUrl]),
      LIMIT,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("upstream-ok");
  });

  test("returns 502 when every upstream cannot be reached", async () => {
    const res = await proxyRequest(
      new Request("http://localhost/x"),
      roundRobin(["http://127.0.0.1:1", "http://127.0.0.1:2"]),
      LIMIT,
    );
    expect(res.status).toBe(502);
  });

  test("retries a small POST body across a dead upstream", async () => {
    const res = await proxyRequest(
      new Request("http://localhost/p", { method: "POST", body: "payload" }),
      roundRobin(["http://127.0.0.1:1", upstreamUrl]),
      LIMIT,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("echo:payload");
  });

  test("does not retry a body larger than the limit", async () => {
    const res = await proxyRequest(
      new Request("http://localhost/p", { method: "POST", body: "x".repeat(LIMIT + 1) }),
      roundRobin(["http://127.0.0.1:1", upstreamUrl]),
      LIMIT,
    );
    expect(res.status).toBe(502);
  });
});
