import { describe, expect, it } from "vitest";
import { parseAppRoute, routeForDestination, serializeAppRoute, type AppRoute } from "./router.js";

const roundTrip = (path: string) => serializeAppRoute(parseAppRoute(path)!);

describe("app route model", () => {
  it.each([
    "/workspaces", "/portfolio", "/projects", "/tasks", "/board", "/people", "/calendars", "/settings", "/workload", "/gantt", "/changes", "/history",
    "/projects/P-26-ALPHA", "/projects/P-26-ALPHA/tasks", "/projects/P-26-ALPHA/tasks/T-26-FIRST", "/history/abcdef123456",
  ])("round-trips %s", (path) => expect(roundTrip(path)).toBe(path));

  it("encodes entity identifiers and restores repeated query filters deterministically", () => {
    const value: AppRoute = { name: "tasks", projectId: "P alpha/one", taskId: "T #1", query: { status: ["in progress", "done"], type: ["bug"] } };
    const serialized = serializeAppRoute(value);
    expect(serialized).toBe("/projects/P%20alpha%2Fone/tasks/T%20%231?status=in+progress&status=done&type=bug");
    expect(parseAppRoute(serialized)).toEqual(value);
  });

  it("maps contextual workspace destinations to canonical routes", () => {
    expect(serializeAppRoute(routeForDestination("projects", { projectId: "P-1" }))).toBe("/projects/P-1");
    expect(serializeAppRoute(routeForDestination("tasks", { projectId: "P-1", taskId: "T-1" }))).toBe("/projects/P-1/tasks/T-1");
    expect(serializeAppRoute(routeForDestination("tasks", { projectId: "P-1", query: { status: ["in-progress"] } }))).toBe("/projects/P-1/tasks?status=in-progress");
    expect(serializeAppRoute(routeForDestination("board", { projectId: "P-1" }))).toBe("/board?project=P-1");
    expect(serializeAppRoute(routeForDestination("history", { commit: "abcdef" }))).toBe("/history/abcdef");
    expect(serializeAppRoute(routeForDestination("calendar"))).toBe("/calendars");
  });

  it("rejects unknown, incomplete and malformed routes", () => {
    expect(parseAppRoute("/")).toBeNull();
    expect(parseAppRoute("/projects/P-1/unknown")).toBeNull();
    expect(parseAppRoute("/projects/%E0%A4%A")).toBeNull();
  });
});
