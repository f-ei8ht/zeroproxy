import { describe, expect, test } from "bun:test";
import { validateConfig } from "../src/config";

describe("validateConfig", () => {
  test("applies defaults", () => {
    const config = validateConfig({});
    expect(config.port).toBe(8080);
    expect(config.host).toBe("0.0.0.0");
    expect(config.compression).toBe(true);
    expect(config.routes).toEqual([]);
  });

  test("parses upstream and static routes", () => {
    const config = validateConfig({
      routes: [
        { pattern: "/api/*", upstream: ["http://a", "http://b"], ws: true },
        { pattern: "/site/*", static: "./public", index: "index.html", fallback: "index.html" },
      ],
    });
    expect(config.routes[0]!.upstream).toEqual(["http://a", "http://b"]);
    expect(config.routes[0]!.ws).toBe(true);
    expect(config.routes[1]!.static).toBe("./public");
    expect(config.routes[1]!.fallback).toBe("index.html");
  });

  test("accepts a single upstream string", () => {
    const config = validateConfig({ routes: [{ pattern: "/*", upstream: "http://a" }] });
    expect(config.routes[0]!.upstream).toEqual(["http://a"]);
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
});
