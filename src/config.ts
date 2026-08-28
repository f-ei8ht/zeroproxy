import { parseArgs } from "node:util";
import { resolve } from "node:path";

export type Route = {
  pattern: string;
  method?: string;
  upstream?: string | string[];
  static?: string;
  index?: string;
};

export type Config = {
  port: number;
  host: string;
  compression: boolean;
  routes: Route[];
};

const isUrl = (v: string) => /^https?:\/\//.test(v);
const DEFAULT_PORT = 8080;
const DEFAULT_HOST = "0.0.0.0";

function parseRoutes(raw: unknown): Route[] {
  if (!Array.isArray(raw)) throw new Error("routes must be an array");
  return raw.map((r, i) => {
    const route = r as Record<string, unknown>;
    if (typeof route.pattern !== "string") {
      throw new Error(`route ${i} is missing a string pattern`);
    }
    if (route.upstream !== undefined) {
      const list = Array.isArray(route.upstream) ? route.upstream : [route.upstream];
      if (!list.every((u) => typeof u === "string" && isUrl(u))) {
        throw new Error(`route ${i} has an invalid upstream`);
      }
      return { pattern: route.pattern, method: route.method as string, upstream: list as string[] };
    }
    if (route.static !== undefined) {
      if (typeof route.static !== "string") throw new Error(`route ${i} has an invalid static root`);
      return { pattern: route.pattern, method: route.method as string, static: route.static, index: route.index as string };
    }
    throw new Error(`route ${i} must set upstream or static`);
  });
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
  return { port, host, compression, routes: parseRoutes(obj.routes ?? []) };
}

export async function loadConfig(args: string[]): Promise<Config> {
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

  let config: Config;
  if (values.config) {
    config = await loadConfigFile(values.config);
  } else {
    const upstream = values.upstream ?? [];
    config = {
      port: DEFAULT_PORT,
      host: DEFAULT_HOST,
      compression: true,
      routes: upstream.length > 0 ? [{ pattern: "/*", upstream }] : [],
    };
  }

  const root = values.root ? resolve(values.root) : process.cwd();
  config.routes = config.routes.map((route) =>
    route.static ? { ...route, static: resolve(root, route.static) } : route,
  );

  if (values.port) config.port = parseInt(values.port, 10);
  if (values.host) config.host = values.host;
  if (values.upstream && values.upstream.length > 0) {
    config.routes = [{ pattern: "/*", upstream: values.upstream }];
  }
  return config;
}
