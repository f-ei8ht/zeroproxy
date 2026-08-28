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
  test("cycles through upstreams in order", () => {
    const pick = roundRobin(["a", "b", "c"]);
    expect(pick()).toBe("a");
    expect(pick()).toBe("b");
    expect(pick()).toBe("c");
    expect(pick()).toBe("a");
  });
});

describe("proxyRequest", () => {
  test("forwards the request and returns the upstream body", async () => {
    const req = new Request(`http://localhost/anything`, {
      headers: { host: "localhost" },
    });
    const res = await proxyRequest(req, { pattern: "/*" }, () => upstreamUrl);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("upstream-ok");
  });

  test("streams a request body through", async () => {
    const req = new Request(`http://localhost/p`, {
      method: "POST",
      body: "payload",
      headers: { host: "localhost" },
    });
    const res = await proxyRequest(req, { pattern: "/*" }, () => upstreamUrl);
    expect(await res.text()).toBe("echo:payload");
  });

  test("returns 502 when the upstream cannot be reached", async () => {
    const req = new Request("http://localhost/x");
    const res = await proxyRequest(req, { pattern: "/*" }, () => "http://127.0.0.1:1");
    expect(res.status).toBe(502);
  });
});
