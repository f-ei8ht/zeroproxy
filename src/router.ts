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

// Methods of method-restricted routes whose pattern matches the path. Used
// to answer a mismatched request with 405 Allow; methodless routes match
// every method, so they never reach the 405 path.
export function allowedMethods(compiled: CompiledRoute[], pathname: string): string[] {
  const methods = new Set<string>();
  for (const { route, pattern } of compiled) {
    if (!pattern.exec({ pathname })) continue;
    if (route.method) methods.add(route.method.toUpperCase());
  }
  return [...methods];
}
