import { describe, expect, it } from "vitest";
import { scheduleEffortReader, scheduleTextReader } from "../../schedules.js";
import type { EntityDocument, EntityResult } from "../../types.js";
import {
  buildProjectTaskViewModel,
  canonicalTaskComparator,
  compareOrder,
  flattenProjectTaskViewModel,
  orderActiveMilestones,
  type TaskViewModelNode,
} from "./project-task-view-model.js";

/**
 * Every fixture uses the made-up schedule-track slug `effortws` (never `plan`)
 * to prove the view model is track-agnostic and reads everything through the
 * injected readers.
 */
const TRACK = "effortws";
const text = scheduleTextReader(TRACK);
const effortOf = scheduleEffortReader(TRACK);

const fingerprint = "f".repeat(64);
const result = (document: EntityDocument): EntityResult => ({
  document,
  path: `${document.id}.yaml`,
  blob_id: "a".repeat(40),
  draft_fingerprint: fingerprint,
});

const project = (extra: Partial<EntityDocument> = {}): EntityResult => result({
  schema: "gitpm/project@2",
  id: "P-26-PROJECT",
  name: "Alpha",
  status: "backlog",
  lifecycle: "active",
  ...extra,
});

const milestone = (id: string, extra: Partial<EntityDocument> = {}): EntityResult => result({
  schema: "gitpm/milestone@2",
  id,
  project: "P-26-PROJECT",
  name: id,
  lifecycle: "active",
  ...extra,
});

const task = (id: string, extra: Partial<EntityDocument> = {}): EntityResult => result({
  schema: "gitpm/task@2",
  id,
  project: "P-26-PROJECT",
  title: id,
  type: "task",
  status: "backlog",
  lifecycle: "active",
  ...extra,
});

const ids = (nodes: readonly TaskViewModelNode[]): string[] => nodes.map((node) => node.id);

describe("compareOrder", () => {
  it("places listed ids by position and unlisted ids after", () => {
    const order = ["C", "A", "B"];
    const sorted = ["x", "B", "A", "C", "y"].sort((a, b) => compareOrder(order, a, b));
    expect(sorted).toEqual(["C", "A", "B", "x", "y"]);
  });

  it("keeps relative order stable when both ids are unlisted", () => {
    expect(compareOrder(["A"], "x", "y")).toBe(0);
  });
});

describe("orderActiveMilestones", () => {
  it("orders active milestones by project.milestone_order and drops non-active milestones", () => {
    const m1 = milestone("M-1");
    const m2 = milestone("M-2");
    const m3 = milestone("M-3");
    const archived = milestone("M-ARCH", { lifecycle: "archived" });
    const ordered = orderActiveMilestones({
      project: project({ milestone_order: ["M-3", "M-1"] }),
      milestones: [m1, m2, m3, archived],
      text,
      locale: "en",
    });
    expect(ordered.map((m) => m.document.id)).toEqual(["M-3", "M-1", "M-2"]);
  });

  it("falls back to localized name then id for ids missing from milestone_order, ignoring track due dates", () => {
    // The tie-breaker must be track-independent so Plan (primary track) and Effort
    // (workload track) render milestones in the same order even when their finishes differ.
    const lateByName = milestone("M-LATE", { name: "Late", schedules: { [TRACK]: { finish: "2026-01-01" } } });
    const earlyByName = milestone("M-EARLY", { name: "Early", schedules: { [TRACK]: { finish: "2026-12-01" } } });
    const ordered = orderActiveMilestones({
      project: project(),
      milestones: [lateByName, earlyByName],
      text,
      locale: "en",
    });
    // Name wins over the track `due` date: "Early" before "Late" even though Late is due earlier.
    expect(ordered.map((m) => m.document.id)).toEqual(["M-EARLY", "M-LATE"]);
  });

  it("breaks name ties by id so the order is stable and track-independent", () => {
    const a = milestone("M-2", { name: "Sprint" });
    const b = milestone("M-1", { name: "Sprint" });
    const ordered = orderActiveMilestones({
      project: project(),
      milestones: [a, b],
      text,
      locale: "en",
    });
    expect(ordered.map((m) => m.document.id)).toEqual(["M-1", "M-2"]);
  });
});

describe("buildProjectTaskViewModel", () => {
  it("nests stage tasks by task_order DFS and reports depth plus root-to-inclusive path", () => {
    const rootA = task("T-A", { milestone: "M-STAGE" });
    const childA1 = task("T-A1", { milestone: "M-STAGE", parent: "T-A" });
    const grandA1a = task("T-A1a", { milestone: "M-STAGE", parent: "T-A1" });
    const rootB = task("T-B", { milestone: "M-STAGE" });
    const stage = milestone("M-STAGE", {
      task_order: ["T-A", "T-A1", "T-A1a", "T-B"],
    });

    const view = buildProjectTaskViewModel({
      project: project(),
      milestones: [stage],
      tasks: [grandA1a, rootB, rootA, childA1],
      text,
      effortOf,
      locale: "en",
    });

    expect(view.stages).toHaveLength(1);
    const stageGroup = view.stages[0]!;
    expect(stageGroup.milestone.document.id).toBe("M-STAGE");
    expect(ids(stageGroup.roots)).toEqual(["T-A", "T-B"]);

    const [aNode, bNode] = stageGroup.roots;
    expect(aNode!.id).toBe("T-A");
    expect(aNode!.depth).toBe(0);
    expect(aNode!.parentId).toBeUndefined();
    expect(aNode!.path).toEqual(["T-A"]);
    expect(aNode!.milestoneId).toBe("M-STAGE");
    expect(ids(aNode!.children)).toEqual(["T-A1"]);

    const childNode = aNode!.children[0]!;
    expect(childNode.id).toBe("T-A1");
    expect(childNode.depth).toBe(1);
    expect(childNode.parentId).toBe("T-A");
    expect(childNode.path).toEqual(["T-A", "T-A1"]);

    const grandNode = childNode.children[0]!;
    expect(grandNode.id).toBe("T-A1a");
    expect(grandNode.depth).toBe(2);
    expect(grandNode.parentId).toBe("T-A1");
    expect(grandNode.path).toEqual(["T-A", "T-A1", "T-A1a"]);
    expect(grandNode.children).toEqual([]);

    expect(bNode!.depth).toBe(0);
    expect(bNode!.children).toEqual([]);
  });

  it("routes tasks with empty, archived, or absent milestone into the system group", () => {
    const activeStage = milestone("M-ACTIVE");
    const archivedStage = milestone("M-ARCH", { lifecycle: "archived" });
    const noMilestone = task("T-NONE");
    const archivedMilestoneTask = task("T-ARCHIVED", { milestone: "M-ARCH" });
    const missingMilestoneTask = task("T-MISSING", { milestone: "M-GONE" });
    const activeTask = task("T-ACTIVE", { milestone: "M-ACTIVE" });

    const view = buildProjectTaskViewModel({
      project: project(),
      milestones: [activeStage, archivedStage],
      tasks: [noMilestone, archivedMilestoneTask, missingMilestoneTask, activeTask],
      text,
      effortOf,
      locale: "en",
    });

    expect(ids(view.stages[0]!.roots)).toEqual(["T-ACTIVE"]);
    const systemDfs = view.system.roots.flatMap((root) => [root.id, ...root.children.map((c) => c.id)]);
    expect(systemDfs).toEqual(["T-NONE", "T-ARCHIVED", "T-MISSING"]);
    expect(view.system.roots.every((root) => root.milestoneId === undefined || root.milestoneId !== "M-ACTIVE")).toBe(true);
    const archived = view.system.roots.find((r) => r.id === "T-ARCHIVED")!;
    expect(archived.milestoneId).toBe("M-ARCH");
    const missing = view.system.roots.find((r) => r.id === "T-MISSING")!;
    expect(missing.milestoneId).toBe("M-GONE");
    const none = view.system.roots.find((r) => r.id === "T-NONE")!;
    expect(none.milestoneId).toBeUndefined();
  });

  it("reads due from the text reader and estimate from the effort reader for the configured track", () => {
    const estimated = task("T-EST", {
      milestone: "M-S",
      schedules: { [TRACK]: { finish: "2026-05-14", effort_hours: 7.5 } },
    });
    const bare = task("T-BARE", { milestone: "M-S" });
    const stage = milestone("M-S");

    const view = buildProjectTaskViewModel({
      project: project(),
      milestones: [stage],
      tasks: [estimated, bare],
      text,
      effortOf,
      locale: "en",
    });

    const estimatedNode = view.stages[0]!.roots.find((r) => r.id === "T-EST")!;
    expect(estimatedNode.due).toBe("2026-05-14");
    expect(estimatedNode.estimate).toBe(7.5);
    const bareNode = view.stages[0]!.roots.find((r) => r.id === "T-BARE")!;
    expect(bareNode.due).toBeUndefined();
    expect(bareNode.estimate).toBeUndefined();
  });

  it("exposes the parent own estimate without summing child estimates", () => {
    const parentTask = task("T-PARENT", {
      milestone: "M-S",
      schedules: { [TRACK]: { effort_hours: 5 } },
    });
    const childTask = task("T-CHILD", {
      milestone: "M-S",
      parent: "T-PARENT",
      schedules: { [TRACK]: { effort_hours: 3 } },
    });
    const stage = milestone("M-S", { task_order: ["T-PARENT", "T-CHILD"] });

    const view = buildProjectTaskViewModel({
      project: project(),
      milestones: [stage],
      tasks: [parentTask, childTask],
      text,
      effortOf,
      locale: "en",
    });

    const parentNode = view.stages[0]!.roots[0]!;
    expect(parentNode.id).toBe("T-PARENT");
    expect(parentNode.estimate).toBe(5);
    expect(parentNode.children[0]!.estimate).toBe(3);
  });

  it("reports manualOrder as the index within the milestone task_order and undefined otherwise", () => {
    const listed = task("T-LISTED", { milestone: "M-S" });
    const alsoListed = task("T-ALSO", { milestone: "M-S" });
    const unlisted = task("T-UNLISTED", { milestone: "M-S" });
    const stage = milestone("M-S", { task_order: ["T-LISTED", "T-ALSO"] });

    const view = buildProjectTaskViewModel({
      project: project(),
      milestones: [stage],
      tasks: [listed, alsoListed, unlisted],
      text,
      effortOf,
      locale: "en",
    });

    const roots = view.stages[0]!.roots;
    const byId = new Map(roots.map((r) => [r.id, r]));
    expect(byId.get("T-LISTED")!.manualOrder).toBe(0);
    expect(byId.get("T-ALSO")!.manualOrder).toBe(1);
    expect(byId.get("T-UNLISTED")!.manualOrder).toBeUndefined();
    expect(view.system.roots.every((r) => r.manualOrder === undefined)).toBe(true);
  });

  it("orders system-group siblings through the supplied compareTasks comparator", () => {
    const zTask = task("T-ZEBRA", { title: "Zebra", status: "backlog" });
    const aTask = task("T-ALPHA", { title: "Alpha", status: "backlog" });
    const compareByTitle = (left: EntityResult, right: EntityResult): number =>
      (left.document.title as string).localeCompare(right.document.title as string);

    const view = buildProjectTaskViewModel({
      project: project(),
      milestones: [],
      tasks: [zTask, aTask],
      text,
      effortOf,
      locale: "en",
      compareTasks: compareByTitle,
    });

    expect(ids(view.system.roots)).toEqual(["T-ALPHA", "T-ZEBRA"]);
  });

  it("does not mutate the supplied task or milestone arrays", () => {
    const stage = milestone("M-S", { task_order: ["T-1", "T-2"] });
    const t1 = task("T-1", { milestone: "M-S" });
    const t2 = task("T-2", { milestone: "M-S" });
    const tasks = [t2, t1];
    const milestones = [stage];
    const originalTaskIds = tasks.map((t) => t.document.id);

    buildProjectTaskViewModel({
      project: project(),
      milestones,
      tasks,
      text,
      effortOf,
      locale: "en",
    });

    expect(tasks.map((t) => t.document.id)).toEqual(originalTaskIds);
    expect(milestones).toEqual([stage]);
  });
});

describe("flattenProjectTaskViewModel", () => {
  it("yields DFS-preorder rows across stages then the system group, carrying the stage entity", () => {
    const stage1 = milestone("M-1", { task_order: ["T-A", "T-A1"] });
    const stage2 = milestone("M-2", { task_order: ["T-B"] });
    const rootA = task("T-A", { milestone: "M-1" });
    const childA1 = task("T-A1", { milestone: "M-1", parent: "T-A" });
    const grandA1a = task("T-A1a", { milestone: "M-1", parent: "T-A1" });
    const rootB = task("T-B", { milestone: "M-2" });
    const systemTask = task("T-SYS");

    const view = buildProjectTaskViewModel({
      project: project({ milestone_order: ["M-1", "M-2"] }),
      milestones: [stage1, stage2],
      tasks: [grandA1a, rootB, rootA, childA1, systemTask],
      text,
      effortOf,
      locale: "en",
    });

    const rows = flattenProjectTaskViewModel(view);
    expect(rows.map((row) => row.node.id)).toEqual(["T-A", "T-A1", "T-A1a", "T-B", "T-SYS"]);
    expect(rows.map((row) => row.node.depth)).toEqual([0, 1, 2, 0, 0]);
    expect(rows.map((row) => row.stage?.document.id)).toEqual(["M-1", "M-1", "M-1", "M-2", undefined]);
  });

  it("produces one canonical task sequence shared by the Plan and Effort surfaces", () => {
    const stage = milestone("M-1");
    const cherry = task("T-CHERRY", { milestone: "M-1", title: "Cherry task" });
    const apple = task("T-APPLE", { milestone: "M-1", title: "Apple task" });
    const banana = task("T-BANANA", { milestone: "M-1", title: "Banana task" });
    const compare = canonicalTaskComparator("en", text);
    const projectDoc = project({ milestone_order: ["M-1"] });

    // The Plan workspace and the Effort report receive the same tasks but in
    // different input orders; both pass canonicalTaskComparator, so the visible
    // sequence of task ids must be identical and follow the title tie-break.
    const planOrder = flattenProjectTaskViewModel(buildProjectTaskViewModel({
      project: projectDoc, milestones: [stage], tasks: [cherry, banana, apple], text, effortOf, locale: "en", compareTasks: compare,
    })).map((row) => row.node.id);
    const effortOrder = flattenProjectTaskViewModel(buildProjectTaskViewModel({
      project: projectDoc, milestones: [stage], tasks: [banana, apple, cherry], text, effortOf, locale: "en", compareTasks: compare,
    })).map((row) => row.node.id);

    expect(planOrder).toEqual(["T-APPLE", "T-BANANA", "T-CHERRY"]);
    expect(effortOrder).toEqual(planOrder);
  });

  it("orders milestones identically under the primary-track and workload-track readers", () => {
    // The Plan tab reads dates through the primary track and the Effort tab through the workload
    // track; milestone order must not depend on that choice. Two milestones carry conflicting
    // finishes across the two tracks so a track-dependent tie-break would diverge.
    const primaryReader = scheduleTextReader("primary");
    const workloadReader = scheduleTextReader("workload");
    const stageA = milestone("M-A", { name: "Sprint", schedules: { primary: { finish: "2026-12-01" }, workload: { finish: "2026-01-01" } } });
    const stageB = milestone("M-B", { name: "Sprint", schedules: { primary: { finish: "2026-01-01" }, workload: { finish: "2026-12-01" } } });
    const projectDoc = project();
    const planOrder = orderActiveMilestones({ project: projectDoc, milestones: [stageA, stageB], text: primaryReader, locale: "en" }).map((m) => m.document.id);
    const effortOrder = orderActiveMilestones({ project: projectDoc, milestones: [stageA, stageB], text: workloadReader, locale: "en" }).map((m) => m.document.id);
    // Same name => id tie-break wins; the conflicting track finishes must not influence the order.
    expect(planOrder).toEqual(["M-A", "M-B"]);
    expect(effortOrder).toEqual(planOrder);
  });
});
