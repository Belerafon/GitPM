import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { buildGanttModel, resolveSchedulingHierarchy, type GanttActualSegment, type SchedulingHierarchyTask, type TrackDefinition } from "@gitpm/scheduling";
import { scheduleTracksConfig, ScheduleResolver } from "./schedules.js";
import { listAllProjectTimeEntries, type GitPmApi } from "./api.js";
import { buildTaskHierarchy } from "@gitpm/task-hierarchy";
import { formatDateOnly, formatDurationHours, message, type Locale, type MessageKey } from "./i18n.js";
import type { ConfigurationResult, DraftStatus, EntityResult, GitPmDocument } from "./types.js";
import { AsyncBoundary, useAsyncLoad } from "./async-data.js";
import type { WorkspaceNavigate } from "./workspace-navigation.js";

const DAY_MS = 86_400_000;
const GANTT_HEADER_HEIGHT = 42;
const GANTT_ROW_HEIGHT = 58;
const GANTT_BAR_TOP = 51;
const GANTT_BAR_HEIGHT = 36;
const DEPENDENCY_CLEARANCE = 16;
const DEPENDENCY_COLORS = ["#6c5c91", "#b24c63", "#2f6f9f", "#9a5b13", "#8a4f9e", "#c2410c", "#4361a3", "#39796b", "#8b3a3a", "#7a5c00", "#ad3f8c", "#3e6f2b"] as const;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const dayNumber = (value: string) => Math.floor(Date.parse(`${value}T00:00:00Z`) / DAY_MS);
const isoDate = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);
const stringValue = (document: GitPmDocument, key: string) => typeof document[key] === "string" ? document[key] as string : "";
const trackTitle = (tracks: readonly TrackDefinition[], slug: string): string => tracks.find((track) => track.slug === slug)?.title ?? slug;

export function dependencyPath(x1: number, y1: number, x2: number, y2: number): string {
  if (x2 - x1 >= DEPENDENCY_CLEARANCE * 2) {
    return `M ${x1} ${y1} H ${x1 + DEPENDENCY_CLEARANCE} V ${y2} H ${x2}`;
  }
  const rowDirection = Math.sign(y2 - y1) || 1;
  const trackY = y2 - rowDirection * GANTT_ROW_HEIGHT / 2;
  return `M ${x1} ${y1} H ${x1 + DEPENDENCY_CLEARANCE} V ${trackY} H ${x2 - DEPENDENCY_CLEARANCE} V ${y2} H ${x2}`;
}

interface ViewBar { readonly track: string; readonly title: string; readonly start: string; readonly finish: string; readonly offset: number; readonly duration: number; readonly primary: boolean }
interface ViewActual { readonly date: string; readonly hours: number; readonly offset: number }
interface ViewRow {
  readonly entity: EntityResult; readonly id: string; readonly title: string; readonly depth: number; readonly milestone?: string;
  readonly bar?: ViewBar; readonly bars: readonly ViewBar[]; readonly actual: readonly ViewActual[]; readonly dependencies: readonly string[];
}
interface ViewModel {
  readonly start: string; readonly due: string; readonly days: readonly string[]; readonly rows: readonly ViewRow[];
  readonly milestones: readonly { readonly id: string; readonly name: string; readonly due: string; readonly offset: number }[];
  readonly dependencies: readonly { readonly from: string; readonly to: string }[];
}

function rowDateRange(locale: Locale, row: ViewRow): string {
  const start = row.bar?.start ?? row.actual[0]?.date;
  const finish = row.bar?.finish ?? row.actual[row.actual.length - 1]?.date ?? start;
  return start === undefined || finish === undefined ? "" : `${formatDateOnly(locale, start)} — ${formatDateOnly(locale, finish)}`;
}

function aggregateSegments(segments: readonly GanttActualSegment[]): readonly GanttActualSegment[] {
  const byDate = new Map<string, number>();
  for (const segment of segments) {
    if (!ISO_DATE.test(segment.date)) continue;
    byDate.set(segment.date, (byDate.get(segment.date) ?? 0) + segment.hours);
  }
  return [...byDate.entries()].map(([date, hours]) => ({ date, hours: Math.round((hours + Number.EPSILON) * 10_000) / 10_000 })).sort((left, right) => left.date.localeCompare(right.date));
}

export function projectTimelineProjection(tasks: readonly EntityResult[], milestones: readonly EntityResult[], actual: ReadonlyMap<string, readonly GanttActualSegment[]>, tracks: readonly TrackDefinition[], options: { readonly primaryTrack: string; readonly visibleTracks: readonly string[]; readonly dependencyTrack: string }): ViewModel | null {
  const aggregated = new Map<string, readonly GanttActualSegment[]>();
  for (const [id, segments] of actual) aggregated.set(id, aggregateSegments(segments));
  const active = tasks.filter((item) => item.document.lifecycle === "active");
  const modelTracks = [...new Set([...options.visibleTracks, options.primaryTrack, options.dependencyTrack])]
    .filter((slug) => tracks.find((track) => track.slug === slug)?.kind !== "actual");
  const subjects: readonly SchedulingHierarchyTask[] = active.map((item) => ({
    id: item.document.id,
    parent: stringValue(item.document, "parent") || undefined,
    milestone: stringValue(item.document, "milestone") || undefined,
    schedules: item.document.schedules as SchedulingHierarchyTask["schedules"],
  }));
  const activeMilestoneEntities = milestones.filter((item) => item.document.lifecycle === "active");
  const activeMilestoneIds = new Set(activeMilestoneEntities.map((item) => item.document.id));
  // A task pointing at an unknown or archived milestone rolls into the project (milestone =
  // undefined) instead of being dropped, so the Gantt range and deadline stay complete.
  const normalizedSubjects = subjects.map((subject) => ({ ...subject, milestone: subject.milestone !== undefined && activeMilestoneIds.has(subject.milestone) ? subject.milestone : undefined }));
  const milestoneSubjects = activeMilestoneEntities.map((item) => ({ id: item.document.id, schedules: item.document.schedules as SchedulingHierarchyTask["schedules"] }));
  const scheduleHierarchy = resolveSchedulingHierarchy({ tasks: normalizedSubjects, milestones: milestoneSubjects, tracks: modelTracks });
  const ganttMilestones = activeMilestoneEntities.map((item) => {
    const finish = scheduleHierarchy.readModels.get(item.document.id)?.tracks.find((track) => track.track === options.primaryTrack)?.effective?.finish;
    return { id: item.document.id, finish: typeof finish === "string" ? finish : undefined };
  });
  const built = buildGanttModel(subjects.map((subject) => scheduleHierarchy.subjects.get(subject.id) ?? subject), { primaryTrack: options.primaryTrack, visibleTracks: modelTracks, dependencyTrack: options.dependencyTrack, actual: aggregated, milestones: ganttMilestones });
  if (built.range === undefined) return null;
  const first = dayNumber(built.range.start);
  const last = dayNumber(built.range.finish);
  const days = Array.from({ length: last - first + 1 }, (_, index) => isoDate(first + index));
  const byId = new Map(active.map((item) => [item.document.id, item]));
  const shown = built.rows.filter((row) => row.bars.length > 0 || row.actual.length > 0);
  const shownEntities = shown.map((row) => byId.get(row.id)).filter((item): item is EntityResult => item !== undefined);
  const hierarchy = buildTaskHierarchy(shownEntities.map((entity) => ({ id: entity.document.id, parent: stringValue(entity.document, "parent") || undefined, entity })), { order: shownEntities.map((entity) => entity.document.id) });
  const orderedIds = new Set(hierarchy.flatten().map((entry) => entry.task.id));
  const order = new Map(hierarchy.flatten().map((entry, index) => [entry.task.id, index]));
  const viewRows: ViewRow[] = shown
    .filter((row) => orderedIds.has(row.id))
    .map((row): ViewRow => {
      const entity = byId.get(row.id)!;
      const bars: ViewBar[] = row.bars.map((bar) => ({ track: bar.track, title: trackTitle(tracks, bar.track), start: bar.start, finish: bar.finish, offset: dayNumber(bar.start) - first, duration: dayNumber(bar.finish) - dayNumber(bar.start) + 1, primary: bar.track === options.primaryTrack }));
      const primaryBar = bars.find((bar) => bar.primary) ?? bars[0];
      return {
        entity, id: row.id, title: stringValue(entity.document, "title") || row.id, depth: hierarchy.depthOf(row.id),
        milestone: stringValue(entity.document, "milestone") || undefined,
        bar: primaryBar, bars,
        actual: row.actual.filter((segment) => ISO_DATE.test(segment.date)).map((segment): ViewActual => ({ date: segment.date, hours: segment.hours, offset: dayNumber(segment.date) - first })),
        dependencies: row.dependencies.map((dependency) => dependency.from).filter((id) => orderedIds.has(id)),
      };
    })
    .sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0));
  const milestoneFinishes = new Map(ganttMilestones.map((milestone) => [milestone.id, milestone.finish]));
  const activeMilestones = milestones.filter((item) => item.document.lifecycle === "active" && ISO_DATE.test(milestoneFinishes.get(item.document.id) ?? ""));
  return {
    start: isoDate(first), due: isoDate(last), days, rows: viewRows,
    milestones: activeMilestones.map((item) => { const due = milestoneFinishes.get(item.document.id)!; return { id: item.document.id, name: stringValue(item.document, "name"), due, offset: dayNumber(due) - first }; }),
    dependencies: viewRows.flatMap((row) => row.dependencies.map((from) => ({ from, to: row.id }))),
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
  const [actual, setActual] = useState<ReadonlyMap<string, readonly GanttActualSegment[]>>(new Map());
  const [tracksConfig, setTracksConfig] = useState<ConfigurationResult | null>(null);
  const [primaryTrack, setPrimaryTrack] = useState("");
  const [selectedTracks, setSelectedTracks] = useState<ReadonlySet<string>>(new Set());
  const [dependencyTrack, setDependencyTrack] = useState("");
  const loadRequest = useAsyncLoad();
  const load = useCallback(async (preferredProject = projectId) => {
    await loadRequest.run(async () => {
      const [allProjects, tracksDocument] = await Promise.all([api.listEntities(draft.draft_id, "projects"), api.getConfiguration(draft.draft_id, "schedule-tracks")]);
      const nextProjects = allProjects.filter((item) => item.document.lifecycle === "active");
      const nextProject = nextProjects.some((item) => item.document.id === preferredProject) ? preferredProject : nextProjects[0]?.document.id ?? "";
      const resolver = new ScheduleResolver(scheduleTracksConfig(tracksDocument.document));
      const nextProjectDocument = nextProjects.find((item) => item.document.id === nextProject)?.document;
      const actualEnabled = resolver.actualTrack(nextProjectDocument?.planning)?.source === "time_entries";
      const [nextTasks, nextMilestones, nextActual] = nextProject === "" ? [[], [], undefined] : await Promise.all([api.listEntities(draft.draft_id, "tasks", nextProject), api.listEntities(draft.draft_id, "milestones", nextProject), actualEnabled ? listAllProjectTimeEntries(api, draft.draft_id, nextProject) : Promise.resolve([])]);
      return { nextProjects, nextProject, nextTasks, nextMilestones, nextActual, tracksDocument };
    }, ({ nextProjects, nextProject, nextTasks, nextMilestones, nextActual, tracksDocument }) => {
      setProjects(nextProjects); setProjectId(nextProject); setTasks(nextTasks); setMilestones(nextMilestones); setError(null); setTracksConfig(tracksDocument);
      const segments = new Map<string, readonly GanttActualSegment[]>();
      for (const entry of nextActual ?? []) {
        if (entry.document.state === "voided") continue;
        const taskId = entry.document.task;
        segments.set(taskId, [...(segments.get(taskId) ?? []), { date: entry.document.performed_on, hours: entry.document.hours }]);
      }
      setActual(segments);
    });
  }, [api, draft.draft_id, loadRequest.run, projectId]);
  useEffect(() => { void load(initialProjectId); }, [draft.draft_id, draft.external_fingerprint]);
  const scheduling = useMemo(() => new ScheduleResolver(scheduleTracksConfig(tracksConfig?.document)), [tracksConfig]);
  const tracks = useMemo(() => scheduleTracksConfig(tracksConfig?.document)?.tracks ?? [], [tracksConfig]);
  const projectPlanning = projects.find((item) => item.document.id === projectId)?.document.planning;
  const planning = useMemo(() => scheduling.planning(projectPlanning), [scheduling, projectPlanning]);
  const enabledManual = useMemo(() => tracks.filter((track) => track.kind === "manual" && planning.enabled_tracks.includes(track.slug)), [tracks, planning]);
  const dateTracks = useMemo(() => enabledManual.filter((track) => track.capabilities?.includes("dates") ?? false), [enabledManual]);
  const dependencyTracks = useMemo(() => enabledManual.filter((track) => track.capabilities?.includes("dependencies") ?? false), [enabledManual]);
  const actualEnabled = useMemo(() => tracks.some((track) => track.kind === "actual" && track.source === "time_entries" && planning.enabled_tracks.includes(track.slug)), [tracks, planning.enabled_tracks]);
  useEffect(() => {
    const nextPrimary = dateTracks.some((track) => track.slug === planning.primary_track) ? planning.primary_track : dateTracks[0]?.slug ?? "";
    setPrimaryTrack(nextPrimary);
    setSelectedTracks(new Set(planning.dashboard_tracks.filter((slug) => slug !== nextPrimary).filter((slug) => dateTracks.some((track) => track.slug === slug))));
    setDependencyTrack(dependencyTracks.some((track) => track.slug === planning.primary_track) ? planning.primary_track : dependencyTracks[0]?.slug ?? "");
  }, [planning.primary_track, planning.dashboard_tracks, dateTracks, dependencyTracks]);
  const visibleTracks = useMemo(() => {
    const order = [primaryTrack, ...planning.dashboard_tracks, ...dateTracks.map((track) => track.slug)];
    const seen = new Set<string>();
    const result: string[] = [];
    for (const slug of order) {
      if (slug === "" || seen.has(slug)) continue;
      if (!dateTracks.some((track) => track.slug === slug)) continue;
      if (slug !== primaryTrack && !selectedTracks.has(slug)) continue;
      seen.add(slug); result.push(slug);
    }
    return result;
  }, [primaryTrack, selectedTracks, planning.dashboard_tracks, dateTracks]);
  const visibleActual = useMemo(() => actualEnabled ? actual : new Map<string, readonly GanttActualSegment[]>(), [actualEnabled, actual]);
  const model = useMemo(() => projectTimelineProjection(tasks, milestones, visibleActual, tracks, { primaryTrack, visibleTracks, dependencyTrack }), [tasks, milestones, visibleActual, tracks, primaryTrack, visibleTracks, dependencyTrack]);
  const rowIndex = new Map(model?.rows.map((row, index) => [row.id, index]) ?? []);
  const outgoingCounts = new Map<string, number>();
  for (const dependency of model?.dependencies ?? []) outgoingCounts.set(dependency.from, (outgoingCounts.get(dependency.from) ?? 0) + 1);
  const milestoneNames = new Map(milestones.map((item) => [item.document.id, stringValue(item.document, "name")]));
  const timelineWidth = Math.max(720, (model?.days.length ?? 0) * dayWidth);
  const today = new Date().toISOString().slice(0, 10);
  const todayOffset = model?.days.indexOf(today) ?? -1;
  const undatedCount = tasks.filter((item) => item.document.lifecycle === "active" && visibleTracks.every((track) => { const window = (item.document.schedules as Record<string, { start?: string; finish?: string }> | undefined)?.[track]; return typeof window?.start !== "string" || typeof window?.finish !== "string"; })).length;

  return <section className="gantt-workspace">
    <div className="section-heading"><span className="eyebrow draft-context-id">{draft.draft_id}</span><h2 aria-hidden="true">{t("gantt.heading")}</h2><p>{t("gantt.description")}</p></div>
    {error !== null && <div className="alert error">{error}</div>}
    <AsyncBoundary state={loadRequest.state} loading={t("status.loading")} retry={() => { void load(); }} error={(loadError, retry) => <div className="alert error">{loadError}<button onClick={retry}>{t("status.retry")}</button></div>}>
    <>
    <section className="card gantt-toolbar">{initialProjectId === "" && <label>{t("gantt.project")}<select value={projectId} onChange={(event) => onNavigate("gantt", { projectId: event.target.value })}>{projects.map((project) => <option key={project.document.id} value={project.document.id}>{stringValue(project.document, "name")}</option>)}</select></label>}<span>{t("gantt.visible", { count: model?.rows.length ?? 0 })}</span>{model !== null && <time className="gantt-range">{t("gantt.range", { start: formatDateOnly(locale, model.start), due: formatDateOnly(locale, model.due) })}</time>}<label className="gantt-scale">{t("gantt.scale")}<select value={dayWidth} onChange={(event) => setDayWidth(Number(event.target.value))}><option value="24">{t("gantt.scaleMonth")}</option><option value="36">{t("gantt.scaleWeek")}</option><option value="60">{t("gantt.scaleDay")}</option></select></label><span className="state open">{t("gantt.readOnly")}</span></section>
    {(dateTracks.length > 1 || dependencyTracks.length > 0) && <section className="card gantt-track-controls">
      {dateTracks.length > 1 && <label>{t("gantt.primaryTrack")}<select aria-label={t("gantt.primaryTrack")} value={primaryTrack} onChange={(event) => setPrimaryTrack(event.target.value)}>{dateTracks.map((track) => <option key={track.slug} value={track.slug}>{track.title}</option>)}</select></label>}
      {dateTracks.length > 1 && <fieldset className="gantt-additional-tracks"><legend>{t("gantt.additionalTracks")}</legend>{dateTracks.filter((track) => track.slug !== primaryTrack).map((track) => <label key={track.slug}><input checked={selectedTracks.has(track.slug)} onChange={(event) => setSelectedTracks((current) => { const next = new Set(current); if (event.target.checked) next.add(track.slug); else next.delete(track.slug); return next; })} type="checkbox" />{track.title}</label>)}</fieldset>}
      {dependencyTracks.length > 0 && <label>{t("gantt.dependencyTrack")}<select aria-label={t("gantt.dependencyTrack")} value={dependencyTrack} onChange={(event) => setDependencyTrack(event.target.value)}>{dependencyTracks.map((track) => <option key={track.slug} value={track.slug}>{trackTitle(tracks, track.slug)}</option>)}</select></label>}
    </section>}
    <div className="gantt-legend" aria-label={t("gantt.legend")}><span className="task">{t("gantt.legendTask")}</span><span className="milestone">{t("gantt.legendMilestone")}</span><span className="dependency">{t("gantt.legendDependency")}</span><span className="today">{t("gantt.legendToday")}</span></div>
    {model === null ? <section className="card empty-workspace"><strong>{t("gantt.empty")}</strong>{undatedCount > 0 && <span>{t("gantt.undatedHint", { count: undatedCount })}</span>}</section> : <section className="card gantt-scroll" aria-label={t("gantt.chart")} data-start={model.start} data-due={model.due}>
      <div className="gantt-labels"><div className="gantt-label-head">{t("gantt.tasks")}</div>{model.rows.map((row) => <div className="gantt-label" key={row.id} style={{ paddingInlineStart: `${.75 + row.depth * 1.1}rem` }}><button className="gantt-task-link" onClick={() => onNavigate("tasks", { projectId, taskId: row.id })}><strong>{row.title}</strong><span>{rowDateRange(locale, row)}</span>{row.milestone !== undefined && <small>{milestoneNames.get(row.milestone)}</small>}</button></div>)}</div>
      <div className="gantt-timeline" style={{ width: `${timelineWidth}px` }}>
        <div className="gantt-days" style={{ gridTemplateColumns: `repeat(${model.days.length}, ${dayWidth}px)` }}>{model.days.map((day) => <time key={day} dateTime={day}><span>{day.slice(8)}</span><small>{day.slice(5, 7)}</small></time>)}</div>
        <div className="gantt-grid" style={{ backgroundSize: `${dayWidth}px 100%` }} />
        {todayOffset >= 0 && <div aria-label={t("gantt.legendToday")} className="gantt-today" style={{ left: `${todayOffset * dayWidth + dayWidth / 2}px` }} />}
        {model.rows.map((row, index) => row.bar !== undefined && <button className="gantt-bar" data-task-id={row.id} data-start={row.bar.start} data-due={row.bar.finish} key={row.id} title={`${row.title}: ${row.bar.start} — ${row.bar.finish}`} style={{ left: `${row.bar.offset * dayWidth + 4}px`, top: `${index * GANTT_ROW_HEIGHT + GANTT_BAR_TOP}px`, width: `${Math.max(28, row.bar.duration * dayWidth - 8)}px` }} onClick={() => onNavigate("tasks", { projectId, taskId: row.id })}><span>{row.title}</span></button>)}
        {model.rows.flatMap((row, index) => row.bars.filter((bar) => !bar.primary).map((bar) => <div aria-hidden="true" className="gantt-bar-overlay" data-task-id={row.id} data-track={bar.track} key={`${row.id}-${bar.track}`} title={`${row.title} · ${bar.title}: ${bar.start} — ${bar.finish}`} style={{ left: `${bar.offset * dayWidth + 4}px`, top: `${index * GANTT_ROW_HEIGHT + GANTT_BAR_TOP + GANTT_BAR_HEIGHT + 4}px`, width: `${Math.max(6, bar.duration * dayWidth - 8)}px` }} data-start={bar.start} data-finish={bar.finish} />))}
        {model.rows.flatMap((row, index) => row.actual.map((marker) => <div aria-hidden="true" className="gantt-actual-marker" data-task-id={row.id} data-date={marker.date} key={`${row.id}-actual-${marker.date}`} title={`${row.title} · ${marker.date}: ${formatDurationHours(locale, marker.hours)}`} style={{ left: `${marker.offset * dayWidth + dayWidth / 2 - 3}px`, top: `${index * GANTT_ROW_HEIGHT + GANTT_BAR_TOP + GANTT_BAR_HEIGHT + 14}px` }} />))}
        {model.milestones.map((milestone) => <button type="button" className="gantt-milestone" data-milestone-id={milestone.id} key={milestone.id} onClick={() => onNavigate("stages", { projectId, stageId: milestone.id })} title={`${milestone.name}: ${milestone.due}`} style={{ left: `${milestone.offset * dayWidth + 13}px` }}><span>{milestone.name}</span></button>)}
        <svg className="gantt-dependencies" aria-label={t("gantt.dependencies")} height={model.rows.length * GANTT_ROW_HEIGHT + 48} width={timelineWidth}>{model.dependencies.map((dependency, index) => {
          const from = model.rows.find((row) => row.id === dependency.from); const to = model.rows.find((row) => row.id === dependency.to);
          if (from?.bar === undefined || to?.bar === undefined) return null;
          const x1 = (from.bar.offset + from.bar.duration) * dayWidth - 4; const x2 = to.bar.offset * dayWidth + 4;
          const y1 = (rowIndex.get(from.id) ?? 0) * GANTT_ROW_HEIGHT + GANTT_BAR_TOP + GANTT_BAR_HEIGHT / 2 - GANTT_HEADER_HEIGHT;
          const y2 = (rowIndex.get(to.id) ?? 0) * GANTT_ROW_HEIGHT + GANTT_BAR_TOP + GANTT_BAR_HEIGHT / 2 - GANTT_HEADER_HEIGHT;
          return <path data-from={from.id} data-to={to.id} key={`${from.id}-${to.id}`} d={dependencyPath(x1, y1, x2, y2)} markerEnd={`url(#${markerPrefix}-gantt-arrow-${index})`} style={{ stroke: DEPENDENCY_COLORS[index % DEPENDENCY_COLORS.length] }} />;
        })}
        {model.rows.filter((row) => (outgoingCounts.get(row.id) ?? 0) > 1).map((row) => {
          const dependencyIndex = model.dependencies.findIndex((dependency) => dependency.from === row.id);
          if (row.bar === undefined) return null;
          const x = (row.bar.offset + row.bar.duration) * dayWidth - 4 + DEPENDENCY_CLEARANCE;
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
