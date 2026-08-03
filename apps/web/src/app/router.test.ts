import { describe, expect, it } from "vitest";
import { parseAppRoute, routeForDestination, serializeAppRoute, type AppRoute } from "./router.js";

const roundTrip = (path: string) => serializeAppRoute(parseAppRoute(path)!);

describe("app route model", () => {
  it.each([
    "/workspaces", "/projects", "/board", "/people", "/calendars", "/settings", "/workload", "/gantt", "/changes", "/files", "/history",
    "/projects/P-26-ALPHA", "/projects/P-26-ALPHA/stages/M-26-FIRST", "/projects/P-26-ALPHA/tasks/T-26-FIRST", "/projects/P-26-ALPHA/board", "/projects/P-26-ALPHA/timeline", "/projects/P-26-ALPHA/effort", "/people/U-26-ADA", "/history/abcdef123456",
  ])("round-trips %s", (path) => expect(roundTrip(path)).toBe(path));

  it("encodes entity identifiers and restores repeated query filters deterministically", () => {
    const value: AppRoute = { name: "tasks", projectId: "P alpha/one", taskId: "T #1", query: { status: ["in progress", "done"], type: ["bug"] } };
    const serialized = serializeAppRoute(value);
    expect(serialized).toBe("/projects/P%20alpha%2Fone/tasks/T%20%231?status=in+progress&status=done&type=bug");
    expect(parseAppRoute(serialized)).toEqual(value);
  });

  it("maps contextual workspace destinations to canonical routes", () => {
    expect(serializeAppRoute(routeForDestination("projects", { projectId: "P-1" }))).toBe("/projects/P-1");
    expect(serializeAppRoute(routeForDestination("stages", { projectId: "P-1", stageId: "M-1" }))).toBe("/projects/P-1/stages/M-1");
    expect(serializeAppRoute(routeForDestination("tasks", { projectId: "P-1", taskId: "T-1" }))).toBe("/projects/P-1/tasks/T-1");
    expect(serializeAppRoute(routeForDestination("tasks", { projectId: "P-1", query: { status: ["in-progress"] } }))).toBe("/projects/P-1?status=in-progress");
    expect(serializeAppRoute(routeForDestination("board", { projectId: "P-1" }))).toBe("/projects/P-1/board");
    expect(serializeAppRoute(routeForDestination("gantt", { projectId: "P-1" }))).toBe("/projects/P-1/timeline");
    expect(serializeAppRoute(routeForDestination("effort", { projectId: "P-1" }))).toBe("/projects/P-1/effort");
    expect(serializeAppRoute(routeForDestination("history", { commit: "abcdef" }))).toBe("/history/abcdef");
    expect(serializeAppRoute(routeForDestination("calendar"))).toBe("/calendars");
    expect(serializeAppRoute(routeForDestination("people", { personId: "U-1" }))).toBe("/people/U-1");
  });

  it("canonicalizes legacy project routes into the project workspace", () => {
    expect(roundTrip("/board?project=P-1&status=backlog")).toBe("/projects/P-1/board?status=backlog");
    expect(roundTrip("/gantt?project=P-1")).toBe("/projects/P-1/timeline");
    expect(roundTrip("/projects/P-1/stages")).toBe("/projects/P-1");
    expect(roundTrip("/projects/P-1/tasks?status=backlog")).toBe("/projects/P-1?status=backlog");
    expect(roundTrip("/portfolio")).toBe("/projects");
  });

  it("redirects the removed global task route to the project directory", () => {
    expect(roundTrip("/tasks")).toBe("/projects");
    expect(roundTrip("/tasks?status=backlog")).toBe("/projects");
    expect(serializeAppRoute(routeForDestination("tasks"))).toBe("/projects");
  });

  it("parses and serializes the project effort route", () => {
    const parsed = parseAppRoute("/projects/P-1/effort");
    expect(parsed).toEqual({ name: "effort", projectId: "P-1", query: {} });
    expect(serializeAppRoute(parsed!)).toBe("/projects/P-1/effort");
  });

  it("never serializes a bare effort route without a project", () => {
    // Effort is project-scoped: without a project it must fall back to the project
    // directory instead of producing an unparseable /effort route.
    expect(serializeAppRoute(routeForDestination("effort"))).toBe("/projects");
  });

  it("rejects unknown, incomplete and malformed routes", () => {
    expect(parseAppRoute("/")).toBeNull();
    expect(parseAppRoute("/projects/P-1/unknown")).toBeNull();
    expect(parseAppRoute("/projects/%E0%A4%A")).toBeNull();
  });
});
