import { resolvePlanning, type PlanningSettings, type ScheduleTracksConfig } from "@gitpm/scheduling";
import type { ConfigurationDocument, ProjectPlanning } from "@gitpm/contracts";

export interface ScheduleWindowInput {
  readonly start?: string;
  readonly finish?: string;
  readonly effort_hours?: number;
  readonly depends_on?: readonly string[];
}

export type ScheduleMap = Readonly<Record<string, ScheduleWindowInput>>;

type Document = Readonly<Record<string, unknown>>;

function isWindow(value: unknown): value is ScheduleWindowInput {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function schedulesOf(document: Document): Readonly<Record<string, unknown>> | undefined {
  const schedules = document.schedules;
  if (schedules === undefined || typeof schedules !== "object" || Array.isArray(schedules)) return undefined;
  return schedules as Readonly<Record<string, unknown>>;
}

export function scheduleWindow(document: Document, track: string): ScheduleWindowInput | undefined {
  if (track === "") return undefined;
  const window = schedulesOf(document)?.[track];
  return isWindow(window) ? window : undefined;
}

export function scheduleStart(document: Document, track: string): string {
  const start = scheduleWindow(document, track)?.start;
  return typeof start === "string" ? start : "";
}

export function scheduleFinish(document: Document, track: string): string {
  const finish = scheduleWindow(document, track)?.finish;
  return typeof finish === "string" ? finish : "";
}

export function scheduleText(document: Document, key: "start" | "due", track: string): string {
  return key === "start" ? scheduleStart(document, track) : scheduleFinish(document, track);
}

export function scheduleEffort(document: Document, track: string): number | undefined {
  const effort = scheduleWindow(document, track)?.effort_hours;
  return typeof effort === "number" ? effort : undefined;
}

export function scheduleDependencies(document: Document, track: string): readonly string[] {
  const dependsOn = scheduleWindow(document, track)?.depends_on;
  return Array.isArray(dependsOn) ? dependsOn.filter((item): item is string => typeof item === "string") : [];
}

export interface TrackWindow {
  readonly track: string;
  readonly start?: string;
  readonly finish?: string;
  readonly effort_hours?: number;
  readonly depends_on?: readonly string[];
}

export function scheduleWindows(document: Document): readonly TrackWindow[] {
  const schedules = schedulesOf(document);
  if (schedules === undefined) return [];
  const windows: TrackWindow[] = [];
  for (const [track, window] of Object.entries(schedules)) {
    if (isWindow(window)) windows.push({ track, ...window });
  }
  return windows;
}

export function buildSchedule(track: string, start: string, finish: string, effort: string): ScheduleMap | undefined {
  if (track === "") return undefined;
  const window: { start?: string; finish?: string; effort_hours?: number } = {};
  if (start !== "") window.start = start;
  if (finish !== "") window.finish = finish;
  const effortNumber = Number(effort);
  if (effort !== "" && Number.isFinite(effortNumber)) window.effort_hours = effortNumber;
  return Object.keys(window).length === 0 ? undefined : { [track]: window };
}

const EMPTY_PLANNING: PlanningSettings = { enabled_tracks: [], primary_track: "", workload_track: "", dashboard_tracks: [] };

export function scheduleTracksConfig(document: ConfigurationDocument | Document | undefined | null): ScheduleTracksConfig | null {
  if (document === undefined || document === null) return null;
  const schema = (document as { readonly schema?: unknown }).schema;
  if (schema !== "gitpm/schedule-tracks@1") return null;
  const tracks = (document as { readonly tracks?: unknown }).tracks;
  const defaults = (document as { readonly defaults?: unknown }).defaults;
  if (!Array.isArray(tracks) || defaults === undefined || defaults === null || typeof defaults !== "object") return null;
  return { schema: "gitpm/schedule-tracks@1", tracks, defaults } as unknown as ScheduleTracksConfig;
}

export class ScheduleResolver {
  constructor(private readonly config: ScheduleTracksConfig | null) {}

  planning(projectPlanning?: ProjectPlanning): PlanningSettings {
    return this.config === null ? EMPTY_PLANNING : resolvePlanning(this.config, projectPlanning as Partial<PlanningSettings> | undefined);
  }

  primaryTrack(projectPlanning?: ProjectPlanning): string {
    return this.planning(projectPlanning).primary_track;
  }

  workloadTrack(projectPlanning?: ProjectPlanning): string {
    return this.planning(projectPlanning).workload_track;
  }

  comparisonTrack(projectPlanning?: ProjectPlanning): string | undefined {
    return this.planning(projectPlanning).comparison_track;
  }
}

export const EMPTY_RESOLVER = new ScheduleResolver(null);

export function scheduleTextReader(track: string): (document: Document, key: string) => string {
  return (document, key) => key === "start" || key === "due" ? scheduleText(document, key, track) : typeof document[key] === "string" ? document[key] as string : "";
}

export function scheduleEffortReader(track: string): (document: Document) => number | undefined {
  return (document) => scheduleEffort(document, track);
}
