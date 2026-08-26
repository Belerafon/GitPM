import { useEffect, useMemo, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { buildTaskHierarchy } from "@gitpm/task-hierarchy";
import { formatDateOnly, formatDurationHours, type Locale, type MessageKey } from "./i18n.js";
import type { EntityResult, GitPmDocument } from "./types.js";
import { EntityCatalog } from "./entity-catalog.js";
import { PersonLinks } from "./person-link.js";
import { ProjectLink } from "./project-link.js";
import { MilestoneLink } from "./milestone-link.js";
import { isCompletedStatus, type StatusOption } from "./status-categories.js";
import type { WorkspaceNavigate } from "./workspace-navigation.js";

type ScheduleTextReader = (document: Readonly<Record<string, unknown>>, key: string) => string;

const COLUMNS_STORAGE_KEY = "gitpm.portfolioTasks.columns";
const WIDTHS_STORAGE_KEY = "gitpm.portfolioTasks.columnWidths";
const MIN_COLUMN_WIDTH = 72;
const MAX_COLUMN_WIDTH = 480;
const MAX_TREE_DEPTH = 6;

export const PORTFOLIO_TASK_COLUMNS = ["task", "project", "milestone", "assignees", "due", "estimate", "status", "type"] as const;
export type PortfolioTaskColumn = (typeof PORTFOLIO_TASK_COLUMNS)[number];
type OptionalColumn = Exclude<PortfolioTaskColumn, "task">;

const OPTIONAL_COLUMNS: readonly OptionalColumn[] = ["project", "milestone", "assignees", "due", "estimate", "status", "type"];
const DEFAULT_VISIBILITY: Readonly<Record<OptionalColumn, boolean>> = {
  project: true,
  milestone: true,
  assignees: true,
  due: true,
  estimate: true,
  status: true,
  type: false,
};
const DEFAULT_WIDTHS: Readonly<Record<PortfolioTaskColumn, number>> = {
  task: 280,
  project: 150,
  milestone: 160,
  assignees: 150,
  due: 110,
  estimate: 90,
  status: 130,
  type: 110,
};

interface HierarchyTaskPayload {
  readonly id: string;
  readonly parent?: string;
  readonly entity: EntityResult;
}

interface TableRow {
  readonly task: EntityResult;
  readonly depth: number;
  readonly hasVisibleChildren: boolean;
  readonly collapsed: boolean;
  readonly contextOnly: boolean;
}

interface ColumnResize {
  readonly column: PortfolioTaskColumn;
  readonly pointerId: number;
  readonly startX: number;
  readonly startWidth: number;
}

interface PortfolioTaskSort {
  readonly column: PortfolioTaskColumn;
  readonly direction: "asc" | "desc";
}

const values = (document: GitPmDocument, key: string): string[] => Array.isArray(document[key]) ? (document[key] as unknown[]).filter((item): item is string => typeof item === "string") : [];

const localCalendarDate = (date: Date = new Date()): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const clampWidth = (value: number): number => Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, Math.round(value)));

const readVisibility = (): Record<OptionalColumn, boolean> => {
  try {
    const stored = JSON.parse(localStorage.getItem(COLUMNS_STORAGE_KEY) ?? "{}") as Partial<Record<OptionalColumn, unknown>>;
    return {
      project: stored.project !== false,
      milestone: stored.milestone !== false,
      assignees: stored.assignees !== false,
      due: stored.due !== false,
      estimate: stored.estimate !== false,
      status: stored.status !== false,
      type: stored.type === true,
    };
  } catch {
    return { ...DEFAULT_VISIBILITY };
  }
};

const writeVisibility = (fields: Record<OptionalColumn, boolean>) => {
  try { localStorage.setItem(COLUMNS_STORAGE_KEY, JSON.stringify(fields)); } catch { /* Browser storage may be unavailable. */ }
};

const readWidths = (): Record<PortfolioTaskColumn, number> => {
  try {
    const stored = JSON.parse(localStorage.getItem(WIDTHS_STORAGE_KEY) ?? "{}") as Partial<Record<PortfolioTaskColumn, unknown>>;
    const next = { ...DEFAULT_WIDTHS };
    for (const column of PORTFOLIO_TASK_COLUMNS) {
      const value = stored[column];
      if (typeof value === "number" && Number.isFinite(value)) next[column] = clampWidth(value);
    }
    return next;
  } catch {
    return { ...DEFAULT_WIDTHS };
  }
};

const writeWidths = (widths: Record<PortfolioTaskColumn, number>) => {
  try { localStorage.setItem(WIDTHS_STORAGE_KEY, JSON.stringify(widths)); } catch { /* Browser storage may be unavailable. */ }
};

const emptyValue = (value: string | number | undefined): boolean => value === undefined || value === "";

function compareSortValues(left: string | number | undefined, right: string | number | undefined, locale: string, direction: "asc" | "desc"): number {
  const leftEmpty = emptyValue(left);
  const rightEmpty = emptyValue(right);
  if (leftEmpty || rightEmpty) return leftEmpty === rightEmpty ? 0 : leftEmpty ? 1 : -1;
  const comparison = typeof left === "number" && typeof right === "number"
    ? left - right
    : String(left).localeCompare(String(right), locale, { numeric: true, sensitivity: "base" });
  return direction === "asc" ? comparison : -comparison;
}

function flattenGroup(
  allTasks: readonly EntityResult[],
  visibleTasks: readonly EntityResult[],
  order: readonly string[],
  locale: Locale,
  value: ScheduleTextReader,
  collapseOverrides: Readonly<Record<string, boolean>>,
  sortCompare?: (left: EntityResult, right: EntityResult) => number,
): readonly TableRow[] {
  const hierarchy = buildTaskHierarchy<HierarchyTaskPayload>(allTasks.map((entity) => ({
    id: entity.document.id,
    entity,
    ...(value(entity.document, "parent") === "" ? {} : { parent: value(entity.document, "parent") }),
  })), {
    order,
    compare: (left, right) => {
      const sorted = sortCompare?.(left.entity, right.entity) ?? 0;
      if (sorted !== 0) return sorted;
      return value(left.entity.document, "title").localeCompare(value(right.entity.document, "title"), locale) || left.id.localeCompare(right.id);
    },
  });
  const visibleIds = new Set(visibleTasks.map((task) => task.document.id));
  const includedIds = new Set<string>();
  for (const id of visibleIds) {
    includedIds.add(id);
    for (const ancestor of hierarchy.ancestorsOf(id)) includedIds.add(ancestor.id);
  }
  const collapsed = new Set<string>();
  for (const entry of hierarchy.flatten()) {
    if (entry.hasChildren && hierarchy.childrenOf(entry.task.id).some((child) => includedIds.has(child.id))) collapsed.add(entry.task.id);
  }
  for (const id of visibleIds) {
    const ancestors = hierarchy.ancestorsOf(id);
    if (ancestors.some((ancestor) => !visibleIds.has(ancestor.id))) {
      for (const ancestor of ancestors) collapsed.delete(ancestor.id);
    }
  }
  for (const [id, force] of Object.entries(collapseOverrides)) {
    if (force) collapsed.add(id);
    else collapsed.delete(id);
  }
  return hierarchy.flatten()
    .filter((entry) => includedIds.has(entry.task.id) && !hierarchy.ancestorsOf(entry.task.id).some((ancestor) => collapsed.has(ancestor.id)))
    .map((entry) => ({
      task: entry.task.entity,
      depth: entry.depth,
      hasVisibleChildren: entry.hasChildren && hierarchy.childrenOf(entry.task.id).some((child) => includedIds.has(child.id)),
      collapsed: collapsed.has(entry.task.id),
      contextOnly: !visibleIds.has(entry.task.id),
    }));
}

export function PortfolioTaskTable({
  projects, milestones, tasks, filteredTasks, people, locale, query, readOnly, statusOptions, typeOptions, statusBusy, statusPending, highlights, value, effortOf, statusTitle, onStatusChange, onNavigate, t,
}: {
  readonly projects: readonly EntityResult[];
  readonly milestones: readonly EntityResult[];
  readonly tasks: readonly EntityResult[];
  readonly filteredTasks: readonly EntityResult[];
  readonly people: readonly EntityResult[];
  readonly locale: Locale;
  readonly query: Readonly<Record<string, readonly string[]>>;
  readonly readOnly: boolean;
  readonly statusOptions: readonly StatusOption[];
  readonly typeOptions: readonly StatusOption[];
  readonly statusBusy: boolean;
  readonly statusPending: string | null;
  readonly highlights: Readonly<Record<string, readonly string[]>>;
  readonly value: ScheduleTextReader;
  readonly effortOf: (document: Readonly<Record<string, unknown>>) => number | undefined;
  readonly statusTitle: (slug: string) => string;
  readonly onStatusChange: (task: EntityResult, status: string) => void;
  readonly onNavigate: WorkspaceNavigate;
  readonly t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string;
}) {
  const [collapseOverrides, setCollapseOverrides] = useState<Readonly<Record<string, boolean>>>({});
  const [visibleFields, setVisibleFields] = useState(readVisibility);
  const [widths, setWidths] = useState(readWidths);
  const [sort, setSort] = useState<PortfolioTaskSort | null>(null);
  const [resize, setResize] = useState<ColumnResize | null>(null);
  const catalog = useMemo(() => new EntityCatalog({ projects, milestones, tasks }), [milestones, projects, tasks]);
  const today = localCalendarDate();

  useEffect(() => { writeVisibility(visibleFields); }, [visibleFields]);
  useEffect(() => { writeWidths(widths); }, [widths]);

  const visibleColumns = useMemo<readonly PortfolioTaskColumn[]>(() => ["task", ...OPTIONAL_COLUMNS.filter((column) => visibleFields[column])], [visibleFields]);
  const tableWidth = visibleColumns.reduce((total, column) => total + widths[column], 0);

  const sortCompare = useMemo(() => {
    if (sort === null) return undefined;
    const nameOf = (id: string): string => {
      const person = people.find((item) => item.document.id === id);
      const name = person === undefined ? "" : value(person.document, "name");
      return name === "" ? id : name;
    };
    const sortValue = (task: EntityResult): string | number | undefined => {
      const document = task.document;
      if (sort.column === "task") return value(document, "title");
      if (sort.column === "project") return catalog.project(document.project).name;
      if (sort.column === "milestone") return catalog.milestone(document.milestone)?.name;
      if (sort.column === "assignees") return values(document, "assignees").map(nameOf).join(", ");
      if (sort.column === "due") return value(document, "due");
      if (sort.column === "estimate") return effortOf(document);
      if (sort.column === "status") return statusTitle(value(document, "status"));
      return typeOptions.find((item) => item.slug === value(document, "type"))?.title ?? value(document, "type");
    };
    return (left: EntityResult, right: EntityResult) => compareSortValues(sortValue(left), sortValue(right), locale, sort.direction)
      || left.document.id.localeCompare(right.document.id);
  }, [catalog, effortOf, locale, people, sort, statusTitle, typeOptions, value]);

  const rows = useMemo(() => {
    if (filteredTasks.length === 0) return [];
    const visibleProjectIds = new Set(filteredTasks.map((task) => value(task.document, "project")));
    const visibleProjects = projects.filter((project) => visibleProjectIds.has(project.document.id)).slice().sort((left, right) => value(left.document, "name").localeCompare(value(right.document, "name"), locale) || left.document.id.localeCompare(right.document.id));
    const nextRows: TableRow[] = [];
    for (const project of visibleProjects) {
      const projectTasks = tasks.filter((task) => value(task.document, "project") === project.document.id);
      const visibleProjectTasks = filteredTasks.filter((task) => value(task.document, "project") === project.document.id);
      const projectMilestones = milestones.filter((milestone) => milestone.document.project === project.document.id);
      const milestoneById = new Map(projectMilestones.map((milestone) => [milestone.document.id, milestone] as const));
      const visibleMilestoneIds = new Set(visibleProjectTasks.map((task) => value(task.document, "milestone")).filter((id) => milestoneById.has(id)));
      const milestoneOrder = values(project.document, "milestone_order");
      const visibleMilestones = projectMilestones.filter((milestone) => visibleMilestoneIds.has(milestone.document.id)).slice().sort((left, right) => {
        const leftOrder = milestoneOrder.indexOf(left.document.id);
        const rightOrder = milestoneOrder.indexOf(right.document.id);
        if (leftOrder >= 0 || rightOrder >= 0) {
          if (leftOrder < 0) return 1;
          if (rightOrder < 0) return -1;
          if (leftOrder !== rightOrder) return leftOrder - rightOrder;
        }
        return value(left.document, "name").localeCompare(value(right.document, "name"), locale) || left.document.id.localeCompare(right.document.id);
      });
      for (const milestone of visibleMilestones) {
        nextRows.push(...flattenGroup(
          projectTasks.filter((task) => value(task.document, "milestone") === milestone.document.id),
          visibleProjectTasks.filter((task) => value(task.document, "milestone") === milestone.document.id),
          values(milestone.document, "task_order"),
          locale,
          value,
          collapseOverrides,
          sortCompare,
        ));
      }
      const withoutStage = (task: EntityResult) => !milestoneById.has(value(task.document, "milestone"));
      const visibleWithoutStage = visibleProjectTasks.filter(withoutStage);
      if (visibleWithoutStage.length > 0) {
        nextRows.push(...flattenGroup(projectTasks.filter(withoutStage), visibleWithoutStage, [], locale, value, collapseOverrides, sortCompare));
      }
    }
    return nextRows;
  }, [collapseOverrides, filteredTasks, locale, milestones, projects, sortCompare, tasks, value]);

  const typeTitle = (slug: string): string => typeOptions.find((item) => item.slug === slug)?.title ?? slug;

  const columnLabel = (column: PortfolioTaskColumn): string => {
    if (column === "task") return t("portfolioTasks.columnTask");
    if (column === "project") return t("core.project");
    if (column === "milestone") return t("core.milestone");
    if (column === "assignees") return t("core.assignees");
    if (column === "due") return t("core.due");
    if (column === "estimate") return t("projectPlan.estimate");
    if (column === "status") return t("core.status");
    return t("core.type");
  };

  const toggleSort = (column: PortfolioTaskColumn) => {
    setSort((current) => {
      if (current === null || current.column !== column) return { column, direction: "asc" };
      if (current.direction === "asc") return { column, direction: "desc" };
      return null;
    });
  };

  const beginResize = (column: PortfolioTaskColumn, event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* pointer capture unavailable */ }
    setResize({ column, pointerId: event.pointerId, startX: event.clientX, startWidth: widths[column] });
  };
  const moveResize = (event: ReactPointerEvent<HTMLElement>) => {
    if (resize === null || event.pointerId !== resize.pointerId) return;
    setWidths((current) => ({ ...current, [resize.column]: clampWidth(resize.startWidth + (event.clientX - resize.startX)) }));
  };
  const endResize = (event: ReactPointerEvent<HTMLElement>) => {
    if (resize === null || event.pointerId !== resize.pointerId) return;
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* pointer capture unavailable */ }
    setResize(null);
  };
  const resizeByKey = (column: PortfolioTaskColumn, event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const step = event.shiftKey ? 40 : 16;
      setWidths((current) => ({ ...current, [column]: clampWidth(current[column] + (event.key === "ArrowRight" ? step : -step)) }));
    } else if (event.key === "Home") {
      event.preventDefault();
      setWidths((current) => ({ ...current, [column]: MIN_COLUMN_WIDTH }));
    } else if (event.key === "End") {
      event.preventDefault();
      setWidths((current) => ({ ...current, [column]: MAX_COLUMN_WIDTH }));
    } else if (event.key === "Enter") {
      event.preventDefault();
      setWidths((current) => ({ ...current, [column]: DEFAULT_WIDTHS[column] }));
    }
  };

  if (filteredTasks.length === 0) return <p className="portfolio-task-empty">{t("core.empty")}</p>;

  return <div className={`portfolio-task-table-shell${resize === null ? "" : " is-resizing"}`}>
    <div className="portfolio-task-table-toolbar">
      <details className="task-field-settings">
        <summary>{t("portfolioTasks.configureColumns")}</summary>
        <div>
          <p>{t("portfolioTasks.configureColumnsDescription")}</p>
          {OPTIONAL_COLUMNS.map((column) => <label data-field-hint={t("fieldHint.portfolioTaskColumns")} key={column}><input checked={visibleFields[column]} onChange={(event) => setVisibleFields((current) => ({ ...current, [column]: event.target.checked }))} type="checkbox" />{columnLabel(column)}</label>)}
        </div>
      </details>
    </div>
    <div className="portfolio-task-table-wrap">
      <table aria-label={t("core.allTasks")} className="portfolio-task-table" style={{ width: tableWidth } as CSSProperties}>
        <colgroup>{visibleColumns.map((column) => <col key={column} style={{ width: widths[column] }} />)}</colgroup>
        <thead>
          <tr>
            {visibleColumns.map((column) => {
              const label = columnLabel(column);
              const ariaSort = sort?.column === column ? (sort.direction === "asc" ? "ascending" : "descending") : "none";
              return <th aria-sort={ariaSort} key={column} scope="col">
                <button onClick={() => toggleSort(column)} type="button">{label}</button>
                <span aria-label={t("portfolioTasks.resizeColumn", { column: label })} aria-orientation="vertical" className="portfolio-task-resize" onKeyDown={(event) => resizeByKey(column, event)} onPointerCancel={endResize} onPointerDown={(event) => beginResize(column, event)} onPointerMove={moveResize} onPointerUp={endResize} role="separator" tabIndex={0} />
              </th>;
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const task = row.task;
            const due = value(task.document, "due");
            const estimate = effortOf(task.document);
            const assignees = values(task.document, "assignees");
            const projectId = value(task.document, "project");
            const milestone = catalog.milestone(task.document.milestone);
            const overdue = /^\d{4}-\d{2}-\d{2}$/u.test(due) && due < today && !isCompletedStatus(statusOptions, value(task.document, "status"));
            const rowClass = `portfolio-task-row${row.contextOnly ? " filter-context" : ""}${statusPending === task.document.id ? " is-saving" : ""}${highlights[task.document.id]?.includes("$local") ? " recently-changed" : highlights[task.document.id] ? " external-update" : ""}`;
            return <tr className={rowClass} data-depth={row.depth} data-milestone-id={milestone?.id ?? ""} data-project-id={projectId} data-task-id={task.document.id} key={task.document.id} style={{ "--portfolio-task-depth": Math.min(row.depth, MAX_TREE_DEPTH) } as CSSProperties}>
              {visibleColumns.map((column) => {
                if (column === "task") return <th key={column} scope="row"><div className="portfolio-task-title">
                  <span className="portfolio-task-indent" aria-hidden="true" />
                  <span className="portfolio-task-collapse">{row.hasVisibleChildren && <button aria-expanded={!row.collapsed} aria-label={row.collapsed ? t("taskHierarchy.expand", { title: value(task.document, "title") }) : t("taskHierarchy.collapse", { title: value(task.document, "title") })} onClick={() => setCollapseOverrides((current) => ({ ...current, [task.document.id]: !row.collapsed }))} type="button"><svg aria-hidden="true" viewBox="0 0 12 12"><path d={row.collapsed ? "M4 2.5 8 6 4 9.5" : "m2.5 4 3.5 4 3.5-4"} /></svg></button>}</span>
                  <button className="portfolio-task-selector" onClick={() => onNavigate("tasks", { projectId, taskId: task.document.id, query })} title={t("tooltip.openTask")} type="button"><span className="portfolio-task-name">{value(task.document, "title")}</span><span><code>{task.document.id}</code>{row.contextOnly && <small>{t("portfolioTasks.filterContext")}</small>}{task.document.lifecycle === "archived" && <small>{t("core.archived")}</small>}</span></button>
                </div></th>;
                if (column === "project") return <td key={column}><ProjectLink name={catalog.project(projectId).name} onOpen={(nextProjectId) => onNavigate("projects", { projectId: nextProjectId })} projectId={projectId} /></td>;
                if (column === "milestone") return <td key={column}>{milestone === undefined
                  ? t("stages.withoutStage")
                  : <MilestoneLink milestoneId={milestone.id} name={milestone.name} onOpen={(milestoneId) => onNavigate("stages", { projectId, stageId: milestoneId, query })} />}</td>;
                if (column === "assignees") return <td className="portfolio-task-assignees" key={column} title={t(assignees.length === 0 ? "tooltip.taskUnassigned" : "tooltip.taskAssignees")}><PersonLinks empty={t("core.unassigned")} onOpen={(personId) => onNavigate("people", { personId })} people={people} personIds={assignees} /></td>;
                if (column === "due") return <td className={`portfolio-task-date${overdue ? " is-overdue" : ""}`} key={column} title={t(due === "" ? "tooltip.taskDueMissing" : overdue ? "portfolioTasks.presetOverdue" : "tooltip.taskDue")}>{due === "" ? "—" : <time dateTime={due}>{formatDateOnly(locale, due)}</time>}</td>;
                if (column === "estimate") return <td className="portfolio-task-estimate" key={column} title={t(estimate === undefined ? "tooltip.taskEstimateMissing" : "tooltip.taskEstimate")}>{estimate === undefined ? "—" : formatDurationHours(locale, estimate)}</td>;
                if (column === "status") return <td key={column}>{readOnly
                  ? <span className="state open" title={t("tooltip.taskStatus")}>{statusTitle(value(task.document, "status"))}</span>
                  : <select aria-label={`${t("core.status")}: ${value(task.document, "title")}`} className="inline-status-select" disabled={statusBusy} onChange={(event) => onStatusChange(task, event.target.value)} title={t("tooltip.changeStatus")} value={value(task.document, "status")}>{statusOptions.map((status) => <option key={status.slug} value={status.slug}>{status.title}</option>)}</select>}</td>;
                return <td key={column}>{typeTitle(value(task.document, "type"))}</td>;
              })}
            </tr>;
          })}
        </tbody>
      </table>
    </div>
  </div>;
}
