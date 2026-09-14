import { entityIdFromSegment, entityUrlSegment } from "@gitpm/shared";
import type { WorkspaceDestination, WorkspaceSelection } from "../workspace-navigation.js";

export type AppRouteName = "workspaces" | "projects" | "stages" | "tasks" | "board" | "effort" | "people" | "calendars" | "settings" | "workload" | "vacations" | "gantt" | "changes" | "files" | "history" | "connection";
export type RouteQuery = Readonly<Record<string, readonly string[]>>;

export interface AppRoute {
  readonly name: AppRouteName;
  readonly projectId?: string;
  readonly stageId?: string;
  readonly taskId?: string;
  readonly personId?: string;
  readonly calendarId?: string;
  readonly commit?: string;
  readonly query: RouteQuery;
}

export interface RouteEntityLabels {
  readonly project?: string;
  readonly stage?: string;
  readonly task?: string;
  readonly person?: string;
  readonly calendar?: string;
}

export function routeEntityCatalogKey(route: AppRoute | null): string {
  if (route === null) return "";
  return [route.projectId ?? "", route.stageId ?? "", route.taskId ?? "", route.personId ?? "", route.calendarId ?? ""].join("\0");
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
    if (segments[0] === "portfolio") return route("projects");
    const staticRoutes: Readonly<Record<string, AppRouteName>> = {
      workspaces: "workspaces", projects: "projects", tasks: "tasks", board: "board", people: "people",
      calendars: "calendars", settings: "settings", workload: "workload", vacations: "vacations", gantt: "gantt", changes: "changes", files: "files", history: "history", connection: "connection",
    };
    const name = staticRoutes[segments[0]!];
    if (name === undefined) return null;
    if (name === "board" || name === "gantt") {
      const projectId = url.searchParams.get("project") || undefined;
      return route(name, { projectId }, readQuery(url.searchParams, new Set(["project"])));
    }
    return route(name, {}, query);
  }
  if (segments[0] === "projects" && segments.length === 2) return route("projects", { projectId: entityIdFromSegment(segments[1]!) }, query);
  if (segments[0] === "projects" && segments[2] === "stages" && segments.length === 3) return route("projects", { projectId: entityIdFromSegment(segments[1]!) }, query);
  if (segments[0] === "projects" && segments[2] === "stages" && segments.length === 4) return route("stages", { projectId: entityIdFromSegment(segments[1]!), stageId: entityIdFromSegment(segments[3]!) }, query);
  if (segments[0] === "projects" && segments[2] === "tasks" && segments.length === 3) return route("projects", { projectId: entityIdFromSegment(segments[1]!) }, query);
  if (segments[0] === "projects" && segments[2] === "tasks" && segments.length === 4) return route("tasks", { projectId: entityIdFromSegment(segments[1]!), taskId: entityIdFromSegment(segments[3]!) }, query);
  if (segments[0] === "projects" && segments[2] === "board" && segments.length === 3) return route("board", { projectId: entityIdFromSegment(segments[1]!) }, query);
  if (segments[0] === "projects" && segments[2] === "effort" && segments.length === 3) return route("effort", { projectId: entityIdFromSegment(segments[1]!) }, query);
  if (segments[0] === "projects" && segments[2] === "timeline" && segments.length === 3) return route("gantt", { projectId: entityIdFromSegment(segments[1]!) }, query);
  if (segments[0] === "people" && segments.length === 2) return route("people", { personId: entityIdFromSegment(segments[1]!) }, query);
  if (segments[0] === "calendars" && segments.length === 2) return route("calendars", { calendarId: entityIdFromSegment(segments[1]!) }, query);
  if (segments[0] === "history" && segments.length === 2) return route("history", { commit: segments[1] }, query);
  return null;
}

export function serializeAppRoute(value: AppRoute, labels: RouteEntityLabels = {}): string {
  const segment = (id: string, label?: string) => encodeURIComponent(entityUrlSegment(id, label));
  const project = value.projectId === undefined ? undefined : segment(value.projectId, labels.project);
  let pathname: string;
  switch (value.name) {
    case "workspaces": pathname = "/workspaces"; break;
    case "projects": pathname = project === undefined ? "/projects" : `/projects/${project}`; break;
    case "stages": pathname = project === undefined ? "/projects" : value.stageId === undefined ? `/projects/${project}` : `/projects/${project}/stages/${segment(value.stageId, labels.stage)}`; break;
    case "tasks": pathname = project === undefined ? "/tasks" : value.taskId === undefined ? `/projects/${project}` : `/projects/${project}/tasks/${segment(value.taskId, labels.task)}`; break;
    case "board": pathname = project === undefined ? "/board" : `/projects/${project}/board`; break;
    case "effort": pathname = project === undefined ? "/projects" : `/projects/${project}/effort`; break;
    case "people": pathname = value.personId === undefined ? "/people" : `/people/${segment(value.personId, labels.person)}`; break;
    case "calendars": pathname = value.calendarId === undefined ? "/calendars" : `/calendars/${segment(value.calendarId, labels.calendar)}`; break;
    case "settings": pathname = "/settings"; break;
    case "workload": pathname = "/workload"; break;
    case "vacations": pathname = "/vacations"; break;
    case "gantt": pathname = project === undefined ? "/gantt" : `/projects/${project}/timeline`; break;
    case "changes": pathname = "/changes"; break;
    case "files": pathname = "/files"; break;
    case "connection": pathname = "/connection"; break;
    case "history": pathname = value.commit === undefined ? "/history" : `/history/${encodeURIComponent(value.commit)}`; break;
  }
  const search = new URLSearchParams();
  for (const key of Object.keys(value.query).sort()) for (const item of value.query[key] ?? []) search.append(key, item);
  const serialized = search.toString();
  return serialized === "" ? pathname : `${pathname}?${serialized}`;
}

export function routeForDestination(destination: WorkspaceDestination | "workspaces", selection: WorkspaceSelection = {}, query: RouteQuery = emptyQuery): AppRoute {
  const routeQuery = selection.query ?? query;
  if (destination === "workspaces") return route("workspaces", {}, routeQuery);
  if (destination === "calendar") return route("calendars", { calendarId: selection.calendarId }, routeQuery);
  if (destination === "people") return route("people", { personId: selection.personId }, routeQuery);
  if (destination === "projects") return route("projects", { projectId: selection.projectId }, routeQuery);
  if (destination === "stages") return selection.stageId === undefined
    ? route("projects", { projectId: selection.projectId }, routeQuery)
    : route("stages", { projectId: selection.projectId, stageId: selection.stageId }, routeQuery);
  if (destination === "tasks") return selection.projectId === undefined
    ? route("tasks", {}, routeQuery)
    : selection.taskId === undefined
      ? route("projects", { projectId: selection.projectId }, routeQuery)
      : route("tasks", { projectId: selection.projectId, taskId: selection.taskId }, routeQuery);
  if (destination === "board" || destination === "gantt") return route(destination, { projectId: selection.projectId }, routeQuery);
  if (destination === "effort") return selection.projectId === undefined
    ? route("projects", {}, routeQuery)
    : route("effort", { projectId: selection.projectId }, routeQuery);
  if (destination === "history") return route("history", { commit: selection.commit }, routeQuery);
  return route(destination, {}, routeQuery);
}
