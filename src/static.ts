import { createHash } from "node:crypto";
import { extname, join, resolve, sep } from "node:path";
import { readdir, stat } from "node:fs/promises";
import type { Stats } from "node:fs";

const MIME_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  xml: "application/xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  webp: "image/webp",
  avif: "image/avif",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  wasm: "application/wasm",
  pdf: "application/pdf",
};

const DEFAULT_INDEX = "index.html";
const OCTET_STREAM = "application/octet-stream";

export function mimeFor(path: string): string {
  return MIME_TYPES[extname(path).slice(1).toLowerCase()] ?? OCTET_STREAM;
}

function etagFor(file: { size: number; lastModified: number }): string {
  const hash = createHash("sha1");
  hash.update(String(file.size));
  hash.update(String(file.lastModified));
  return `"${hash.digest("hex").slice(0, 24)}"`;
}

// A satisfiable single range is [start, end]. "unsatisfiable" means the
// header is valid but outside the file (416). undefined means the header is
// not a supported single range (multi-range, malformed, reversed) and must
// be ignored entirely per RFC 9110.
function parseRange(header: string, size: number): [number, number] | "unsatisfiable" | undefined {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return undefined;
  const from = m[1]!;
  const to = m[2]!;
  let start: number;
  let end: number;
  if (from === "") {
    start = Math.max(size - parseInt(to, 10), 0);
    end = size - 1;
  } else {
    start = parseInt(from, 10);
    end = to === "" ? size - 1 : Math.min(parseInt(to, 10), size - 1);
  }
  if (start >= size) return "unsatisfiable";
  if (start > end) return undefined;
  return [start, end];
}

function notFound(): Response {
  return new Response("Not Found", { status: 404, statusText: "Not Found" });
}

function isNotModified(req: Request, file: { lastModified: number }, etag: string): boolean {
  const ifNoneMatch = req.headers.get("if-none-match");
  if (ifNoneMatch && ifNoneMatch.includes(etag)) return true;
  const ifModifiedSince = req.headers.get("if-modified-since");
  if (ifModifiedSince) {
    const since = Date.parse(ifModifiedSince);
    // HTTP-date has second granularity; truncate the file mtime to match.
    const lastModifiedSeconds = Math.floor(file.lastModified / 1000) * 1000;
    if (!Number.isNaN(since) && lastModifiedSeconds <= since) return true;
  }
  return false;
}

function baseHeaders(req: Request, file: { size: number; lastModified: number }, cacheControl?: string): Headers {
  const headers = new Headers({
    etag: etagFor(file),
    "accept-ranges": "bytes",
    "last-modified": new Date(file.lastModified).toUTCString(),
  });
  if (cacheControl) headers.set("cache-control", cacheControl);
  return headers;
}

async function sendFile(req: Request, fsPath: string, cacheControl?: string): Promise<Response> {
  const file = Bun.file(fsPath);
  const etag = etagFor(file);
  const headers = baseHeaders(req, file, cacheControl);

  if (isNotModified(req, file, etag)) {
    return new Response(null, { status: 304, statusText: "Not Modified", headers: { etag } });
  }

  const contentType = file.type || mimeFor(fsPath);
  const range = req.headers.get("range");
  if (range) {
    const parsed = parseRange(range, file.size);
    if (parsed === "unsatisfiable") {
      headers.set("content-range", `bytes */${file.size}`);
      return new Response(null, { status: 416, statusText: "Range Not Satisfiable", headers });
    }
    if (Array.isArray(parsed)) {
      const [start, end] = parsed;
      headers.set("content-type", contentType);
      headers.set("content-range", `bytes ${start}-${end}/${file.size}`);
      headers.set("content-length", String(end - start + 1));
      return new Response(file.slice(start, end + 1), {
        status: 206,
        statusText: "Partial Content",
        headers,
      });
    }
    // Not a supported range form: ignore the header and send the full body.
  }

  headers.set("content-type", contentType);
  return new Response(file, { headers });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function dirListing(dirPath: string, relative: string): Promise<Response> {
  const entries = (await readdir(dirPath, { withFileTypes: true })).sort(
    (a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name),
  );
  const baseHref = relative ? `/${relative.replace(/\\/g, "/")}` : "";
  const rows = entries
    .map((entry) => {
      const name = entry.name;
      const href = `${baseHref}/${encodeURIComponent(name)}`;
      const label = entry.isDirectory() ? `${name}/` : name;
      return `<li><a href="${href}">${escapeHtml(label)}</a></li>`;
    })
    .join("");
  const parent = relative ? `<li><a href="${baseHref.replace(/\/[^/]*$/, "") || "/"}">../</a></li>` : "";
  const title = `Index of ${escapeHtml(relative || "/")}`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><ul>${parent}${rows}</ul></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

// Reject any path segment that begins with a dot, so dotfiles are never served.
function hasDotSegment(relative: string): boolean {
  return relative.split("/").some((s) => s.startsWith(".") && s.length > 1);
}

async function statFile(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path);
  } catch {
    return undefined;
  }
}

export async function serveStatic(
  req: Request,
  staticPath: string,
  indexFile?: string,
  subpath = "",
  fallbackFile?: string,
  cacheControl?: string,
): Promise<Response> {
  const base = resolve(staticPath);
  const baseStat = await statFile(base);
  if (!baseStat) return notFound();

  if (!baseStat.isDirectory()) return sendFile(req, base, cacheControl);

  const relative = subpath.replace(/^\/+/, "");
  const candidate = resolve(base, relative);
  if (candidate !== base && !candidate.startsWith(base + sep)) return notFound();
  if (hasDotSegment(relative)) return notFound();

  const indexName = (indexFile?.split(sep).pop() ?? DEFAULT_INDEX)!;
  const indexFallback = async (): Promise<Response> => {
    const path = join(base, fallbackFile!);
    const s = await statFile(path);
    return s?.isFile() ? sendFile(req, path, cacheControl) : notFound();
  };

  const fileStat = await statFile(candidate);
  if (fileStat?.isDirectory()) {
    const indexPath = join(candidate, indexName);
    const idx = await statFile(indexPath);
    if (idx?.isFile()) return sendFile(req, indexPath, cacheControl);
    if (fallbackFile) return indexFallback();
    return dirListing(candidate, relative);
  }
  if (fileStat?.isFile()) return sendFile(req, candidate, cacheControl);
  if (fallbackFile) return indexFallback();
  return notFound();
}
