import { describe, expect, test } from "bun:test";
import { isWebSocketRequest, upstreamSocketUrl } from "../src/ws";

describe("isWebSocketRequest", () => {
  test("detects an upgrade header", () => {
    const req = new Request("http://x/", { headers: { upgrade: "websocket" } });
    expect(isWebSocketRequest(req)).toBe(true);
  });

  test("rejects a plain request", () => {
    expect(isWebSocketRequest(new Request("http://x/"))).toBe(false);
  });
});

describe("upstreamSocketUrl", () => {
  test("converts http to ws preserving the path", () => {
    const req = new Request("http://x/socket?q=1");
    expect(upstreamSocketUrl("http://upstream:3000", req)).toBe("ws://upstream:3000/socket?q=1");
  });

  test("converts https to wss", () => {
    const req = new Request("http://x/socket");
    expect(upstreamSocketUrl("https://upstream", req)).toBe("wss://upstream/socket");
  });
});
