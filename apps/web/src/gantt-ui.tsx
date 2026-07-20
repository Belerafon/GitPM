import { useCallback, useEffect, useId, useMemo, useState } from "react";
import type { GitPmApi } from "./api.js";
import { formatDateOnly, message, type Locale, type MessageKey } from "./i18n.js";
import type { DraftStatus, EntityResult, GitPmDocument } from "./types.js";
import { AsyncBoundary, useAsyncLoad } from "./async-data.js";
import type { WorkspaceNavigate } from "./workspace-navigation.js";

const DAY_MS = 86_400_000;
const GANTT_HEADER_HEIGHT = 42;
const GANTT_ROW_HEIGHT = 58;
const GANTT_BAR_TOP = 51;
const GANTT_BAR_HEIGHT = 36;
const DEPENDENCY_CLEARANCE = 16;
const DEPENDENCY_COLORS = ["#6c5c91", "#b24c63", "#2f6f9f", "#9a5b13", "#8a4f9e", "#c2410c", "#4361a3", "#39796b", "#8b3a3a", "#7a5c00", "#ad3f8c", "#3e6f2b"] as const;
const text = (document: GitPmDocument, key: string) => typeof document[key] === "string" ? document[key] as string : "";
const strings = (value: unknown): readonly string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const dayNumber = (value: string) => Math.floor(Date.parse(`${value}T00:00:00Z`) / DAY_MS);
const isoDate = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);

export function dependencyPath(x1: number, y1: number, x2: number, y2: number): string {
  if (x2 - x1 >= DEPENDENCY_CLEARANCE * 2) {
    return `M ${x1} ${y1} H ${x1 + DEPENDENCY_CLEARANCE} V ${y2} H ${x2}`;
  }
  const rowDirection = Math.sign(y2 - y1) || 1;
  const trackY = y2 - rowDirection * GANTT_ROW_HEIGHT / 2;
  return `M ${x1} ${y1} H ${x1 + DEPENDENCY_CLEARANCE} V ${trackY} H ${x2 - DEPENDENCY_CLEARANCE} V ${y2} H ${x2}`;
}

export interface GanttRow {
  readonly entity: EntityResult;
  readonly id: string;
  readonly title: string;
  readonly start: string;
  readonly due: string;
  readonly startOffset: number;
  readonly duration: number;
  readonly depth: number;
  readonly milestone?: string;
  readonly dependencies: readonly string[];
}

export interface GanttModel {
  readonly start: string;
  readonly due: string;
  readonly days: readonly string[];
  readonly rows: readonly GanttRow[];
  readonly milestones: readonly { readonly id: string; readonly name: string; readonly due: string; readonly offset: number }[];
  readonly dependencies: readonly { readonly from: string; readonly to: string }[];
}

export function buildGanttModel(tasks: readonly EntityResult[], milestones: readonly EntityResult[]): GanttModel | null {
  const dated = tasks.filter((item) => item.document.lifecycle === "active" && /^\d{4}-\d{2}-\d{2}$/u.test(text(item.document, "start")) && /^\d{4}-\d{2}-\d{2}$/u.test(text(item.document, "due")) && dayNumber(text(item.document, "start")) <= dayNumber(text(item.document, "due")));
  if (dated.length === 0) return null;
  const byId = new Map(dated.map((item) => [item.document.id, item]));
  const depth = (item: EntityResult, seen = new Set<string>()): number => {
    const parent = text(item.document, "parent");
    if (parent === "" || seen.has(parent)) return 0;
    const parentEntity = byId.get(parent);
    if (parentEntity === undefined) return 0;
    return 1 + depth(parentEntity, new Set([...seen, item.document.id]));
  };
  const ordered = [...dated].sort((left, right) => {
    const leftParent = text(left.document, "parent"); const rightParent = text(right.document, "parent");
    if (rightParent === left.document.id) return -1;
    if (leftParent === right.document.id) return 1;
    return dayNumber(text(left.document, "start")) - dayNumber(text(right.document, "start")) || text(left.document, "title").localeCompare(text(right.document, "title"));
  });
  const activeMilestones = milestones.filter((item) => item.document.lifecycle === "active" && /^\d{4}-\d{2}-\d{2}$/u.test(text(item.document, "due")));
  const first = Math.min(...dated.map((item) => dayNumber(text(item.document, "start"))), ...activeMilestones.map((item) => dayNumber(text(item.document, "due"))));
  const last = Math.max(...dated.map((item) => dayNumber(text(item.document, "due"))), ...activeMilestones.map((item) => dayNumber(text(item.document, "due"))));
  const days = Array.from({ length: last - first + 1 }, (_, index) => isoDate(first + index));
  const rows = ordered.map((entity): GanttRow => ({
    entity, id: entity.document.id, title: text(entity.document, "title"), start: text(entity.document, "start"), due: text(entity.document, "due"),
    startOffset: dayNumber(text(entity.document, "start")) - first, duration: dayNumber(text(entity.document, "due")) - dayNumber(text(entity.document, "start")) + 1,
    depth: depth(entity), milestone: text(entity.document, "milestone") || undefined, dependencies: strings(entity.document.depends_on).filter((id) => byId.has(id)),
  }));
  return {
    start: isoDate(first), due: isoDate(last), days, rows,
    milestones: activeMilestones.map((item) => ({ id: item.document.id, name: text(item.document, "name"), due: text(item.document, "due"), offset: dayNumber(text(item.document, "due")) - first })),
    dependencies: rows.flatMap((row) => row.dependencies.map((from) => ({ from, to: row.id }))),
  };
}

export function GanttWorkspace({ api, draft, locale, initialProjectId = "", onNavigate = () => undefined }: { readonly api: GitPmApi; readonly draft: DraftStatus; readonly locale: Locale; readonly initialProjectId?: string; readonly onNavigate?: WorkspaceNavigate }) {
  const t = (key: MessageKey, values?: Readonly<Record<string, string | number>>) => message(locale, key, values);
  const markerPrefix = useId().replaceAll(":", "");
  const [projects, setProjects] = useState<readonly EntityResult[]>([]);
  const [tasks, setTasks] = useState<readonly EntityResult[]>([]);
  const [milestones, setMilestones] = useState<readonly EntityResult[]>([]);
  const [projectId, setProjectId] = useState(initialProjectId);
  const [dayWidth, setDayWidth] = useState(36);
  const [error, setError] = useState<string | null>(null);
  const loadRequest = useAsyncLoad();
  const load = useCallback(async (preferredProject = projectId) => {
    await loadRequest.run(async () => {
      const nextProjects = (await api.listEntities(draft.draft_id, "projects")).filter((item) => item.document.lifecycle === "active");
      const nextProject = nextProjects.some((item) => item.document.id === preferredProject) ? preferredProject : nextProjects[0]?.document.id ?? "";
      const [nextTasks, nextMilestones] = nextProject === "" ? [[], []] : await Promise.all([api.listEntities(draft.draft_id, "tasks", nextProject), api.listEntities(draft.draft_id, "milestones", nextProject)]);
      return { nextProjects, nextProject, nextTasks, nextMilestones };
    }, ({ nextProjects, nextProject, nextTasks, nextMilestones }) => {
      setProjects(nextProjects); setProjectId(nextProject); setTasks(nextTasks); setMilestones(nextMilestones); setError(null);
    });
  }, [api, draft.draft_id, loadRequest.run, projectId]);
  useEffect(() => { void load(initialProjectId); }, [draft.draft_id, draft.external_fingerprint]);
  const model = useMemo(() => buildGanttModel(tasks, milestones), [tasks, milestones]);
  const rowIndex = new Map(model?.rows.map((row, index) => [row.id, index]) ?? []);
  const outgoingCounts = new Map<string, number>();
  for (const dependency of model?.dependencies ?? []) outgoingCounts.set(dependency.from, (outgoingCounts.get(dependency.from) ?? 0) + 1);
  const milestoneNames = new Map(milestones.map((item) => [item.document.id, text(item.document, "name")]));
  const timelineWidth = Math.max(720, (model?.days.length ?? 0) * dayWidth);
  const today = new Date().toISOString().slice(0, 10);
  const todayOffset = model?.days.indexOf(today) ?? -1;
  const undatedCount = tasks.filter((item) => item.document.lifecycle === "active" && (!/^\d{4}-\d{2}-\d{2}$/u.test(text(item.document, "start")) || !/^\d{4}-\d{2}-\d{2}$/u.test(text(item.document, "due")))).length;

  return <section className="gantt-workspace">
    <div className="section-heading"><span className="eyebrow draft-context-id">{draft.draft_id}</span><h2 aria-hidden="true">{t("gantt.heading")}</h2><p>{t("gantt.description")}</p></div>
    {error !== null && <div className="alert error">{error}</div>}
    <AsyncBoundary state={loadRequest.state} loading={t("status.loading")} retry={() => { void load(); }} error={(loadError, retry) => <div className="alert error">{loadError}<button onClick={retry}>{t("status.retry")}</button></div>}>
    <>
    <section className="card gantt-toolbar">{initialProjectId === "" && <label>{t("gantt.project")}<select value={projectId} onChange={(event) => onNavigate("gantt", { projectId: event.target.value })}>{projects.map((project) => <option key={project.document.id} value={project.document.id}>{text(project.document, "name")}</option>)}</select></label>}<span>{t("gantt.visible", { count: model?.rows.length ?? 0 })}</span>{model !== null && <time className="gantt-range">{t("gantt.range", { start: formatDateOnly(locale, model.start), due: formatDateOnly(locale, model.due) })}</time>}<label className="gantt-scale">{t("gantt.scale")}<select value={dayWidth} onChange={(event) => setDayWidth(Number(event.target.value))}><option value="24">{t("gantt.scaleMonth")}</option><option value="36">{t("gantt.scaleWeek")}</option><option value="60">{t("gantt.scaleDay")}</option></select></label><span className="state open">{t("gantt.readOnly")}</span></section>
    <div className="gantt-legend" aria-label={t("gantt.legend")}><span className="task">{t("gantt.legendTask")}</span><span className="milestone">{t("gantt.legendMilestone")}</span><span className="dependency">{t("gantt.legendDependency")}</span><span className="today">{t("gantt.legendToday")}</span></div>
    {model === null ? <section className="card empty-workspace"><strong>{t("gantt.empty")}</strong>{undatedCount > 0 && <span>{t("gantt.undatedHint", { count: undatedCount })}</span>}</section> : <section className="card gantt-scroll" aria-label={t("gantt.chart")} data-start={model.start} data-due={model.due}>
      <div className="gantt-labels"><div className="gantt-label-head">{t("gantt.tasks")}</div>{model.rows.map((row) => <div className="gantt-label" key={row.id} style={{ paddingInlineStart: `${.75 + row.depth * 1.1}rem` }}><button className="gantt-task-link" onClick={() => onNavigate("tasks", { projectId, taskId: row.id })}><strong>{row.title}</strong><span>{formatDateOnly(locale, row.start)} — {formatDateOnly(locale, row.due)}</span>{row.milestone !== undefined && <small>{milestoneNames.get(row.milestone)}</small>}</button></div>)}</div>
      <div className="gantt-timeline" style={{ width: `${timelineWidth}px` }}>
        <div className="gantt-days" style={{ gridTemplateColumns: `repeat(${model.days.length}, ${dayWidth}px)` }}>{model.days.map((day) => <time key={day} dateTime={day}><span>{day.slice(8)}</span><small>{day.slice(5, 7)}</small></time>)}</div>
        <div className="gantt-grid" style={{ backgroundSize: `${dayWidth}px 100%` }} />
        {todayOffset >= 0 && <div aria-label={t("gantt.legendToday")} className="gantt-today" style={{ left: `${todayOffset * dayWidth + dayWidth / 2}px` }} />}
        {model.rows.map((row, index) => <button className="gantt-bar" data-task-id={row.id} data-start={row.start} data-due={row.due} key={row.id} title={`${row.title}: ${row.start} — ${row.due}`} style={{ left: `${row.startOffset * dayWidth + 4}px`, top: `${index * GANTT_ROW_HEIGHT + GANTT_BAR_TOP}px`, width: `${Math.max(28, row.duration * dayWidth - 8)}px` }} onClick={() => onNavigate("tasks", { projectId, taskId: row.id })}><span>{row.title}</span></button>)}
        {model.milestones.map((milestone) => <button type="button" className="gantt-milestone" data-milestone-id={milestone.id} key={milestone.id} onClick={() => onNavigate("stages", { projectId, stageId: milestone.id })} title={`${milestone.name}: ${milestone.due}`} style={{ left: `${milestone.offset * dayWidth + 13}px` }}><span>{milestone.name}</span></button>)}
        <svg className="gantt-dependencies" aria-label={t("gantt.dependencies")} height={model.rows.length * GANTT_ROW_HEIGHT + 48} width={timelineWidth}>{model.dependencies.map((dependency, index) => {
          const from = model.rows.find((row) => row.id === dependency.from)!; const to = model.rows.find((row) => row.id === dependency.to)!;
          const x1 = (from.startOffset + from.duration) * dayWidth - 4; const x2 = to.startOffset * dayWidth + 4;
          const y1 = (rowIndex.get(from.id) ?? 0) * GANTT_ROW_HEIGHT + GANTT_BAR_TOP + GANTT_BAR_HEIGHT / 2 - GANTT_HEADER_HEIGHT;
          const y2 = (rowIndex.get(to.id) ?? 0) * GANTT_ROW_HEIGHT + GANTT_BAR_TOP + GANTT_BAR_HEIGHT / 2 - GANTT_HEADER_HEIGHT;
          return <path data-from={from.id} data-to={to.id} key={`${from.id}-${to.id}`} d={dependencyPath(x1, y1, x2, y2)} markerEnd={`url(#${markerPrefix}-gantt-arrow-${index})`} style={{ stroke: DEPENDENCY_COLORS[index % DEPENDENCY_COLORS.length] }} />;
        })}
        {model.rows.filter((row) => (outgoingCounts.get(row.id) ?? 0) > 1).map((row) => {
          const dependencyIndex = model.dependencies.findIndex((dependency) => dependency.from === row.id);
          const x = (row.startOffset + row.duration) * dayWidth - 4 + DEPENDENCY_CLEARANCE;
          const y = (rowIndex.get(row.id) ?? 0) * GANTT_ROW_HEIGHT + GANTT_BAR_TOP + GANTT_BAR_HEIGHT / 2 - GANTT_HEADER_HEIGHT;
          return <circle className="gantt-dependency-branch" data-branch-from={row.id} key={row.id} cx={x} cy={y} r="4" style={{ fill: DEPENDENCY_COLORS[dependencyIndex % DEPENDENCY_COLORS.length] }} />;
        })}
        <defs>{model.dependencies.map((dependency, index) => <marker id={`${markerPrefix}-gantt-arrow-${index}`} key={`${dependency.from}-${dependency.to}`} markerHeight="6" markerWidth="6" orient="auto" refX="5" refY="3"><path d="M0,0 L0,6 L6,3 z" style={{ fill: DEPENDENCY_COLORS[index % DEPENDENCY_COLORS.length] }} /></marker>)}</defs></svg>
      </div>
    </section>}
    </>
    </AsyncBoundary>
  </section>;
}
