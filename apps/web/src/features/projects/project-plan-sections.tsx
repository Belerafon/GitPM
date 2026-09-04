import { useState, type CSSProperties } from "react";
import { isCompletedStatus } from "../../status-categories.js";
import type { ConfigValue } from "../../core-ui.js";
import { formatDateOnly, formatDurationHours, type Locale, type MessageKey } from "../../i18n.js";
import { PersonLinks } from "../../person-link.js";
import type { EntityResult } from "../../types.js";
import type { WorkspaceNavigate } from "../../workspace-navigation.js";
import type { TaskViewModelNode } from "./project-task-view-model.js";
import type { TaskFieldVisibility } from "./project-plan-preferences.js";

export type TaskInsertSpec = { readonly parentId?: string; readonly beforeId?: string; readonly afterId?: string };
type ScheduleTextReader = (document: Readonly<Record<string, unknown>>, key: string) => string;
type ScheduleNumberReader = (document: Readonly<Record<string, unknown>>, key: string) => number | undefined;
type Translate = (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string;

const strings = (document: Readonly<Record<string, unknown>>, key: string): string[] => Array.isArray(document[key]) ? (document[key] as unknown[]).filter((item): item is string => typeof item === "string") : [];

export function ArchivedStageSection({ stage, allTasks, roots, stageIndex, projectId, query, locale, people, readOnly, selected, selectedTaskId, statusTitle, statusOptions, taskFields, text, number, onRestore, onNavigate, t }: {
  readonly stage: EntityResult;
  readonly allTasks: readonly EntityResult[];
  readonly roots: readonly TaskViewModelNode[];
  readonly stageIndex: number;
  readonly projectId: string;
  readonly query: Readonly<Record<string, readonly string[]>>;
  readonly locale: Locale;
  readonly people: readonly EntityResult[];
  readonly readOnly: boolean;
  readonly selected: boolean;
  readonly selectedTaskId: string;
  readonly statusTitle: (slug: string) => string;
  readonly statusOptions: readonly ConfigValue[];
  readonly taskFields: TaskFieldVisibility;
  readonly text: ScheduleTextReader;
  readonly number: ScheduleNumberReader;
  readonly onRestore: () => void;
  readonly onNavigate: WorkspaceNavigate;
  readonly t: Translate;
}) {
  const completed = allTasks.filter((task) => isCompletedStatus(statusOptions, text(task.document, "status"))).length;
  return <article className={`project-plan-stage project-plan-archived-stage${selected ? " selected" : ""}`}>
    <header><button aria-current={selected ? "true" : undefined} aria-label={`${t("core.milestone")}: ${text(stage.document, "name")} · ${stage.document.id}`} className="project-plan-stage-selector" data-control-hint={t("controlHint.openMilestoneDetails")} onClick={() => onNavigate("stages", { projectId, stageId: stage.document.id, query })} type="button"><span className="project-plan-stage-kind">{t("projectArchive.archivedMilestone")} {stageIndex + 1}. <code>{stage.document.id}</code>.</span><span aria-level={3} className="project-plan-stage-title" role="heading">{text(stage.document, "name")}</span><span className="project-plan-stage-description">{text(stage.document, "description_markdown") || t("core.noDescription")}</span></button><div className="project-plan-stage-actions"><button disabled={readOnly} onClick={onRestore} type="button">{t("core.restore")}</button></div></header>
    <div className="project-plan-stage-progress"><progress aria-label={t("stages.progressLabel")} max="100" value={allTasks.length === 0 ? 0 : Math.round(completed / allTasks.length * 100)} /><span>{t("stages.progress", { completed, count: allTasks.length })}</span></div>
    <TaskRows allTasks={allTasks} locale={locale} onNavigate={onNavigate} people={people} projectId={projectId} query={query} roots={roots} selectedTaskId={selectedTaskId} statusOptions={statusOptions} statusTitle={statusTitle} taskFields={taskFields} visibleIds={new Set(allTasks.map((task) => task.document.id))} text={text} number={number} t={t} />
  </article>;
}

export function StageSection({ stage, tasks, allTasks, roots, stageIndex, stageCount, projectId, query, locale, people, readOnly, orderBusy, selected, changed, saving, selectedTaskId, changedTaskIds, savingTaskIds, statusTitle, statusOptions, statusBusy, taskFields, text, number, onNewTask, onCreate, onMoveStage, onMoveTask, onStatusChange, onNavigate, t }: {
  readonly stage: EntityResult;
  readonly tasks: readonly EntityResult[];
  readonly allTasks: readonly EntityResult[];
  readonly roots: readonly TaskViewModelNode[];
  readonly stageIndex: number;
  readonly stageCount: number;
  readonly projectId: string;
  readonly query: Readonly<Record<string, readonly string[]>>;
  readonly locale: Locale;
  readonly people: readonly EntityResult[];
  readonly readOnly: boolean;
  readonly orderBusy: boolean;
  readonly selected: boolean;
  readonly changed: boolean;
  readonly saving: boolean;
  readonly selectedTaskId: string;
  readonly changedTaskIds: ReadonlySet<string>;
  readonly savingTaskIds: ReadonlySet<string>;
  readonly statusTitle: (slug: string) => string;
  readonly statusOptions: readonly ConfigValue[];
  readonly statusBusy: boolean;
  readonly taskFields: TaskFieldVisibility;
  readonly text: ScheduleTextReader;
  readonly number: ScheduleNumberReader;
  readonly onNewTask: () => void;
  readonly onCreate: (spec: TaskInsertSpec) => void;
  readonly onMoveStage: (offset: -1 | 1) => void;
  readonly onMoveTask: (taskId: string, offset: -1 | 1) => void;
  readonly onStatusChange: (task: EntityResult, status: string) => void;
  readonly onNavigate: WorkspaceNavigate;
  readonly t: Translate;
}) {
  const completed = allTasks.filter((task) => isCompletedStatus(statusOptions, text(task.document, "status"))).length;
  const progress = allTasks.length === 0 ? 0 : Math.round(completed / allTasks.length * 100);
  const stageAssigneeIds = [...new Set(allTasks.flatMap((task) => strings(task.document, "assignees")))];
  return <article className={`project-plan-stage${selected ? " selected" : ""}${changed ? " recently-changed" : ""}${saving ? " is-saving" : ""}`} data-flip-key={`stage:${stage.document.id}`}>
    <header>
      <button aria-current={selected ? "true" : undefined} aria-label={`${t("core.milestone")}: ${text(stage.document, "name")} · ${stage.document.id}`} className="project-plan-stage-selector" data-control-hint={t("controlHint.openMilestoneDetails")} onClick={() => onNavigate("stages", { projectId, stageId: stage.document.id, ...(Object.keys(query).length > 0 ? { query } : {}) })} type="button">
        <span className="project-plan-stage-kind">{t("core.milestone")} {stageIndex + 1}. <code>{stage.document.id}</code>.</span>
        <span aria-level={3} className="project-plan-stage-title" role="heading">{text(stage.document, "name")}</span>
        <span className="project-plan-stage-description">{text(stage.document, "description_markdown") || t("core.noDescription")}</span>
        {taskFields.assignees && <span className="project-plan-stage-assignees" title={t("tooltip.milestoneAssignees")}>{t("core.assignees")}: <PersonLinks empty={t("core.unassigned")} onOpen={(personId) => onNavigate("people", { personId })} people={people} personIds={stageAssigneeIds} /></span>}
      </button>
      <div className="project-plan-stage-actions"><span className="plan-order-controls"><button aria-label={t("projectPlan.moveStageUp", { number: stageIndex + 1 })} disabled={readOnly || orderBusy || stageIndex === 0} onClick={() => onMoveStage(-1)} title={t("projectPlan.moveStageUp", { number: stageIndex + 1 })} type="button">↑</button><button aria-label={t("projectPlan.moveStageDown", { number: stageIndex + 1 })} disabled={readOnly || orderBusy || stageIndex === stageCount - 1} onClick={() => onMoveStage(1)} title={t("projectPlan.moveStageDown", { number: stageIndex + 1 })} type="button">↓</button></span><time dateTime={text(stage.document, "due")} title={t("tooltip.milestoneDue")}>{text(stage.document, "due") ? formatDateOnly(locale, text(stage.document, "due")) : "—"}</time><button disabled={readOnly} onClick={onNewTask}>+ {t("core.createTaskAction")}</button></div>
    </header>
    <div className="project-plan-stage-progress"><progress aria-label={t("stages.progressLabel")} max="100" value={progress}>{progress}%</progress><span>{t("stages.progress", { completed, count: allTasks.length })}</span></div>
    <TaskRows allTasks={allTasks} changedTaskIds={changedTaskIds} locale={locale} numberPrefix={stageIndex + 1} onCreate={onCreate} onMoveTask={onMoveTask} onNavigate={onNavigate} onStatusChange={onStatusChange} orderBusy={orderBusy} people={people} projectId={projectId} query={query} readOnly={readOnly} roots={roots} savingTaskIds={savingTaskIds} selectedTaskId={selectedTaskId} statusBusy={statusBusy} statusOptions={statusOptions} statusTitle={statusTitle} taskFields={taskFields} visibleIds={new Set(tasks.map((task) => task.document.id))} text={text} number={number} t={t} />
  </article>;
}

export function TaskRows({ roots, visibleIds, allTasks, projectId, query = {}, locale, people, numberPrefix, readOnly = true, orderBusy = false, selectedTaskId, changedTaskIds = new Set<string>(), savingTaskIds = new Set<string>(), statusTitle, statusOptions = [], statusBusy = false, taskFields, text, number, onMoveTask, onCreate, onStatusChange, onNavigate, t }: {
  readonly roots: readonly TaskViewModelNode[];
  readonly visibleIds: ReadonlySet<string>;
  readonly allTasks: readonly EntityResult[];
  readonly projectId: string;
  readonly query?: Readonly<Record<string, readonly string[]>>;
  readonly locale: Locale;
  readonly people: readonly EntityResult[];
  readonly numberPrefix?: number;
  readonly readOnly?: boolean;
  readonly orderBusy?: boolean;
  readonly selectedTaskId: string;
  readonly changedTaskIds?: ReadonlySet<string>;
  readonly savingTaskIds?: ReadonlySet<string>;
  readonly statusTitle: (slug: string) => string;
  readonly statusOptions?: readonly ConfigValue[];
  readonly statusBusy?: boolean;
  readonly taskFields: TaskFieldVisibility;
  readonly text: ScheduleTextReader;
  readonly number: ScheduleNumberReader;
  readonly onMoveTask?: (taskId: string, offset: -1 | 1) => void;
  readonly onCreate?: (spec: TaskInsertSpec) => void;
  readonly onStatusChange?: (task: EntityResult, status: string) => void;
  readonly onNavigate: WorkspaceNavigate;
  readonly t: Translate;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [openHandle, setOpenHandle] = useState<string | null>(null);
  const taskById = new Map(allTasks.map((task) => [task.document.id, task] as const));
  const nodeById = new Map<string, TaskViewModelNode>();
  const indexNodes = (node: TaskViewModelNode): void => { nodeById.set(node.id, node); for (const child of node.children) indexNodes(child); };
  for (const root of roots) indexNodes(root);
  const reserveDue = taskFields.due && [...nodeById.values()].some((node) => node.due !== undefined);
  const reserveEstimate = taskFields.estimate && [...nodeById.values()].some((node) => node.estimate !== undefined);
  const taskListStyle = {
    "--project-plan-task-meta-columns": [
      ...(taskFields.assignees ? ["minmax(8rem, clamp(10rem, 16vw, 16rem))"] : []),
      ...(reserveDue ? ["6.5rem"] : []),
      ...(reserveEstimate ? ["4.5rem"] : []),
      ...(taskFields.status ? ["7.5rem"] : []),
      ...(onMoveTask === undefined ? [] : ["max-content"]),
    ].join(" ") || "none",
  } as CSSProperties;
  const childrenOf = (parentId: string | undefined): readonly TaskViewModelNode[] => parentId === undefined ? roots : nodeById.get(parentId)?.children ?? [];
  if (visibleIds.size === 0) return <p className="project-plan-empty-tasks">{t("stages.emptyTasks")}</p>;
  const included = new Set<string>();
  for (const id of visibleIds) {
    const node = nodeById.get(id);
    if (node === undefined) continue;
    for (const ancestorId of node.path) included.add(ancestorId);
  }
  interface FlatEntry { readonly node: TaskViewModelNode; readonly parentId: string | undefined; readonly depth: number; readonly hasChildren: boolean }
  const entries: FlatEntry[] = [];
  const ancestorsCollapsed = (node: TaskViewModelNode): boolean => node.path.slice(0, -1).some((ancestorId) => collapsed.has(ancestorId));
  const walk = (node: TaskViewModelNode, parentId: string | undefined, depth: number): void => {
    if (included.has(node.id) && !ancestorsCollapsed(node)) entries.push({ node, parentId, depth, hasChildren: node.children.length > 0 });
    for (const child of node.children) walk(child, node.id, depth + 1);
  };
  for (const root of roots) walk(root, undefined, 0);
  const visibleEntryIds = new Set(entries.map((entry) => entry.node.id));
  return <div className="project-plan-task-list" style={taskListStyle}>{entries.map((entry, index) => {
    const { node } = entry;
    const task = taskById.get(node.id);
    const selected = selectedTaskId === node.id;
    const taskNumber = [...(numberPrefix === undefined ? [] : [numberPrefix]), ...node.path.map((pathId, pathIndex) => childrenOf(pathIndex === 0 ? undefined : node.path[pathIndex - 1]!).findIndex((sibling) => sibling.id === pathId) + 1)].join(".");
    const siblings = childrenOf(entry.parentId);
    const siblingIndex = siblings.findIndex((item) => item.id === node.id);
    const visibleSiblings = siblings.filter((item) => visibleEntryIds.has(item.id));
    const isLastVisibleSibling = visibleSiblings.at(-1)?.id === node.id;
    const nodeChildren = node.children;
    const hasVisibleChildren = nodeChildren.some((child) => visibleEntryIds.has(child.id));
    const completedChildren = nodeChildren.filter((child) => isCompletedStatus(statusOptions, child.status)).length;
    const isContextOnly = !visibleIds.has(node.id);
    const ancestorRailLevels: number[] = [];
    for (let level = 1; level < node.path.length - 1; level++) {
      const ancestorId = node.path[level]!;
      const ancestorSiblings = childrenOf(node.path[level - 1]!);
      const lastVisibleAncestor = [...ancestorSiblings].reverse().find((sibling) => visibleEntryIds.has(sibling.id));
      if (lastVisibleAncestor?.id !== ancestorId) ancestorRailLevels.push(level - 1);
    }
    const style = { "--task-depth": entry.depth, "--task-tree-width": `${entry.depth * .8}rem`, "--task-tree-parent-offset": `${-.4 + Math.max(0, entry.depth - 1) * .8}rem` } as CSSProperties;
    const nextEntry = entries[index + 1];
    const nextTask = nextEntry === undefined ? undefined : taskById.get(nextEntry.node.id);
    const nextParentId = nextEntry?.parentId;
    const insertDepth = nextEntry === undefined ? entry.depth : nextEntry.depth;
    const rows = [<div className={`project-plan-task-row${selected ? " selected" : ""}${isContextOnly ? " filter-context" : ""}${changedTaskIds.has(node.id) ? " recently-changed" : ""}${savingTaskIds.has(node.id) ? " is-saving" : ""}`} data-depth={entry.depth} data-flip-key={`task:${node.id}`} key={node.id} style={style}>
      <span className={`project-plan-task-tree${hasVisibleChildren ? " has-visible-children" : ""}`}>
        {ancestorRailLevels.map((level) => <span aria-hidden="true" className="project-plan-task-ancestor-rail" key={level} style={{ left: `${-.4 + level * .8}rem` }} />)}
        {entry.depth > 0 && <span aria-hidden="true" className={`project-plan-task-branch${isLastVisibleSibling ? " last" : ""}`} />}
        <span className="project-plan-task-tree-control">{entry.hasChildren ? <button aria-expanded={!collapsed.has(node.id)} aria-label={collapsed.has(node.id) ? t("taskHierarchy.expand", { title: node.title }) : t("taskHierarchy.collapse", { title: node.title })} onClick={() => setCollapsed((current) => { const next = new Set(current); if (next.has(node.id)) next.delete(node.id); else next.add(node.id); return next; })} title={collapsed.has(node.id) ? t("taskHierarchy.expand", { title: node.title }) : t("taskHierarchy.collapse", { title: node.title })} type="button"><svg aria-hidden="true" viewBox="0 0 12 12"><path d={collapsed.has(node.id) ? "M4 2.5 8 6 4 9.5" : "m2.5 4 3.5 4 3.5-4"} /></svg></button> : null}</span>
      </span>
      <button aria-current={selected ? "true" : undefined} className="project-plan-task-selector" data-control-hint={t("controlHint.openTaskDetails")} onClick={() => onNavigate("tasks", { projectId, taskId: node.id, ...(Object.keys(query).length > 0 ? { query } : {}) })} type="button"><span className="project-plan-task-kind">{t("projectPlan.taskLabel")} {taskNumber}. <code>{node.id}</code>.</span><strong>{node.title}</strong>{task?.document.lifecycle === "archived" && <small className="archived-reference">{t("core.archived")}</small>}{entry.hasChildren && <small>{t("taskHierarchy.directProgress", { completed: completedChildren, count: nodeChildren.length })}</small>}</button>
      <span className="project-plan-task-meta">
        {taskFields.assignees && <span className="project-plan-task-meta-cell task-assignees" title={t("tooltip.taskAssignees")}><PersonLinks empty={t("core.unassigned")} onOpen={(personId) => onNavigate("people", { personId })} people={people} personIds={node.assignees} /></span>}
        {reserveDue && <span className="project-plan-task-meta-cell project-plan-task-due">{node.due !== undefined && <time dateTime={node.due} title={t("tooltip.taskDue")}>{formatDateOnly(locale, node.due)}</time>}</span>}
        {reserveEstimate && <span className="project-plan-task-meta-cell project-plan-task-estimate">{node.estimate !== undefined && <span title={t("tooltip.taskEstimate")}>{formatDurationHours(locale, node.estimate)}</span>}</span>}
        {taskFields.status && <span className="project-plan-task-meta-cell project-plan-task-status">{onStatusChange === undefined || readOnly || task === undefined ? <span className="state open" title={t("tooltip.taskStatus")}>{statusTitle(node.status)}</span> : <select aria-label={`${t("core.status")}: ${node.title}`} className="inline-status-select" disabled={statusBusy} onChange={(event) => onStatusChange(task, event.target.value)} title={t("tooltip.changeStatus")} value={node.status}>{statusOptions.map((status) => <option key={status.slug} value={status.slug}>{status.title}</option>)}</select>}</span>}
        {onMoveTask !== undefined && <span className="project-plan-task-meta-cell plan-order-controls"><button aria-label={t("projectPlan.moveTaskUp", { number: taskNumber })} disabled={readOnly || orderBusy || siblingIndex === 0} onClick={() => onMoveTask(node.id, -1)} title={t("projectPlan.moveTaskUp", { number: taskNumber })} type="button">↑</button><button aria-label={t("projectPlan.moveTaskDown", { number: taskNumber })} disabled={readOnly || orderBusy || siblingIndex === siblings.length - 1} onClick={() => onMoveTask(node.id, 1)} title={t("projectPlan.moveTaskDown", { number: taskNumber })} type="button">↓</button></span>}
      </span>
    </div>];
    if (onCreate !== undefined && !readOnly && task !== undefined) rows.push(<TaskInsertHandle key={`insert-${node.id}`} anchorTask={task} anchorParentId={entry.parentId} nextTask={nextTask} nextParentId={nextParentId} depth={insertDepth} open={openHandle === node.id} onOpenChange={(next) => setOpenHandle(next ? node.id : null)} onCreate={onCreate} text={text} t={t} />);
    return rows;
  }).flat()}</div>;
}

function TaskInsertHandle({ anchorTask, anchorParentId, nextTask, nextParentId, depth, open, onOpenChange, onCreate, text, t }: {
  readonly anchorTask: EntityResult;
  readonly anchorParentId?: string;
  readonly nextTask?: EntityResult;
  readonly nextParentId?: string;
  readonly depth: number;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreate: (spec: TaskInsertSpec) => void;
  readonly text: ScheduleTextReader;
  readonly t: Translate;
}) {
  const anchorTitle = text(anchorTask.document, "title");
  const nextTitle = nextTask === undefined ? "" : text(nextTask.document, "title");
  const pick = (spec: TaskInsertSpec) => { onOpenChange(false); onCreate(spec); };
  const insertLeft = `${.35 + depth * .8}rem`;
  return <div className={`task-insert-handle${open ? " is-open" : ""}`} style={{ "--insert-left": insertLeft } as CSSProperties}>
    <span className="task-insert-zone" aria-hidden="true" />
    <button aria-expanded={open} aria-haspopup="menu" aria-label={t("taskHierarchy.insertButton")} className="task-insert-button" onClick={() => onOpenChange(!open)} title={t("taskHierarchy.insertButton")} type="button">+</button>
    {open && <>
      <button aria-hidden="true" className="task-insert-menu-backdrop" onClick={() => onOpenChange(false)} tabIndex={-1} type="button" />
      <div className="task-insert-menu" role="menu">
        <button className="task-insert-menu-item" onClick={() => pick({ parentId: anchorTask.document.id })} role="menuitem" type="button">{t("taskHierarchy.insertSubtaskOf", { title: anchorTitle })}</button>
        {nextTask === undefined
          ? <button className="task-insert-menu-item" onClick={() => pick({ parentId: anchorParentId, afterId: anchorTask.document.id })} role="menuitem" type="button">{t("taskHierarchy.insertAfter", { title: anchorTitle })}</button>
          : <button className="task-insert-menu-item" onClick={() => pick({ parentId: nextParentId, beforeId: nextTask.document.id })} role="menuitem" type="button">{t("taskHierarchy.insertBetween", { before: anchorTitle, after: nextTitle })}</button>}
      </div>
    </>}
  </div>;
}
