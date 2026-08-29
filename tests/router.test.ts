import { describe, expect, test } from "bun:test";
import { allowedMethods, compileRoutes, matchRoute } from "../src/router";

const routes = [
  { pattern: "/static/*" },
  { pattern: "/users/:id" },
  { pattern: "/api/*", method: "POST" },
];

const compiled = compileRoutes(routes);

describe("matchRoute", () => {
  test("matches a wildcard and captures the remainder", () => {
    const match = matchRoute(compiled, "GET", "/static/big.txt");
    expect(match?.route.pattern).toBe("/static/*");
    expect(match?.params["0"]).toBe("big.txt");
  });

  test("matches a named parameter", () => {
    const match = matchRoute(compiled, "GET", "/users/42");
    expect(match?.route.pattern).toBe("/users/:id");
    expect(match?.params.id).toBe("42");
  });

  test("respects the method constraint", () => {
    expect(matchRoute(compiled, "GET", "/api/x")).toBeUndefined();
    expect(matchRoute(compiled, "POST", "/api/x")?.route.pattern).toBe("/api/*");
    expect(matchRoute(compiled, "post", "/api/x")).toBeDefined();
  });

  test("returns undefined when nothing matches", () => {
    expect(matchRoute(compiled, "GET", "/nope")).toBeUndefined();
  });

  test("compares methods case-insensitively", () => {
    expect(matchRoute(compiled, "get", "/users/1")?.route.pattern).toBe("/users/:id");
  });
});

describe("allowedMethods", () => {
  test("returns the constrained method for a method-mismatched path", () => {
    expect(allowedMethods(compiled, "/api/x")).toContain("POST");
  });

  test("returns GET for a methodless matching route", () => {
    expect(allowedMethods(compiled, "/static/big.txt")).toContain("GET");
  });

  test("returns nothing when no route matches the path", () => {
    expect(allowedMethods(compiled, "/nope")).toEqual([]);
  });
});
