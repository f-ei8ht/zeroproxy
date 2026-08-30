export type Encoding = "gzip" | "deflate" | "br" | "zstd" | "identity";

const PREFERRED: Encoding[] = ["zstd", "br", "gzip", "deflate"];

const FORMATS: Record<Exclude<Encoding, "identity">, string> = {
  gzip: "gzip",
  deflate: "deflate",
  br: "brotli",
  zstd: "zstd",
};

// Content types that are already compressed or carry no benefit from gzip.
const NO_BENEFIT_TYPES = ["image/", "video/", "audio/", "font/"];

// Parses Accept-Encoding with q-values: an encoding excluded with q=0 is
// never chosen, the wildcard covers unlisted encodings, and the highest
// supported q wins with server preference breaking ties.
export function pickEncoding(acceptEncoding: string | null): Encoding {
  if (!acceptEncoding) return "identity";
  const weights = new Map<string, number>();
  for (const part of acceptEncoding.split(",")) {
    const [rawName, ...params] = part.trim().split(";");
    if (!rawName) continue;
    let q = 1;
    for (const param of params) {
      const [key, value] = param.trim().split("=");
      if (key === "q") q = Number(value) || 0;
    }
    weights.set(rawName.trim().toLowerCase(), q);
  }
  const wildcard = weights.get("*") ?? 0;
  let chosen: Encoding | undefined;
  let chosenQ = 0;
  for (const encoding of PREFERRED) {
    const q = weights.has(encoding) ? weights.get(encoding)! : wildcard;
    if (q > 0 && q > chosenQ) {
      chosen = encoding;
      chosenQ = q;
    }
  }
  return chosen ?? "identity";
}

export function compressBody(body: ReadableStream<Uint8Array>, encoding: Encoding): ReadableStream<Uint8Array> {
  if (encoding === "identity") return body;
  const stream = new CompressionStream(FORMATS[encoding] as ConstructorParameters<typeof CompressionStream>[0]);
  return body.pipeThrough(stream as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
}

export function shouldCompress(encoding: Encoding, res: Response, minBytes: number): boolean {
  if (encoding === "identity") return false;
  // Partial and error responses pass through untouched.
  if (res.status !== 200) return false;
  if (res.headers.get("content-encoding")) return false;
  const type = res.headers.get("content-type") ?? "";
  if (NO_BENEFIT_TYPES.some((prefix) => type.startsWith(prefix))) return false;
  const length = Number(res.headers.get("content-length") ?? "0");
  if (length > 0 && length < minBytes) return false;
  return true;
}
