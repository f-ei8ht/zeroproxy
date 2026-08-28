import type { Route } from "./config";

export type Match = { route: Route; params: Record<string, string | undefined> };

export type CompiledRoute = { route: Route; pattern: URLPattern };

export function compileRoutes(routes: Route[]): CompiledRoute[] {
  return routes.map((route) => ({
    route,
    pattern: new URLPattern({ pathname: route.pattern }),
  }));
}

export function matchRoute(
  compiled: CompiledRoute[],
  method: string,
  pathname: string,
): Match | undefined {
  for (const { route, pattern } of compiled) {
    if (route.method && route.method.toUpperCase() !== method.toUpperCase()) continue;
    const result = pattern.exec({ pathname });
    if (result) return { route, params: result.pathname.groups };
  }
  return undefined;
}
