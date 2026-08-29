import type { ServerWebSocket } from "bun";

export type WsData = { target: string; buffer: (string | ArrayBuffer)[]; upstream?: WebSocket };
export type WsClient = ServerWebSocket<WsData>;

export function isWebSocketRequest(req: Request): boolean {
  return (req.headers.get("upgrade") ?? "").toLowerCase() === "websocket";
}

// The upstream socket targets upstream[0] only; failover does not apply to
// live sockets. The path comes from the client request, not the upstream URL,
// mirroring the HTTP proxy which also ignores any upstream path prefix.
export function upstreamSocketUrl(target: string, req: Request): string {
  const url = new URL(req.url);
  const upstream = new URL(target);
  const proto = upstream.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${upstream.host}${url.pathname}${url.search}`;
}

export function toSendable(data: string | Buffer): string | ArrayBuffer {
  if (typeof data === "string") return data;
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy.buffer as ArrayBuffer;
}
