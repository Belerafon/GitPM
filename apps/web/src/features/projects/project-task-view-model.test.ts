import { describe, expect, it } from "vitest";
import { scheduleEffortReader, scheduleTextReader } from "../../schedules.js";
import type { EntityDocument, EntityResult } from "../../types.js";
import {
  buildProjectTaskViewModel,
  compareOrder,
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

  it("falls back to due then localized name for ids missing from milestone_order", () => {
    const early = milestone("M-EARLY", { name: "Early", schedules: { [TRACK]: { finish: "2026-01-01" } } });
    const late = milestone("M-LATE", { name: "Late", schedules: { [TRACK]: { finish: "2026-12-01" } } });
    const ordered = orderActiveMilestones({
      project: project(),
      milestones: [late, early],
      text,
      locale: "en",
    });
    expect(ordered.map((m) => m.document.id)).toEqual(["M-EARLY", "M-LATE"]);
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
