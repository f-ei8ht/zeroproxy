import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveStatic } from "../src/static";

let dir: string;
let listingDir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "zp-static-"));
  writeFileSync(join(dir, "hello.txt"), "hello world");
  writeFileSync(join(dir, "index.html"), "<h1>hi</h1>");

  listingDir = mkdtempSync(join(tmpdir(), "zp-static-noidx-"));
  writeFileSync(join(listingDir, "a.txt"), "A");
  mkdirSync(join(listingDir, "sub"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(listingDir, { recursive: true, force: true });
});

describe("serveStatic", () => {
  test("serves a file with the correct content type and body", async () => {
    const req = new Request("http://x/hello.txt");
    const res = serveStatic(req, dir, undefined, "hello.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe("hello world");
  });

  test("serves the directory index for a directory path", async () => {
    const req = new Request("http://x/");
    const res = serveStatic(req, dir, undefined, "");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<h1>hi</h1>");
  });

  test("serves the default index when indexFile is omitted", async () => {
    const req = new Request("http://x/");
    const res = serveStatic(req, dir, undefined, "");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<h1>hi</h1>");
  });

  test("returns 404 for a missing file", () => {
    const req = new Request("http://x/missing.txt");
    expect(serveStatic(req, dir, undefined, "missing.txt").status).toBe(404);
  });

  test("blocks path traversal", () => {
    const req = new Request("http://x/");
    expect(serveStatic(req, dir, undefined, "../../etc/passwd").status).toBe(404);
  });

  test("handles a single-byte Range request with 206", async () => {
    const req = new Request("http://x/hello.txt", {
      headers: { range: "bytes=0-4" },
    });
    const res = serveStatic(req, dir, undefined, "hello.txt");
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-4/11");
    expect(await res.text()).toBe("hello");
  });

  test("handles a suffix Range request", async () => {
    const req = new Request("http://x/hello.txt", {
      headers: { range: "bytes=-5" },
    });
    const res = serveStatic(req, dir, undefined, "hello.txt");
    expect(res.status).toBe(206);
    expect(await res.text()).toBe("world");
  });

  test("returns 416 for an unsatisfiable range", () => {
    const req = new Request("http://x/hello.txt", {
      headers: { range: "bytes=100-200" },
    });
    expect(serveStatic(req, dir, undefined, "hello.txt").status).toBe(416);
  });

  test("returns 304 when the client sends a matching ETag", () => {
    const first = serveStatic(new Request("http://x/hello.txt"), dir, undefined, "hello.txt");
    const etag = first.headers.get("etag")!;
    expect(etag).toBeTruthy();
    const req = new Request("http://x/hello.txt", {
      headers: { "if-none-match": etag },
    });
    expect(serveStatic(req, dir, undefined, "hello.txt").status).toBe(304);
  });

  test("generates a directory listing when no index exists", async () => {
    const res = serveStatic(new Request("http://x/"), listingDir, undefined, "");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("a.txt");
    expect(body).toContain("sub/");
  });

  test("serves the SPA fallback for a missing route", async () => {
    const res = serveStatic(new Request("http://x/deep/route"), listingDir, undefined, "deep/route", "a.txt");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("A");
  });
});
