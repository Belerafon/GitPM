import { describe, expect, it } from "vitest";
import { initialNavigationTrail, restoreNavigationTrail, truncateNavigationTrail, visitNavigationTrail } from "./navigation-trail.js";
import type { AppRoute } from "./router.js";

const project = (id = "P-26-ALPHA"): AppRoute => ({ name: "projects", projectId: id, query: {} });
const task = (id = "T-26-TASK01"): AppRoute => ({ name: "tasks", projectId: "P-26-ALPHA", taskId: id, query: {} });
const person = (id = "U-26-ADA"): AppRoute => ({ name: "people", personId: id, query: {} });

describe("linked-entity navigation trail", () => {
  it("starts a deep task link with its project and keeps cross-entity visits in click order", () => {
    const initial = initialNavigationTrail(task())!;
    expect(initial.entries.map((entry) => entry.name)).toEqual(["projects", "tasks"]);

    const visitedPerson = visitNavigationTrail(initial, person())!;
    const visitedAnotherTask = visitNavigationTrail(visitedPerson, task("T-26-TASK02"))!;
    expect(visitedAnotherTask.entries.map((entry) => entry.taskId ?? entry.personId ?? entry.projectId)).toEqual([
      "P-26-ALPHA", "T-26-TASK01", "U-26-ADA", "T-26-TASK02",
    ]);
  });

  it("does not duplicate an entity when only its surface or query changes", () => {
    const initial = initialNavigationTrail(project())!;
    const board = visitNavigationTrail(initial, { name: "board", projectId: "P-26-ALPHA", query: { status: ["open"] } })!;
    expect(board.entries).toHaveLength(1);
    expect(board.entries[0]?.name).toBe("board");
  });

  it("truncates the trail for an explicit crumb or browser-back navigation", () => {
    const full = visitNavigationTrail(visitNavigationTrail(initialNavigationTrail(task())!, person())!, task("T-26-TASK02"))!;
    expect(truncateNavigationTrail(full, 1).entries).toHaveLength(2);
    expect(restoreNavigationTrail(full, person())?.entries.map((entry) => entry.taskId ?? entry.personId ?? entry.projectId)).toEqual([
      "P-26-ALPHA", "T-26-TASK01", "U-26-ADA",
    ]);
  });

  it("clears entity history when navigating to a non-entity workspace", () => {
    expect(visitNavigationTrail(initialNavigationTrail(person()), { name: "workload", query: {} })).toBeNull();
  });
});
