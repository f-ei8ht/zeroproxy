import { parseArgs } from "node:util";
import { resolve } from "node:path";

export type Upstream = string | { url: string; weight?: number };

export type Route = {
  pattern: string;
  method?: string;
  upstream?: Upstream[];
  static?: string;
  index?: string;
  fallback?: string;
  ws?: boolean;
  cacheControl?: string;
};

export type HealthCheckConfig = {
  intervalMs: number;
  timeoutMs: number;
  path: string;
};

export type Config = {
  port: number;
  host: string;
  compression: boolean;
  retryBodyLimitBytes: number;
  upstreamTimeoutMs: number;
  shutdownTimeoutMs: number;
  minCompressBytes: number;
  maxRequestBodyBytes: number;
  healthCheck: HealthCheckConfig;
  tls?: { cert: string; key: string };
  routes: Route[];
};

const isUrl = (v: string) => /^https?:\/\//.test(v);

function numberAtLeast(raw: unknown, fallback: number, min: number, name: string): number {
  const value = raw ?? fallback;
  if (typeof value !== "number" || value < min) {
    throw new Error(`${name} must be a number of at least ${min}`);
  }
  return value;
}

const DEFAULT_PORT = 8080;
const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_RETRY_BODY_LIMIT = 64 * 1024;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 30000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10000;
const DEFAULT_MIN_COMPRESS_BYTES = 256;
// 0 disables the cap; a declared body over the cap is rejected with 413.
const DEFAULT_MAX_REQUEST_BODY_BYTES = 0;
const DEFAULT_HEALTH: HealthCheckConfig = { intervalMs: 5000, timeoutMs: 2000, path: "/" };

function parseUpstream(raw: unknown, i: number): Upstream {
  if (typeof raw === "string" && isUrl(raw)) return raw;
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.url === "string" && isUrl(obj.url)) {
      const weight = obj.weight === undefined ? 1 : obj.weight;
      if (typeof weight !== "number" || weight < 1) {
        throw new Error(`route ${i} upstream weight must be a positive number`);
      }
      return { url: obj.url, weight };
    }
  }
  throw new Error(`route ${i} has an invalid upstream`);
}

function parseRoutes(raw: unknown): Route[] {
  if (!Array.isArray(raw)) throw new Error("routes must be an array");
  return raw.map((r, i) => {
    const route = r as Record<string, unknown>;
    if (typeof route.pattern !== "string") {
      throw new Error(`route ${i} is missing a string pattern`);
    }
    if (route.method !== undefined && typeof route.method !== "string") {
      throw new Error(`route ${i} method must be a string`);
    }
    if (route.upstream !== undefined) {
      const list = Array.isArray(route.upstream) ? route.upstream : [route.upstream];
      return {
        pattern: route.pattern,
        method: route.method as string,
        upstream: list.map((u) => parseUpstream(u, i)),
        ws: route.ws === true,
        cacheControl: route.cacheControl as string,
      };
    }
    if (route.static !== undefined) {
      if (typeof route.static !== "string") throw new Error(`route ${i} has an invalid static root`);
      if (route.index !== undefined && typeof route.index !== "string") {
        throw new Error(`route ${i} index must be a string`);
      }
      if (route.fallback !== undefined && typeof route.fallback !== "string") {
        throw new Error(`route ${i} fallback must be a string`);
      }
      if (route.cacheControl !== undefined && typeof route.cacheControl !== "string") {
        throw new Error(`route ${i} cacheControl must be a string`);
      }
      return {
        pattern: route.pattern,
        method: route.method as string,
        static: route.static,
        index: route.index as string,
        fallback: route.fallback as string,
        cacheControl: route.cacheControl as string,
      };
    }
    throw new Error(`route ${i} must set upstream or static`);
  });
}

function parseHealthCheck(raw: unknown): HealthCheckConfig {
  if (raw === undefined) return DEFAULT_HEALTH;
  const obj = raw as Record<string, unknown>;
  const intervalMs = obj.intervalMs ?? DEFAULT_HEALTH.intervalMs;
  const timeoutMs = obj.timeoutMs ?? DEFAULT_HEALTH.timeoutMs;
  const path = obj.path ?? DEFAULT_HEALTH.path;
  if (typeof intervalMs !== "number" || intervalMs < 1) throw new Error("healthCheck.intervalMs must be a positive number");
  if (typeof timeoutMs !== "number" || timeoutMs < 1) throw new Error("healthCheck.timeoutMs must be a positive number");
  if (typeof path !== "string" || !path.startsWith("/")) throw new Error("healthCheck.path must be a string starting with /");
  return { intervalMs, timeoutMs, path };
}

async function loadConfigFile(path: string): Promise<Config> {
  const file = Bun.file(path);
  if (!file.exists()) throw new Error(`config file not found: ${path}`);
  return validateConfig(JSON.parse(await file.text()));
}

export function validateConfig(raw: unknown): Config {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const port = obj.port ?? DEFAULT_PORT;
  if (typeof port !== "number" || port < 1 || port > 65535) {
    throw new Error("port must be an integer between 1 and 65535");
  }
  const host = obj.host ?? DEFAULT_HOST;
  if (typeof host !== "string") throw new Error("host must be a string");
  const compression = obj.compression ?? true;
  if (typeof compression !== "boolean") throw new Error("compression must be a boolean");
  const retryBodyLimitBytes = numberAtLeast(obj.retryBodyLimitBytes, DEFAULT_RETRY_BODY_LIMIT, 0, "retryBodyLimitBytes");
  const upstreamTimeoutMs = numberAtLeast(obj.upstreamTimeoutMs, DEFAULT_UPSTREAM_TIMEOUT_MS, 1, "upstreamTimeoutMs");
  const shutdownTimeoutMs = numberAtLeast(obj.shutdownTimeoutMs, DEFAULT_SHUTDOWN_TIMEOUT_MS, 1, "shutdownTimeoutMs");
  const minCompressBytes = numberAtLeast(obj.minCompressBytes, DEFAULT_MIN_COMPRESS_BYTES, 0, "minCompressBytes");
  const maxRequestBodyBytes = numberAtLeast(
    obj.maxRequestBodyBytes,
    DEFAULT_MAX_REQUEST_BODY_BYTES,
    0,
    "maxRequestBodyBytes",
  );
  let tls: Config["tls"];
  if (obj.tls !== undefined) {
    const t = obj.tls as Record<string, unknown>;
    if (typeof t.cert !== "string" || typeof t.key !== "string") {
      throw new Error("tls must be an object with cert and key paths");
    }
    tls = { cert: t.cert, key: t.key };
  }
  return {
    port,
    host,
    compression,
    retryBodyLimitBytes,
    upstreamTimeoutMs,
    shutdownTimeoutMs,
    minCompressBytes,
    maxRequestBodyBytes,
    healthCheck: parseHealthCheck(obj.healthCheck),
    tls,
    routes: parseRoutes(obj.routes ?? []),
  };
}

export type LoadedConfig = { config: Config; source?: string };

export async function loadConfig(args: string[]): Promise<LoadedConfig> {
  const { values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      port: { type: "string" },
      host: { type: "string" },
      upstream: { type: "string", multiple: true },
      config: { type: "string" },
      root: { type: "string" },
    },
  });

  const env = process.env;
  let config: Config;
  const source = values.config as string | undefined;
  if (source) {
    config = await loadConfigFile(source);
  } else {
    const upstream = values.upstream ?? [];
    config = {
      port: DEFAULT_PORT,
      host: DEFAULT_HOST,
      compression: true,
      retryBodyLimitBytes: DEFAULT_RETRY_BODY_LIMIT,
      upstreamTimeoutMs: DEFAULT_UPSTREAM_TIMEOUT_MS,
      shutdownTimeoutMs: DEFAULT_SHUTDOWN_TIMEOUT_MS,
      minCompressBytes: DEFAULT_MIN_COMPRESS_BYTES,
      maxRequestBodyBytes: DEFAULT_MAX_REQUEST_BODY_BYTES,
      healthCheck: DEFAULT_HEALTH,
      routes: upstream.length > 0 ? [{ pattern: "/*", upstream }] : [],
    };
  }

  const root = values.root ? resolve(values.root) : process.cwd();
  config.routes = config.routes.map((route) =>
    route.static ? { ...route, static: resolve(root, route.static) } : route,
  );

  if (values.port) {
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`invalid --port: ${values.port} (expected an integer between 1 and 65535)`);
    }
    config.port = port;
  } else if (env.ZEROPROXY_PORT) {
    const port = Number(env.ZEROPROXY_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`invalid ZEROPROXY_PORT: ${env.ZEROPROXY_PORT}`);
    }
    config.port = port;
  }
  if (values.host) config.host = values.host;
  else if (env.ZEROPROXY_HOST) config.host = env.ZEROPROXY_HOST;
  if (values.upstream && values.upstream.length > 0) {
    config.routes = config.routes.filter((r) => !(r.pattern === "/*" && r.upstream));
    config.routes.push({ pattern: "/*", upstream: values.upstream });
  }
  return { config, source };
}
