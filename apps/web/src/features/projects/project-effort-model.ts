import { windowEffort, type SchedulingReadModel } from "@gitpm/scheduling";
import type { TimeEntryRecord } from "@gitpm/time-entries";
import type { EntityResult } from "../../types.js";

/**
 * Pure, track-agnostic effort calculations shared by the Effort workspace. None
 * of these functions hardcode a schedule-track slug; the active workload track is
 * always passed in by the caller. Every function is deterministic and free of
 * React state so they can be unit-tested in isolation.
 */

export type EffortScopeMode = "withSubtasks" | "taskOnly";
export type EffortPlanSource = "declared" | "rolled" | "missing";

export interface EffortTaskRelations {
  /** All known task ids in the project. */
  readonly ids: readonly string[];
  /** Direct child ids grouped by parent id. */
  readonly childrenByParent: ReadonlyMap<string, readonly string[]>;
  /** Parent id by task id (absent for roots). */
  readonly parentOf: ReadonlyMap<string, string>;
  /** Milestone id by task id (absent when empty). */
  readonly milestoneOf: ReadonlyMap<string, string>;
}

export interface EffortPlanValue {
  readonly value: number | undefined;
  readonly source: EffortPlanSource;
}

const text = (entity: EntityResult | undefined, key: string): string =>
  typeof entity?.document[key] === "string" ? String(entity.document[key]) : "";

export const roundHours = (value: number): number => Math.round((value + Number.EPSILON) * 10_000) / 10_000;

/**
 * Build parent/child and milestone maps across ALL project tasks. The maps span
 * the whole project (not a filtered view) so a parent's branch can reach its
 * descendants regardless of which milestone filter narrows the visible rows.
 */
export function buildTaskRelations(tasks: readonly EntityResult[]): EffortTaskRelations {
  const childrenByParent = new Map<string, string[]>();
  const parentOf = new Map<string, string>();
  const milestoneOf = new Map<string, string>();
  const ids: string[] = [];
  for (const task of tasks) {
    const id = task.document.id;
    ids.push(id);
    const parent = text(task, "parent");
    if (parent !== "") {
      parentOf.set(id, parent);
      const peers = childrenByParent.get(parent) ?? [];
      peers.push(id);
      childrenByParent.set(parent, peers);
    }
    const milestone = text(task, "milestone");
    if (milestone !== "") milestoneOf.set(id, milestone);
  }
  return { ids, childrenByParent, parentOf, milestoneOf };
}

/**
 * Resolve the set of task ids that form the current effort scope.
 *
 * - task + withSubtasks: the task and its full descendant tree.
 * - task + taskOnly: only the task itself.
 * - milestone: every task whose milestone matches.
 * - otherwise: every project task.
 */
export function resolveEffortScope(relations: EffortTaskRelations, options: { readonly taskId?: string; readonly milestoneId?: string; readonly mode?: EffortScopeMode }): ReadonlySet<string> {
  const taskId = options.taskId ?? "";
  const milestoneId = options.milestoneId ?? "";
  const mode = options.mode ?? "withSubtasks";
  if (taskId !== "") {
    if (mode === "taskOnly") return new Set([taskId]);
    const ids = new Set<string>([taskId]);
    const stack = [taskId];
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const child of relations.childrenByParent.get(current) ?? []) {
        if (ids.has(child)) continue;
        ids.add(child);
        stack.push(child);
      }
    }
    return ids;
  }
  if (milestoneId !== "") {
    return new Set(relations.ids.filter((id) => relations.milestoneOf.get(id) === milestoneId));
  }
  return new Set(relations.ids);
}

/** Root ids of a scope: tasks whose parent is absent or itself outside the scope. */
export function scopeRootIdsOf(scope: ReadonlySet<string>, relations: EffortTaskRelations): readonly string[] {
  return [...scope].filter((id) => {
    const parent = relations.parentOf.get(id);
    return parent === undefined || !scope.has(parent);
  });
}

/** Active time-entry records whose task belongs to the scope. */
export function selectScopedRecords(records: readonly TimeEntryRecord[], scope: ReadonlySet<string>): readonly TimeEntryRecord[] {
  return records.filter((entry) => scope.has(entry.task));
}

const workloadSummary = (readModels: ReadonlyMap<string, SchedulingReadModel>, workloadTrack: string, id: string) =>
  readModels.get(id)?.tracks.find((track) => track.track === workloadTrack);

/**
 * Resolve a single task's planned effort. A declared estimate always wins. When
 * the task has no estimate of its own, the rolled-up children value is used —
 * except in `taskOnly` mode, where rolled estimates are deliberately rejected so
 * the scope reflects only the selected task.
 */
export function resolveTaskPlanEffort(readModels: ReadonlyMap<string, SchedulingReadModel>, workloadTrack: string, taskId: string, mode: EffortScopeMode): EffortPlanValue {
  const declared = windowEffort(workloadSummary(readModels, workloadTrack, taskId)?.declared);
  if (declared !== undefined) return { value: declared, source: "declared" };
  if (mode === "taskOnly") return { value: undefined, source: "missing" };
  const rolled = windowEffort(workloadSummary(readModels, workloadTrack, taskId)?.rolled);
  return rolled !== undefined ? { value: rolled, source: "rolled" } : { value: undefined, source: "missing" };
}

/**
 * Sum the active hours of a task and its descendants, but only for descendants
 * that remain inside the current scope. Walks the relation map with cycle
 * protection so broken or cyclic parent links cannot loop forever.
 */
export function sumBranchActualWithinScope(actualByTask: ReadonlyMap<string, number>, relations: EffortTaskRelations, scope: ReadonlySet<string>, taskId: string): number {
  let total = actualByTask.get(taskId) ?? 0;
  const seen = new Set<string>([taskId]);
  const stack = [taskId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const child of relations.childrenByParent.get(current) ?? []) {
      if (seen.has(child) || !scope.has(child)) continue;
      seen.add(child);
      total += actualByTask.get(child) ?? 0;
      stack.push(child);
    }
  }
  return roundHours(total);
}

/**
 * Total planned effort for the scope, summed over its root tasks only. Because a
 * root task's effort value is either its own declared estimate or its rolled-up
 * children (never both), summing roots never double-counts parents and children.
 */
export function sumScopePlan(readModels: ReadonlyMap<string, SchedulingReadModel>, workloadTrack: string, scopeRootIds: readonly string[], mode: EffortScopeMode): number | undefined {
  let total: number | undefined;
  for (const id of scopeRootIds) {
    const { value } = resolveTaskPlanEffort(readModels, workloadTrack, id, mode);
    if (value === undefined) continue;
    total = (total ?? 0) + value;
  }
  return total;
}
