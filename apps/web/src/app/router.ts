import type { WorkspaceDestination, WorkspaceSelection } from "../workspace-navigation.js";

export type AppRouteName = "workspaces" | "portfolio" | "projects" | "stages" | "tasks" | "board" | "people" | "calendars" | "settings" | "workload" | "gantt" | "changes" | "history";
export type RouteQuery = Readonly<Record<string, readonly string[]>>;

export interface AppRoute {
  readonly name: AppRouteName;
  readonly projectId?: string;
  readonly stageId?: string;
  readonly taskId?: string;
  readonly commit?: string;
  readonly query: RouteQuery;
}

const emptyQuery: RouteQuery = Object.freeze({});
const route = (name: AppRouteName, values: Omit<AppRoute, "name" | "query"> = {}, query: RouteQuery = emptyQuery): AppRoute => ({ name, ...values, query });
const decodeSegment = (value: string): string | null => {
  try { return decodeURIComponent(value); } catch { return null; }
};

function readQuery(searchParams: URLSearchParams, omitted: ReadonlySet<string> = new Set()): RouteQuery {
  const result: Record<string, string[]> = {};
  searchParams.forEach((value, key) => {
    if (omitted.has(key)) return;
    (result[key] ??= []).push(value);
  });
  return result;
}

export function parseAppRoute(input: string | URL): AppRoute | null {
  const url = input instanceof URL ? input : new URL(input, "http://gitpm.local");
  const rawSegments = url.pathname.split("/").filter(Boolean);
  const segments: string[] = [];
  for (const segment of rawSegments) {
    const decoded = decodeSegment(segment);
    if (decoded === null || decoded === "") return null;
    segments.push(decoded);
  }
  const query = readQuery(url.searchParams);
  if (segments.length === 1) {
    if (segments[0] === "tasks") return route("projects");
    const staticRoutes: Readonly<Record<string, AppRouteName>> = {
      workspaces: "workspaces", portfolio: "portfolio", projects: "projects", board: "board", people: "people",
      calendars: "calendars", settings: "settings", workload: "workload", gantt: "gantt", changes: "changes", history: "history",
    };
    const name = staticRoutes[segments[0]!];
    if (name === undefined) return null;
    if (name === "board" || name === "gantt") {
      const projectId = url.searchParams.get("project") || undefined;
      return route(name, { projectId }, readQuery(url.searchParams, new Set(["project"])));
    }
    return route(name, {}, query);
  }
  if (segments[0] === "projects" && segments.length === 2) return route("projects", { projectId: segments[1] }, query);
  if (segments[0] === "projects" && segments[2] === "stages" && segments.length === 3) return route("projects", { projectId: segments[1] }, query);
  if (segments[0] === "projects" && segments[2] === "stages" && segments.length === 4) return route("stages", { projectId: segments[1], stageId: segments[3] }, query);
  if (segments[0] === "projects" && segments[2] === "tasks" && segments.length === 3) return route("tasks", { projectId: segments[1] }, query);
  if (segments[0] === "projects" && segments[2] === "tasks" && segments.length === 4) return route("tasks", { projectId: segments[1], taskId: segments[3] }, query);
  if (segments[0] === "projects" && segments[2] === "board" && segments.length === 3) return route("board", { projectId: segments[1] }, query);
  if (segments[0] === "projects" && segments[2] === "timeline" && segments.length === 3) return route("gantt", { projectId: segments[1] }, query);
  if (segments[0] === "history" && segments.length === 2) return route("history", { commit: segments[1] }, query);
  return null;
}

export function serializeAppRoute(value: AppRoute): string {
  const segment = (item: string) => encodeURIComponent(item);
  let pathname: string;
  switch (value.name) {
    case "workspaces": pathname = "/workspaces"; break;
    case "portfolio": pathname = "/portfolio"; break;
    case "projects": pathname = value.projectId === undefined ? "/projects" : `/projects/${segment(value.projectId)}`; break;
    case "stages": pathname = value.projectId === undefined ? "/projects" : value.stageId === undefined ? `/projects/${segment(value.projectId)}` : `/projects/${segment(value.projectId)}/stages/${segment(value.stageId)}`; break;
    case "tasks": pathname = value.projectId === undefined ? "/projects" : value.taskId === undefined ? `/projects/${segment(value.projectId)}/tasks` : `/projects/${segment(value.projectId)}/tasks/${segment(value.taskId)}`; break;
    case "board": pathname = value.projectId === undefined ? "/board" : `/projects/${segment(value.projectId)}/board`; break;
    case "people": pathname = "/people"; break;
    case "calendars": pathname = "/calendars"; break;
    case "settings": pathname = "/settings"; break;
    case "workload": pathname = "/workload"; break;
    case "gantt": pathname = value.projectId === undefined ? "/gantt" : `/projects/${segment(value.projectId)}/timeline`; break;
    case "changes": pathname = "/changes"; break;
    case "history": pathname = value.commit === undefined ? "/history" : `/history/${segment(value.commit)}`; break;
  }
  const search = new URLSearchParams();
  for (const key of Object.keys(value.query).sort()) for (const item of value.query[key] ?? []) search.append(key, item);
  const serialized = search.toString();
  return serialized === "" ? pathname : `${pathname}?${serialized}`;
}

export function routeForDestination(destination: WorkspaceDestination | "workspaces", selection: WorkspaceSelection = {}, query: RouteQuery = emptyQuery): AppRoute {
  const routeQuery = selection.query ?? query;
  if (destination === "workspaces") return route("workspaces", {}, routeQuery);
  if (destination === "calendar") return route("calendars", {}, routeQuery);
  if (destination === "projects") return route("projects", { projectId: selection.projectId }, routeQuery);
  if (destination === "stages") return selection.stageId === undefined
    ? route("projects", { projectId: selection.projectId }, routeQuery)
    : route("stages", { projectId: selection.projectId, stageId: selection.stageId }, routeQuery);
  if (destination === "tasks") return selection.projectId === undefined
    ? route("projects", {}, routeQuery)
    : route("tasks", { projectId: selection.projectId, taskId: selection.taskId }, routeQuery);
  if (destination === "board" || destination === "gantt") return route(destination, { projectId: selection.projectId }, routeQuery);
  if (destination === "history") return route("history", { commit: selection.commit }, routeQuery);
  return route(destination, {}, routeQuery);
}
