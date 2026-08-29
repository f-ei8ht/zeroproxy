import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { proxyRequest, roundRobin } from "../src/proxy";

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
});

describe("proxyRequest", () => {
  test("forwards the request and returns the upstream body", async () => {
    const req = new Request(`http://localhost/anything`, {
      headers: { host: "localhost" },
    });
    const res = await proxyRequest(req, roundRobin([upstreamUrl]));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("upstream-ok");
  });

  test("streams a request body through", async () => {
    const req = new Request(`http://localhost/p`, {
      method: "POST",
      body: "payload",
      headers: { host: "localhost" },
    });
    const res = await proxyRequest(req, roundRobin([upstreamUrl]));
    expect(await res.text()).toBe("echo:payload");
  });

  test("adds a CORS header to the response", async () => {
    const req = new Request("http://localhost/anything");
    const res = await proxyRequest(req, roundRobin([upstreamUrl]));
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("fails over to the next upstream", async () => {
    const req = new Request("http://localhost/anything");
    const res = await proxyRequest(req, roundRobin(["http://127.0.0.1:1", upstreamUrl]));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("upstream-ok");
  });

  test("returns 502 when every upstream cannot be reached", async () => {
    const req = new Request("http://localhost/x");
    const res = await proxyRequest(req, roundRobin(["http://127.0.0.1:1", "http://127.0.0.1:2"]));
    expect(res.status).toBe(502);
  });

  test("fails over an idempotent GET even with a dead first upstream", async () => {
    const req = new Request("http://localhost/anything");
    const res = await proxyRequest(req, roundRobin(["http://127.0.0.1:1", upstreamUrl]));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("upstream-ok");
  });

  test("does not retry a POST with a body", async () => {
    const req = new Request("http://localhost/p", {
      method: "POST",
      body: "payload",
    });
    const res = await proxyRequest(req, roundRobin(["http://127.0.0.1:1", upstreamUrl]));
    expect(res.status).toBe(502);
  });

  test("proxies a POST to a live upstream", async () => {
    const req = new Request("http://localhost/p", {
      method: "POST",
      body: "payload",
    });
    const res = await proxyRequest(req, roundRobin([upstreamUrl]));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("echo:payload");
  });
});
