import type { AppRoute } from "./router.js";

export type NavigationTrailRoot = "projects" | "people";

export interface NavigationTrail {
  readonly root: NavigationTrailRoot;
  readonly entries: readonly AppRoute[];
}

export function entityRouteKey(route: AppRoute | null): string | null {
  if (route?.personId !== undefined) return `person:${route.personId}`;
  if (route?.taskId !== undefined) return `task:${route.taskId}`;
  if (route?.stageId !== undefined) return `stage:${route.stageId}`;
  if (route?.projectId !== undefined) return `project:${route.projectId}`;
  return null;
}

export function initialNavigationTrail(route: AppRoute | null): NavigationTrail | null {
  if (route?.personId !== undefined) return { root: "people", entries: [route] };
  if (route?.projectId === undefined) return null;
  const projectRoute: AppRoute = { name: "projects", projectId: route.projectId, query: {} };
  if (route.taskId !== undefined || route.stageId !== undefined) return { root: "projects", entries: [projectRoute, route] };
  return { root: "projects", entries: [route] };
}

export function visitNavigationTrail(current: NavigationTrail | null, route: AppRoute | null): NavigationTrail | null {
  const key = entityRouteKey(route);
  if (key === null || route === null) return initialNavigationTrail(route);
  if (current === null || current.entries.length === 0) return initialNavigationTrail(route);
  const last = current.entries.at(-1)!;
  if (entityRouteKey(last) === key) return { ...current, entries: [...current.entries.slice(0, -1), route] };
  return { ...current, entries: [...current.entries, route].slice(-8) };
}

export function restoreNavigationTrail(current: NavigationTrail | null, route: AppRoute | null): NavigationTrail | null {
  const key = entityRouteKey(route);
  if (key === null || route === null || current === null) return initialNavigationTrail(route);
  let index = -1;
  for (let candidate = current.entries.length - 1; candidate >= 0; candidate--) {
    if (entityRouteKey(current.entries[candidate]!) === key) { index = candidate; break; }
  }
  if (index < 0) return visitNavigationTrail(current, route);
  return { ...current, entries: [...current.entries.slice(0, index), route] };
}

export function truncateNavigationTrail(current: NavigationTrail, index: number): NavigationTrail {
  return { ...current, entries: current.entries.slice(0, index + 1) };
}
