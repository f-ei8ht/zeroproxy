import { parseArgs } from "node:util";
import { resolve } from "node:path";

export type Route = {
  pattern: string;
  method?: string;
  upstream?: string[];
  static?: string;
  index?: string;
  fallback?: string;
  ws?: boolean;
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
      return {
        pattern: route.pattern,
        method: route.method as string,
        upstream: list as string[],
        ws: route.ws === true,
      };
    }
    if (route.static !== undefined) {
      if (typeof route.static !== "string") throw new Error(`route ${i} has an invalid static root`);
      return {
        pattern: route.pattern,
        method: route.method as string,
        static: route.static,
        index: route.index as string,
        fallback: route.fallback as string,
      };
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
  }
  if (values.host) config.host = values.host;
  if (values.upstream && values.upstream.length > 0) {
    config.routes = config.routes.filter((r) => !(r.pattern === "/*" && r.upstream));
    config.routes.push({ pattern: "/*", upstream: values.upstream });
  }
  return { config, source };
}
