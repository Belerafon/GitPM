import { describe, expect, it } from "vitest";
import type { SchedulingReadModel, TrackWindowSummary } from "@gitpm/scheduling";
import type { EntityResult } from "../../types.js";
import {
  buildTaskRelations,
  resolveEffortScope,
  resolveTaskPlanEffort,
  roundHours,
  scopeRootIdsOf,
  selectScopedRecords,
  sumBranchActualWithinScope,
  sumScopePlan,
} from "./project-effort-model.js";
import type { TimeEntryRecord } from "@gitpm/time-entries";

const task = (id: string, parent?: string, milestone?: string): EntityResult =>
  ({ document: { schema: "gitpm/task@2", id, project: "P", title: id, type: "task", status: "backlog", lifecycle: "active", ...(parent === undefined ? {} : { parent }), ...(milestone === undefined ? {} : { milestone }) }, path: `${id}.yaml`, blob_id: "a", draft_fingerprint: "f" });

const tw = (track: string, declared?: number, rolled?: number): TrackWindowSummary => ({
  track,
  declared: declared === undefined ? undefined : { effort_hours: declared },
  rolled: rolled === undefined ? undefined : { effort_hours: rolled },
  effective: undefined,
});

const readModel = (id: string, track: string, declared?: number, rolled?: number): SchedulingReadModel =>
  ({ id, tracks: [tw(track, declared, rolled)], overflowWarnings: [] });

const readModels = (entries: readonly { readonly id: string; readonly declared?: number; readonly rolled?: number }[], track: string): ReadonlyMap<string, SchedulingReadModel> => {
  const map = new Map<string, SchedulingReadModel>();
  for (const entry of entries) map.set(entry.id, readModel(entry.id, track, entry.declared, entry.rolled));
  return map;
};

const entry = (id: string, t: string, hours: number, state: "active" | "voided" = "active"): TimeEntryRecord => ({ id, project: "P", task: t, person: "U", performed_on: "2026-09-01", hours, category: "regular", state });

const TRACK = "estimate";

describe("resolveEffortScope", () => {
  it("includes a task and its full descendant tree in withSubtasks mode", () => {
    const relations = buildTaskRelations([task("A"), task("B", "A"), task("C", "B"), task("D")]);
    const scope = resolveEffortScope(relations, { taskId: "A", mode: "withSubtasks" });
    expect([...scope].sort()).toEqual(["A", "B", "C"]);
  });

  it("restricts taskOnly mode to the selected task alone", () => {
    const relations = buildTaskRelations([task("A"), task("B", "A")]);
    const scope = resolveEffortScope(relations, { taskId: "A", mode: "taskOnly" });
    expect([...scope]).toEqual(["A"]);
  });

  it("scopes to a milestone's tasks", () => {
    const relations = buildTaskRelations([task("A", undefined, "M1"), task("B", undefined, "M2"), task("C", undefined, "M1")]);
    const scope = resolveEffortScope(relations, { milestoneId: "M1" });
    expect([...scope].sort()).toEqual(["A", "C"]);
  });
});

describe("resolveTaskPlanEffort", () => {
  it("prefers a declared estimate and labels it declared", () => {
    const rm = readModels([{ id: "A", declared: 12, rolled: 30 }], TRACK);
    expect(resolveTaskPlanEffort(rm, TRACK, "A", "withSubtasks")).toEqual({ value: 12, source: "declared" });
  });

  it("falls back to rolled children in withSubtasks mode", () => {
    const rm = readModels([{ id: "A", rolled: 30 }], TRACK);
    expect(resolveTaskPlanEffort(rm, TRACK, "A", "withSubtasks")).toEqual({ value: 30, source: "rolled" });
  });

  it("returns a missing plan in taskOnly mode when there is no declared estimate", () => {
    const rm = readModels([{ id: "A", rolled: 30 }], TRACK);
    expect(resolveTaskPlanEffort(rm, TRACK, "A", "taskOnly")).toEqual({ value: undefined, source: "missing" });
  });
});

describe("sumBranchActualWithinScope", () => {
  it("rolls descendant hours up but stops at the scope boundary", () => {
    // A -> B -> C, plus D (child of C) lives OUTSIDE the milestone scope.
    const relations = buildTaskRelations([task("A"), task("B", "A", "M"), task("C", "B", "M"), task("D", "C", "OTHER")]);
    const scope = resolveEffortScope(relations, { milestoneId: "M" }); // A? no, A has no milestone
    // A has no milestone so it is excluded; scope = {B, C}. D is outside the scope.
    const actualByTask = new Map<string, number>([["A", 1], ["B", 2], ["C", 4], ["D", 8]]);
    // Branch actual of B walks B -> C (in scope) but must NOT reach D (outside scope).
    expect(sumBranchActualWithinScope(actualByTask, relations, scope, "B")).toBe(6);
  });

  it("never double-counts and is cycle-safe", () => {
    const relations = buildTaskRelations([task("A"), task("B", "A")]);
    const scope = new Set(["A", "B"]);
    const actualByTask = new Map<string, number>([["A", 3], ["B", 5]]);
    expect(sumBranchActualWithinScope(actualByTask, relations, scope, "A")).toBe(8);
    expect(sumBranchActualWithinScope(actualByTask, relations, scope, "B")).toBe(5);
  });
});

describe("sumScopePlan", () => {
  it("sums root tasks only so parents and children are not double-counted", () => {
    // Parent P has its own 80; children C1/C2 declare 30/50. Roots of the scope = {P}.
    const relations = buildTaskRelations([task("P"), task("C1", "P"), task("C2", "P")]);
    const scope = resolveEffortScope(relations, { taskId: "P", mode: "withSubtasks" });
    const roots = scopeRootIdsOf(scope, relations);
    expect(roots).toEqual(["P"]);
    const rm = readModels([{ id: "P", declared: 80 }, { id: "C1", declared: 30 }, { id: "C2", declared: 50 }], TRACK);
    expect(sumScopePlan(rm, TRACK, roots, "withSubtasks")).toBe(80);
  });

  it("returns undefined when no root carries an estimate", () => {
    const relations = buildTaskRelations([task("A"), task("B")]);
    const scope = resolveEffortScope(relations, {});
    const roots = scopeRootIdsOf(scope, relations);
    const rm = readModels([{ id: "A" }, { id: "B" }], TRACK);
    expect(sumScopePlan(rm, TRACK, roots, "withSubtasks")).toBeUndefined();
  });
});

describe("selectScopedRecords", () => {
  it("keeps only records whose task is inside the scope", () => {
    const records = [entry("E1", "A", 4), entry("E2", "B", 2), entry("E3", "A", 1, "voided")];
    expect(selectScopedRecords(records, new Set(["A"]))).toHaveLength(2);
  });
});

describe("roundHours", () => {
  it("rounds to four decimals without floating-point drift", () => {
    expect(roundHours(0.1 + 0.2)).toBe(0.3);
  });
});
