import { describe, expect, test } from "bun:test";
import { validateConfig } from "../src/config";

describe("validateConfig", () => {
  test("applies defaults", () => {
    const config = validateConfig({});
    expect(config.port).toBe(8080);
    expect(config.host).toBe("0.0.0.0");
    expect(config.compression).toBe(true);
    expect(config.retryBodyLimitBytes).toBe(65536);
    expect(config.healthCheck.intervalMs).toBe(5000);
    expect(config.routes).toEqual([]);
    expect(config.tls).toBeUndefined();
  });

  test("parses upstream and static routes with new fields", () => {
    const config = validateConfig({
      routes: [
        { pattern: "/api/*", upstream: ["http://a", { url: "http://b", weight: 3 }], ws: true },
        { pattern: "/site/*", static: "./public", index: "index.html", fallback: "index.html", cacheControl: "public, max-age=3600" },
      ],
    });
    expect(config.routes[0]!.upstream).toEqual(["http://a", { url: "http://b", weight: 3 }]);
    expect(config.routes[0]!.ws).toBe(true);
    expect(config.routes[1]!.static).toBe("./public");
    expect(config.routes[1]!.fallback).toBe("index.html");
    expect(config.routes[1]!.cacheControl).toBe("public, max-age=3600");
  });

  test("accepts a single upstream string", () => {
    const config = validateConfig({ routes: [{ pattern: "/*", upstream: "http://a" }] });
    expect(config.routes[0]!.upstream).toEqual(["http://a"]);
  });

  test("parses healthCheck and tls", () => {
    const config = validateConfig({
      healthCheck: { intervalMs: 1000, timeoutMs: 500, path: "/health" },
      tls: { cert: "./cert.pem", key: "./key.pem" },
    });
    expect(config.healthCheck).toEqual({ intervalMs: 1000, timeoutMs: 500, path: "/health" });
    expect(config.tls).toEqual({ cert: "./cert.pem", key: "./key.pem" });
  });

  test("rejects an invalid port", () => {
    expect(() => validateConfig({ port: 70000 })).toThrow();
    expect(() => validateConfig({ port: 0 })).toThrow();
  });

  test("rejects a route with neither upstream nor static", () => {
    expect(() => validateConfig({ routes: [{ pattern: "/x" }] })).toThrow();
  });

  test("rejects an invalid upstream url", () => {
    expect(() => validateConfig({ routes: [{ pattern: "/*", upstream: ["not-a-url"] }] })).toThrow();
  });

  test("rejects a bad weight", () => {
    expect(() => validateConfig({ routes: [{ pattern: "/*", upstream: [{ url: "http://a", weight: 0 }] }] })).toThrow();
  });

  test("rejects a non-string method", () => {
    expect(() => validateConfig({ routes: [{ pattern: "/*", upstream: "http://a", method: 42 }] })).toThrow();
  });

  test("rejects an invalid healthCheck path", () => {
    expect(() => validateConfig({ healthCheck: { path: "nope" } })).toThrow();
  });

  test("rejects tls without key", () => {
    expect(() => validateConfig({ tls: { cert: "./c.pem" } })).toThrow();
  });
});
