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
    const res = await serveStatic(new Request("http://x/hello.txt"), dir, undefined, "hello.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe("hello world");
  });

  test("serves the directory index for a directory path", async () => {
    const res = await serveStatic(new Request("http://x/"), dir, undefined, "");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<h1>hi</h1>");
  });

  test("returns 404 for a missing file", async () => {
    const res = await serveStatic(new Request("http://x/missing.txt"), dir, undefined, "missing.txt");
    expect(res.status).toBe(404);
  });

  test("blocks path traversal", async () => {
    const res = await serveStatic(new Request("http://x/"), dir, undefined, "../../etc/passwd");
    expect(res.status).toBe(404);
  });

  test("handles a single-byte Range request with 206", async () => {
    const res = await serveStatic(
      new Request("http://x/hello.txt", { headers: { range: "bytes=0-4" } }),
      dir,
      undefined,
      "hello.txt",
    );
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-4/11");
    expect(await res.text()).toBe("hello");
  });

  test("handles a suffix Range request", async () => {
    const res = await serveStatic(
      new Request("http://x/hello.txt", { headers: { range: "bytes=-5" } }),
      dir,
      undefined,
      "hello.txt",
    );
    expect(res.status).toBe(206);
    expect(await res.text()).toBe("world");
  });

  test("returns 416 for an unsatisfiable range", async () => {
    const res = await serveStatic(
      new Request("http://x/hello.txt", { headers: { range: "bytes=100-200" } }),
      dir,
      undefined,
      "hello.txt",
    );
    expect(res.status).toBe(416);
  });

  test("returns 416 for a zero-length suffix range", async () => {
    const res = await serveStatic(
      new Request("http://x/hello.txt", { headers: { range: "bytes=-0" } }),
      dir,
      undefined,
      "hello.txt",
    );
    expect(res.status).toBe(416);
  });

  test("ignores a multi-range header and sends the full body", async () => {
    const res = await serveStatic(
      new Request("http://x/hello.txt", { headers: { range: "bytes=0-1,4-9" } }),
      dir,
      undefined,
      "hello.txt",
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello world");
  });

  test("ignores a malformed range header", async () => {
    const res = await serveStatic(
      new Request("http://x/hello.txt", { headers: { range: "bytes=abc" } }),
      dir,
      undefined,
      "hello.txt",
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello world");
  });

  test("ignores a reversed range header", async () => {
    const res = await serveStatic(
      new Request("http://x/hello.txt", { headers: { range: "bytes=5-2" } }),
      dir,
      undefined,
      "hello.txt",
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello world");
  });

  test("returns 304 when the client sends a matching ETag", async () => {
    const first = await serveStatic(new Request("http://x/hello.txt"), dir, undefined, "hello.txt");
    const etag = first.headers.get("etag")!;
    expect(etag).toBeTruthy();
    const res = await serveStatic(
      new Request("http://x/hello.txt", { headers: { "if-none-match": etag } }),
      dir,
      undefined,
      "hello.txt",
    );
    expect(res.status).toBe(304);
  });

  test("returns 304 on If-Modified-Since when unmodified", async () => {
    const first = await serveStatic(new Request("http://x/hello.txt"), dir, undefined, "hello.txt");
    const lastModified = first.headers.get("last-modified")!;
    expect(lastModified).toBeTruthy();
    const res = await serveStatic(
      new Request("http://x/hello.txt", { headers: { "if-modified-since": lastModified } }),
      dir,
      undefined,
      "hello.txt",
    );
    expect(res.status).toBe(304);
  });

  test("sets the last-modified header", async () => {
    const res = await serveStatic(new Request("http://x/hello.txt"), dir, undefined, "hello.txt");
    expect(res.headers.get("last-modified")).toBeTruthy();
  });

  test("generates a directory listing when no index exists", async () => {
    const res = await serveStatic(new Request("http://x/"), listingDir, undefined, "");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("a.txt");
    expect(body).toContain("sub/");
  });

  test("lists a parent link in a subdirectory listing", async () => {
    const res = await serveStatic(new Request("http://x/"), listingDir, undefined, "sub");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("../");
  });

  test("serves the SPA fallback for a missing route", async () => {
    const res = await serveStatic(new Request("http://x/deep/route"), listingDir, undefined, "deep/route", "a.txt");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("A");
  });

  test("blocks dotfiles", async () => {
    writeFileSync(join(dir, ".hidden"), "secret");
    const res = await serveStatic(new Request("http://x/"), dir, undefined, ".hidden");
    expect(res.status).toBe(404);
  });

  test("applies a per-route cache-control header", async () => {
    const res = await serveStatic(
      new Request("http://x/hello.txt"),
      dir,
      undefined,
      "hello.txt",
      undefined,
      "public, max-age=3600",
    );
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
  });
});
