import { createHash } from "node:crypto";
import { extname, join, resolve, sep } from "node:path";
import { readdirSync, statSync } from "node:fs";

const MIME_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  webp: "image/webp",
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

function parseRange(header: string, size: number): [number, number] | undefined {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return undefined;
  const from = m[1]!;
  const to = m[2]!;
  let start: number;
  let end: number;
  if (from === "") {
    const suffix = to === "" ? size : parseInt(to, 10);
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = parseInt(from, 10);
    end = to === "" ? size - 1 : Math.min(parseInt(to, 10), size - 1);
  }
  if (start > end || start >= size) return undefined;
  return [start, end];
}

function notFound(): Response {
  return new Response("Not Found", { status: 404, statusText: "Not Found" });
}

function sendFile(req: Request, fsPath: string): Response {
  const file = Bun.file(fsPath);
  const etag = etagFor(file);
  const ifNoneMatch = req.headers.get("if-none-match");
  if (ifNoneMatch && ifNoneMatch.includes(etag)) {
    return new Response(null, { status: 304, statusText: "Not Modified", headers: { etag } });
  }
  const contentType = file.type || mimeFor(fsPath);
  const range = req.headers.get("range");
  if (range) {
    const parsed = parseRange(range, file.size);
    if (parsed) {
      const [start, end] = parsed;
      return new Response(file.slice(start, end + 1), {
        status: 206,
        statusText: "Partial Content",
        headers: {
          "content-type": contentType,
          "content-range": `bytes ${start}-${end}/${file.size}`,
          "content-length": String(end - start + 1),
          etag,
          "accept-ranges": "bytes",
        },
      });
    }
    return new Response(null, {
      status: 416,
      statusText: "Range Not Satisfiable",
      headers: { "content-range": `bytes */${file.size}` },
    });
  }
  return new Response(file, {
    headers: { "content-type": contentType, etag, "accept-ranges": "bytes" },
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function dirListing(dirPath: string, relative: string): Response {
  const entries = readdirSync(dirPath, { withFileTypes: true }).sort(
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
  const title = `Index of ${escapeHtml(relative || "/")}`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><ul>${rows}</ul></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

export function serveStatic(
  req: Request,
  staticPath: string,
  indexFile?: string,
  subpath = "",
  fallbackFile?: string,
): Response {
  const base = resolve(staticPath);
  const baseStat = statSync(base, { throwIfNoEntry: false });
  if (!baseStat) return notFound();

  if (!baseStat.isDirectory()) return sendFile(req, base);

  const relative = subpath.replace(/^\/+/, "");
  const candidate = resolve(base, relative);
  if (candidate !== base && !candidate.startsWith(base + sep)) return notFound();

  const indexName = (indexFile?.split(sep).pop() ?? DEFAULT_INDEX)!;
  const indexFallback = () => {
    const path = join(base, fallbackFile!);
    return statSync(path, { throwIfNoEntry: false })?.isFile() ? sendFile(req, path) : notFound();
  };

  const stat = statSync(candidate, { throwIfNoEntry: false });
  if (stat?.isDirectory()) {
    const indexPath = join(candidate, indexName);
    if (statSync(indexPath, { throwIfNoEntry: false })?.isFile()) return sendFile(req, indexPath);
    if (fallbackFile) return indexFallback();
    return dirListing(candidate, relative);
  }
  if (stat?.isFile()) return sendFile(req, candidate);
  if (fallbackFile) return indexFallback();
  return notFound();
}
