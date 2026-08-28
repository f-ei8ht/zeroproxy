export type Encoding = "gzip" | "deflate" | "br" | "zstd" | "identity";

const PREFERRED: Encoding[] = ["zstd", "br", "gzip", "deflate"];

const FORMATS: Record<Exclude<Encoding, "identity">, string> = {
  gzip: "gzip",
  deflate: "deflate",
  br: "brotli",
  zstd: "zstd",
};

export function pickEncoding(acceptEncoding: string | null): Encoding {
  if (!acceptEncoding) return "identity";
  for (const encoding of PREFERRED) {
    if (acceptEncoding.includes(encoding)) return encoding;
  }
  if (acceptEncoding.includes("*")) return PREFERRED[0]!;
  return "identity";
}

export function compressBody(body: ReadableStream<Uint8Array>, encoding: Encoding): ReadableStream<Uint8Array> {
  if (encoding === "identity") return body;
  const stream = new CompressionStream(FORMATS[encoding] as ConstructorParameters<typeof CompressionStream>[0]);
  return body.pipeThrough(stream as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
}

export function shouldCompress(encoding: Encoding, res: Response): boolean {
  if (encoding === "identity") return false;
  if (res.headers.get("content-encoding")) return false;
  const type = res.headers.get("content-type") ?? "";
  if (/^image\//.test(type)) return false;
  return true;
}
