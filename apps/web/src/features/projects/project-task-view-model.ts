import { buildTaskHierarchy, type HierarchyTask, type TaskHierarchy } from "@gitpm/task-hierarchy";
import type { Locale } from "../../i18n.js";
import type { EntityResult } from "../../types.js";

/**
 * Read-only presentation model that produces the canonical manual order of a
 * project's tasks. The Plan workspace and the Effort workspace share this single
 * source of truth so stage grouping, stage ordering, and the DFS-preorder task
 * tree cannot drift apart.
 *
 * The model never mutates its inputs. Every field on a {@link TaskViewModelNode}
 * is derived from the supplied documents through the track-agnostic
 * `text`/`effortOf` readers, so the model does not hardcode any schedule-track
 * slug.
 */

export type TaskTextReader = (document: Readonly<Record<string, unknown>>, key: string) => string;
export type TaskEffortReader = (document: Readonly<Record<string, unknown>>) => number | undefined;
export type TaskComparator = (left: EntityResult, right: EntityResult) => number;

/**
 * Build the canonical tie-break comparator shared by every surface that lists
 * project tasks. Tasks absent from a milestone's `task_order` (and tasks in the
 * system group) are ordered by localized title, then by id. Both the Plan and
 * Effort tabs pass this comparator to {@link buildProjectTaskViewModel} so the
 * sequence of task ids cannot drift between surfaces.
 */
export const canonicalTaskComparator = (locale: Locale, text: TaskTextReader): TaskComparator => (left, right) => {
  const byTitle = text(left.document, "title").localeCompare(text(right.document, "title"), locale);
  if (byTitle !== 0) return byTitle;
  return left.document.id.localeCompare(right.document.id);
};

/**
 * A single task in the shared hierarchy view.
 *
 * `path` is the list of ancestor ids from the root down to and including this
 * node, so `path[path.length - 1] === id` and `path[0]` is the root ancestor.
 */
export interface TaskViewModelNode {
  readonly id: string;
  readonly parentId: string | undefined;
  readonly depth: number;
  readonly path: readonly string[];
  readonly milestoneId: string | undefined;
  readonly manualOrder: number | undefined;
  readonly title: string;
  readonly status: string;
  readonly assignees: readonly string[];
  readonly due: string | undefined;
  readonly estimate: number | undefined;
  readonly children: readonly TaskViewModelNode[];
}

/** Active-milestone group: the milestone entity plus its ordered root task nodes. */
export interface ProjectTaskStageGroup {
  readonly kind: "stage";
  readonly milestone: EntityResult;
  readonly roots: readonly TaskViewModelNode[];
}

/** Tasks whose milestone is empty or points to a non-active milestone. */
export interface ProjectTaskSystemGroup {
  readonly kind: "system";
  readonly roots: readonly TaskViewModelNode[];
}

export interface ProjectTaskViewModel {
  readonly stages: readonly ProjectTaskStageGroup[];
  readonly system: ProjectTaskSystemGroup;
}

/**
 * A single flattened view-model row: a task node paired with the milestone
 * stage it belongs to. `stage` is `undefined` for rows in the system group.
 */
export interface TaskViewModelRow {
  readonly node: TaskViewModelNode;
  readonly stage: EntityResult | undefined;
}

/**
 * Flatten the view model into DFS-preorder rows: stages in
 * {@link orderActiveMilestones} order, then the system group, each traversed
 * depth-first. The order is stable and matches the canonical manual order, so
 * consumers that need a single flat list (such as the actual-report table) can
 * reuse the shared hierarchy without rebuilding it.
 */
export function flattenProjectTaskViewModel(view: ProjectTaskViewModel): readonly TaskViewModelRow[] {
  const rows: TaskViewModelRow[] = [];
  const visit = (node: TaskViewModelNode, stage: EntityResult | undefined): void => {
    rows.push({ node, stage });
    for (const child of node.children) visit(child, stage);
  };
  for (const group of view.stages) for (const root of group.roots) visit(root, group.milestone);
  for (const root of view.system.roots) visit(root, undefined);
  return rows;
}

export interface OrderActiveMilestonesOptions {
  readonly project: EntityResult;
  readonly milestones: readonly EntityResult[];
  readonly text: TaskTextReader;
  readonly locale: Locale;
}

export interface BuildProjectTaskViewModelOptions extends OrderActiveMilestonesOptions {
  readonly tasks: readonly EntityResult[];
  readonly effortOf: TaskEffortReader;
  /**
   * Optional comparator used to break ties among tasks that are not listed in a
   * milestone's `task_order`, and to order siblings inside the system group.
   * When omitted, the relative order of the supplied `tasks` array is used as a
   * stable fallback. The Plan workspace passes its analytical comparator so the
   * extracted behavior matches the previous inline sort exactly.
   */
  readonly compareTasks?: TaskComparator;
}

interface HierarchyPayload extends HierarchyTask {
  readonly entity: EntityResult;
}

const FAR_FUTURE_DUE = "9999-12-31";

const strings = (document: Readonly<Record<string, unknown>>, key: string): readonly string[] =>
  Array.isArray(document[key])
    ? (document[key] as readonly unknown[]).filter((item): item is string => typeof item === "string")
    : [];

const parentOf = (document: Readonly<Record<string, unknown>>): string | undefined =>
  typeof document.parent === "string" && document.parent !== "" ? document.parent : undefined;

/**
 * Compare two ids by their position in `order`. An id that is absent from
 * `order` sorts after one that is present; two absent ids compare equal so a
 * stable outer sort preserves their relative order.
 */
export const compareOrder = (order: readonly string[], leftId: string, rightId: string): number => {
  const left = order.indexOf(leftId);
  const right = order.indexOf(rightId);
  if (left < 0 && right >= 0) return 1;
  if (left >= 0 && right < 0) return -1;
  return left >= 0 && right >= 0 ? left - right : 0;
};

/**
 * Return active milestones ordered by `project.milestone_order`, then by the
 * primary-track `due` date, then by localized name. The explicit
 * `milestone_order` is the canonical signal; the `due` and `name` tie-breakers
 * keep unlisted milestones on a stable, predictable sequence.
 */
export function orderActiveMilestones({ project, milestones, text, locale }: OrderActiveMilestonesOptions): readonly EntityResult[] {
  const order = strings(project.document, "milestone_order");
  return milestones
    .filter((milestone) => milestone.document.lifecycle === "active")
    .slice()
    .sort((left, right) => {
      const byOrder = compareOrder(order, left.document.id, right.document.id);
      if (byOrder !== 0) return byOrder;
      const byDue = (text(left.document, "due") || FAR_FUTURE_DUE).localeCompare(text(right.document, "due") || FAR_FUTURE_DUE);
      if (byDue !== 0) return byDue;
      return text(left.document, "name").localeCompare(text(right.document, "name"), locale);
    });
}

interface NodeBuildContext {
  readonly text: TaskTextReader;
  readonly effortOf: TaskEffortReader;
}

const buildNodes = (
  hierarchy: TaskHierarchy<HierarchyPayload>,
  order: readonly string[],
  ctx: NodeBuildContext,
): readonly TaskViewModelNode[] => {
  const visit = (task: HierarchyPayload, depth: number, parentPath: readonly string[]): TaskViewModelNode => {
    const path = [...parentPath, task.id];
    const document = task.entity.document;
    const due = ctx.text(document, "due");
    const milestoneRaw = ctx.text(document, "milestone");
    const manualIndex = order.indexOf(task.id);
    const children = hierarchy.childrenOf(task.id).map((child) => visit(child, depth + 1, path));
    return {
      id: task.id,
      parentId: depth === 0 ? undefined : task.parent,
      depth,
      path,
      milestoneId: milestoneRaw === "" ? undefined : milestoneRaw,
      manualOrder: manualIndex >= 0 ? manualIndex : undefined,
      title: ctx.text(document, "title"),
      status: ctx.text(document, "status"),
      assignees: strings(document, "assignees"),
      due: due === "" ? undefined : due,
      estimate: ctx.effortOf(document),
      children,
    };
  };
  return hierarchy.childrenOf().map((root) => visit(root, 0, []));
};

const toPayload = (entity: EntityResult): HierarchyPayload => {
  const parent = parentOf(entity.document);
  return parent === undefined ? { id: entity.document.id, entity } : { id: entity.document.id, parent, entity };
};

/**
 * Build the shared project task view model.
 *
 * Stage groups follow {@link orderActiveMilestones}. Within a stage, root tasks
 * are ordered by the milestone's flat DFS-preorder `task_order`; child tasks
 * nest depth-first under their parent. Tasks whose `milestone` is empty or
 * points to a milestone that is absent or not active form a separate system
 * group rendered after the stages.
 *
 * When `compareTasks` is supplied the model reproduces the analytical order
 * (completion, then due, then title) used to break ties among tasks absent from
 * a milestone's `task_order` and to order the system group; otherwise the
 * relative order of the supplied `tasks` array is the stable fallback.
 */
export function buildProjectTaskViewModel(options: BuildProjectTaskViewModelOptions): ProjectTaskViewModel {
  const { project, milestones, tasks, text, effortOf, locale, compareTasks } = options;
  const orderedMilestones = orderActiveMilestones({ project, milestones, text, locale });
  const activeMilestoneIds = new Set(orderedMilestones.map((milestone) => milestone.document.id));
  const hierarchyCompare = compareTasks === undefined
    ? undefined
    : (left: HierarchyPayload, right: HierarchyPayload) => compareTasks(left.entity, right.entity);

  const stages: ProjectTaskStageGroup[] = orderedMilestones.map((milestone) => {
    const order = strings(milestone.document, "task_order");
    const stageTasks = tasks.filter((task) => text(task.document, "milestone") === milestone.document.id);
    const hierarchy = buildTaskHierarchy(stageTasks.map(toPayload), {
      ...(order.length === 0 ? {} : { order }),
      ...(hierarchyCompare === undefined ? {} : { compare: hierarchyCompare }),
    });
    return { kind: "stage", milestone, roots: buildNodes(hierarchy, order, { text, effortOf }) };
  });

  const systemTasks = tasks.filter((task) => {
    const milestoneId = text(task.document, "milestone");
    return milestoneId === "" || !activeMilestoneIds.has(milestoneId);
  });
  const systemHierarchy = buildTaskHierarchy(systemTasks.map(toPayload), {
    ...(hierarchyCompare === undefined ? {} : { compare: hierarchyCompare }),
  });
  const system: ProjectTaskSystemGroup = {
    kind: "system",
    roots: buildNodes(systemHierarchy, [], { text, effortOf }),
  };

  return { stages, system };
}
