export type TrackKind = "manual" | "actual";
export type TrackCapability = "dates" | "effort" | "dependencies";
export type TrackSource = "time_entries";

export interface TrackDefinition {
  readonly slug: string;
  readonly title: string;
  readonly kind: TrackKind;
  readonly capabilities?: readonly TrackCapability[];
  readonly source?: TrackSource;
}

export interface ScheduleTracksDefaults {
  readonly enabled_tracks?: readonly string[];
  readonly primary_track?: string;
  readonly workload_track?: string;
  readonly comparison_track?: string;
  readonly dashboard_tracks?: readonly string[];
}

export interface ScheduleTracksConfig {
  readonly schema: "gitpm/schedule-tracks@1";
  readonly tracks: readonly TrackDefinition[];
  readonly defaults: ScheduleTracksDefaults;
}

export interface PlanningSettings {
  readonly enabled_tracks: readonly string[];
  readonly primary_track: string;
  readonly workload_track: string;
  readonly comparison_track?: string;
  readonly dashboard_tracks: readonly string[];
}

export interface ScheduleWindow {
  readonly start?: string;
  readonly finish?: string;
  readonly effort_hours?: number;
  readonly depends_on?: readonly string[];
}

export interface Schedulable {
  readonly id: string;
  readonly schedules?: Readonly<Record<string, ScheduleWindow>>;
}

export interface RolledWindow {
  readonly start?: string;
  readonly finish?: string;
  readonly effort_hours: number;
}

export interface CapabilityViolation {
  readonly field: "effort_hours" | "depends_on";
  readonly code: "CAPABILITY_EFFORT_NOT_ALLOWED" | "CAPABILITY_DEPENDENCIES_NOT_ALLOWED";
  readonly track: string;
}

export interface OverflowWarning {
  readonly track: string;
  readonly field: "start" | "finish";
  readonly declared: string;
  readonly rolled: string;
}

export interface PlanningIssue {
  readonly code:
    | "PLANNING_UNKNOWN_TRACK"
    | "PLANNING_PRIMARY_NOT_ENABLED"
    | "PLANNING_WORKLOAD_NOT_ENABLED"
    | "PLANNING_WORKLOAD_NOT_MANUAL"
    | "PLANNING_WORKLOAD_MISSING_EFFORT"
    | "PLANNING_COMPARISON_NOT_ENABLED"
    | "PLANNING_DASHBOARD_UNKNOWN"
    | "PLANNING_PRIMARY_UNDEFINED"
    | "PLANNING_WORKLOAD_UNDEFINED";
  readonly track?: string;
  readonly field: string;
  readonly message: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const DAY_MS = 86_400_000;
const round = (value: number): number => Math.round((value + Number.EPSILON) * 10_000) / 10_000;

function assertIsoDate(value: string, label: string): void {
  if (!ISO_DATE.test(value)) throw new Error(`${label} must be an ISO calendar date (YYYY-MM-DD): ${value}`);
}

export function resolveTrack(config: ScheduleTracksConfig, slug: string): TrackDefinition | undefined {
  return config.tracks.find((track) => track.slug === slug);
}

export function isManualTrack(track: TrackDefinition): boolean {
  return track.kind === "manual";
}

export function isActualTrack(track: TrackDefinition): boolean {
  return track.kind === "actual";
}

export function hasCapability(track: TrackDefinition, capability: TrackCapability): boolean {
  return track.capabilities?.includes(capability) ?? false;
}

export function getWindow(subject: Schedulable, track: string): ScheduleWindow | undefined {
  return subject.schedules?.[track];
}

export function windowCapabilityViolations(window: ScheduleWindow, track: TrackDefinition): readonly CapabilityViolation[] {
  const violations: CapabilityViolation[] = [];
  if (window.effort_hours !== undefined && !hasCapability(track, "effort")) {
    violations.push({ field: "effort_hours", code: "CAPABILITY_EFFORT_NOT_ALLOWED", track: track.slug });
  }
  if (window.depends_on !== undefined && window.depends_on.length > 0 && !hasCapability(track, "dependencies")) {
    violations.push({ field: "depends_on", code: "CAPABILITY_DEPENDENCIES_NOT_ALLOWED", track: track.slug });
  }
  return violations;
}

export function windowDateRangeViolations(window: ScheduleWindow): { code: "DATE_RANGE"; field: "start"; message: string } | undefined {
  if (typeof window.start === "string" && typeof window.finish === "string" && window.start > window.finish) {
    return { code: "DATE_RANGE", field: "start", message: "start must not be after finish" };
  }
  return undefined;
}

export function rollupWindow(subjects: readonly Schedulable[], track: string): RolledWindow | undefined {
  let start: string | undefined;
  let finish: string | undefined;
  let effort = 0;
  let hasEffort = false;
  let contributed = false;
  for (const subject of subjects) {
    const window = subject.schedules?.[track];
    if (window === undefined) continue;
    contributed = true;
    if (typeof window.start === "string" && (start === undefined || window.start < start)) start = window.start;
    if (typeof window.finish === "string" && (finish === undefined || window.finish > finish)) finish = window.finish;
    if (typeof window.effort_hours === "number") {
      effort += window.effort_hours;
      hasEffort = true;
    }
  }
  if (!contributed) return undefined;
  return { start, finish, effort_hours: hasEffort ? round(effort) : 0 };
}

export function declaredWindow(subject: Schedulable, track: string): ScheduleWindow | undefined {
  return subject.schedules?.[track];
}

export function effectiveWindow(subject: Schedulable, track: string, children?: readonly Schedulable[]): ScheduleWindow | RolledWindow | undefined {
  const declared = subject.schedules?.[track];
  if (declared !== undefined) return declared;
  return children === undefined ? undefined : rollupWindow(children, track);
}

export function rollupOverflowWarnings(
  subject: Schedulable,
  children: readonly Schedulable[],
  tracks: readonly string[],
): readonly OverflowWarning[] {
  const warnings: OverflowWarning[] = [];
  for (const track of tracks) {
    const declared = subject.schedules?.[track];
    if (declared === undefined) continue;
    const rolled = rollupWindow(children, track);
    if (rolled === undefined) continue;
    if (typeof declared.start === "string" && typeof rolled.start === "string" && rolled.start < declared.start) {
      warnings.push({ track, field: "start", declared: declared.start, rolled: rolled.start });
    }
    if (typeof declared.finish === "string" && typeof rolled.finish === "string" && rolled.finish > declared.finish) {
      warnings.push({ track, field: "finish", declared: declared.finish, rolled: rolled.finish });
    }
  }
  return warnings;
}

export function daysBetween(start: string, finish: string): number {
  assertIsoDate(start, "start");
  assertIsoDate(finish, "finish");
  return Math.round((Date.parse(`${finish}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS);
}

export function finishVarianceDays(primaryFinish: string, comparisonFinish: string): number {
  return daysBetween(comparisonFinish, primaryFinish);
}

export function isOverdue(finish: string | undefined, today: string): boolean {
  if (finish === undefined) return false;
  assertIsoDate(today, "today");
  return today > finish;
}

export function overdueDays(finish: string | undefined, today: string): number | undefined {
  if (finish === undefined || !isOverdue(finish, today)) return undefined;
  return daysBetween(finish, today);
}

export function dependencyEdges(subject: Schedulable, track: string): readonly string[] {
  return subject.schedules?.[track]?.depends_on ?? [];
}

export function detectCyclesPerTrack(subjects: readonly Schedulable[], track: string): readonly (readonly string[])[] {
  const byId = new Map<string, Schedulable>();
  for (const subject of subjects) byId.set(subject.id, subject);
  const cycles: string[][] = [];
  const cycleKeys = new Set<string>();
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];

  const recordCycle = (fromId: string): void => {
    const index = stack.lastIndexOf(fromId);
    if (index === -1) return;
    const cycle = stack.slice(index);
    const key = [...cycle].sort().join("\n");
    if (!cycleKeys.has(key)) {
      cycleKeys.add(key);
      cycles.push(cycle);
    }
  };

  const walk = (id: string): void => {
    const current = state.get(id);
    if (current === 2) return;
    if (current === 1) {
      recordCycle(id);
      return;
    }
    state.set(id, 1);
    stack.push(id);
    const subject = byId.get(id);
    if (subject !== undefined) {
      for (const target of dependencyEdges(subject, track)) {
        if (byId.has(target)) walk(target);
      }
    }
    stack.pop();
    state.set(id, 2);
  };

  for (const subject of subjects) walk(subject.id);
  return cycles;
}

export function resolvePlanning(config: ScheduleTracksConfig, projectPlanning?: Partial<PlanningSettings>): PlanningSettings {
  const defaults = config.defaults;
  const enabledTracks = projectPlanning?.enabled_tracks ?? defaults.enabled_tracks ?? defaultManualSlugs(config);
  const primaryTrack = projectPlanning?.primary_track ?? defaults.primary_track ?? enabledTracks[0] ?? "";
  const workloadTrack = projectPlanning?.workload_track ?? defaults.workload_track ?? primaryTrack;
  const comparisonTrack = projectPlanning?.comparison_track ?? defaults.comparison_track;
  const dashboardTracks = projectPlanning?.dashboard_tracks ?? defaults.dashboard_tracks ?? enabledTracks;
  return { enabled_tracks: enabledTracks, primary_track: primaryTrack, workload_track: workloadTrack, comparison_track: comparisonTrack, dashboard_tracks: dashboardTracks };
}

function defaultManualSlugs(config: ScheduleTracksConfig): readonly string[] {
  return config.tracks.filter(isManualTrack).map((track) => track.slug);
}

export function validatePlanning(config: ScheduleTracksConfig, planning: PlanningSettings): readonly PlanningIssue[] {
  const issues: PlanningIssue[] = [];
  const known = new Set(config.tracks.map((track) => track.slug));
  const enabled = new Set(planning.enabled_tracks);

  if (planning.primary_track === "") {
    issues.push({ code: "PLANNING_PRIMARY_UNDEFINED", field: "primary_track", message: "primary_track is not defined" });
  }
  if (planning.workload_track === "") {
    issues.push({ code: "PLANNING_WORKLOAD_UNDEFINED", field: "workload_track", message: "workload_track is not defined" });
  }

  for (const slug of [...planning.enabled_tracks, ...planning.dashboard_tracks]) {
    if (!known.has(slug)) issues.push({ code: "PLANNING_UNKNOWN_TRACK", track: slug, field: "enabled_tracks", message: `Unknown track ${slug}` });
  }
  if (planning.primary_track !== "" && !enabled.has(planning.primary_track)) {
    issues.push({ code: "PLANNING_PRIMARY_NOT_ENABLED", track: planning.primary_track, field: "primary_track", message: `primary_track ${planning.primary_track} is not enabled` });
  }
  if (planning.workload_track !== "" && !enabled.has(planning.workload_track)) {
    issues.push({ code: "PLANNING_WORKLOAD_NOT_ENABLED", track: planning.workload_track, field: "workload_track", message: `workload_track ${planning.workload_track} is not enabled` });
  }
  if (planning.workload_track !== "") {
    const track = resolveTrack(config, planning.workload_track);
    if (track !== undefined) {
      if (!isManualTrack(track)) {
        issues.push({ code: "PLANNING_WORKLOAD_NOT_MANUAL", track: planning.workload_track, field: "workload_track", message: `workload_track ${planning.workload_track} must be a manual track` });
      } else if (!hasCapability(track, "dates") || !hasCapability(track, "effort")) {
        issues.push({ code: "PLANNING_WORKLOAD_MISSING_EFFORT", track: planning.workload_track, field: "workload_track", message: `workload_track ${planning.workload_track} needs dates and effort capabilities` });
      }
    }
  }
  if (planning.comparison_track !== undefined && planning.comparison_track !== "" && !enabled.has(planning.comparison_track)) {
    issues.push({ code: "PLANNING_COMPARISON_NOT_ENABLED", track: planning.comparison_track, field: "comparison_track", message: `comparison_track ${planning.comparison_track} is not enabled` });
  }
  for (const slug of planning.dashboard_tracks) {
    if (!enabled.has(slug)) issues.push({ code: "PLANNING_DASHBOARD_UNKNOWN", track: slug, field: "dashboard_tracks", message: `dashboard track ${slug} is not enabled` });
  }
  return issues;
}

export interface GanttTrackBar {
  readonly track: string;
  readonly start: string;
  readonly finish: string;
}

export interface GanttActualSegment {
  readonly date: string;
  readonly hours: number;
}

export interface GanttDependency {
  readonly track: string;
  readonly from: string;
  readonly to: string;
}

export interface GanttRow {
  readonly id: string;
  readonly primary?: GanttTrackBar;
  readonly bars: readonly GanttTrackBar[];
  readonly actual: readonly GanttActualSegment[];
  readonly dependencies: readonly GanttDependency[];
}

export interface GanttModel {
  readonly rows: readonly GanttRow[];
}

export interface BuildGanttOptions {
  readonly primaryTrack: string;
  readonly visibleTracks?: readonly string[];
  readonly dependencyTrack?: string;
  readonly actual?: ReadonlyMap<string, readonly GanttActualSegment[]>;
}

function barFromWindow(track: string, window: ScheduleWindow | RolledWindow | undefined): GanttTrackBar | undefined {
  if (window === undefined) return undefined;
  const start = typeof window.start === "string" ? window.start : undefined;
  const finish = typeof window.finish === "string" ? window.finish : undefined;
  if (start === undefined || finish === undefined) return undefined;
  if (start > finish) return undefined;
  return { track, start, finish };
}

export function buildGanttModel(subjects: readonly Schedulable[], options: BuildGanttOptions): GanttModel {
  const visible = options.visibleTracks ?? [options.primaryTrack];
  const dependencyTrack = options.dependencyTrack ?? options.primaryTrack;
  const rows = subjects.map((subject): GanttRow => {
    const bars = visible.flatMap((track) => {
      const bar = barFromWindow(track, subject.schedules?.[track]);
      return bar === undefined ? [] : [bar];
    });
    const primary = barFromWindow(options.primaryTrack, subject.schedules?.[options.primaryTrack]);
    const actual = options.actual?.get(subject.id) ?? [];
    const dependencies = dependencyEdges(subject, dependencyTrack).map((from) => ({ track: dependencyTrack, from, to: subject.id }));
    return { id: subject.id, primary, bars, actual, dependencies };
  });
  return { rows };
}
