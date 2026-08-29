import { describe, expect, test } from "bun:test";
import { gunzipSync, inflateSync, brotliDecompressSync, zstdDecompressSync } from "node:zlib";
import { compressBody, pickEncoding, shouldCompress } from "../src/compress";

const sample = new TextEncoder().encode("hello world ".repeat(200));

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return new Uint8Array(chunks.reduce((acc, c) => acc.concat([...c]), [] as number[]));
}

const DECOMPRESS: Record<string, (b: Uint8Array) => Uint8Array> = {
  gzip: (b) => new Uint8Array(gunzipSync(b)),
  deflate: (b) => new Uint8Array(inflateSync(b)),
  br: (b) => new Uint8Array(brotliDecompressSync(b)),
  zstd: (b) => new Uint8Array(zstdDecompressSync(b)),
};

describe("pickEncoding", () => {
  test("returns identity when the header is absent", () => {
    expect(pickEncoding(null)).toBe("identity");
  });

  test("returns identity when nothing acceptable is advertised", () => {
    expect(pickEncoding("identity")).toBe("identity");
  });

  test("picks the highest-preference supported encoding", () => {
    expect(pickEncoding("gzip, deflate")).toBe("gzip");
    expect(pickEncoding("deflate")).toBe("deflate");
    expect(pickEncoding("br")).toBe("br");
    expect(pickEncoding("zstd")).toBe("zstd");
  });

  test("prefers zstd over brotli over gzip", () => {
    expect(pickEncoding("gzip, br, zstd")).toBe("zstd");
    expect(pickEncoding("gzip, br")).toBe("br");
  });

  test("uses zstd for a wildcard header", () => {
    expect(pickEncoding("*")).toBe("zstd");
  });
});

describe("shouldCompress", () => {
  test("is false for identity", () => {
    expect(shouldCompress("identity", new Response("x"))).toBe(false);
  });

  test("is false when the response is already encoded", () => {
    const res = new Response("x", { headers: { "content-encoding": "gzip" } });
    expect(shouldCompress("gzip", res)).toBe(false);
  });

  test("is false for image content", () => {
    const res = new Response("x".repeat(500), { headers: { "content-type": "image/png" } });
    expect(shouldCompress("gzip", res)).toBe(false);
  });

  test("is false for video and font content", () => {
    expect(shouldCompress("gzip", new Response("x".repeat(500), { headers: { "content-type": "video/mp4" } }))).toBe(false);
    expect(shouldCompress("gzip", new Response("x".repeat(500), { headers: { "content-type": "font/woff2" } }))).toBe(false);
  });

  test("is false for tiny responses", () => {
    const res = new Response("hello", { headers: { "content-length": "5" } });
    expect(shouldCompress("gzip", res)).toBe(false);
  });

  test("is true for compressible text above the minimum size", () => {
    expect(shouldCompress("gzip", new Response("x".repeat(1000)))).toBe(true);
  });
});

describe("compressBody", () => {
  for (const enc of ["gzip", "deflate", "br", "zstd"] as const) {
    test(`${enc} round-trips through CompressionStream`, async () => {
      const stream = new Blob([sample]).stream();
      const compressed = await collect(compressBody(stream, enc));
      expect(compressed.length).toBeLessThan(sample.length);
      const restored = DECOMPRESS[enc]!(compressed);
      expect(Buffer.from(restored).equals(Buffer.from(sample))).toBe(true);
    });
  }

  test("returns the body unchanged for identity", async () => {
    const stream = new Blob([sample]).stream();
    const out = await collect(compressBody(stream, "identity"));
    expect(Buffer.from(out).equals(Buffer.from(sample))).toBe(true);
  });
});
