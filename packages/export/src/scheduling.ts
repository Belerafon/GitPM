import type { GitPmDocument } from "@gitpm/repository-format";
import {
  buildGanttModel,
  resolvePlanning,
  resolveSchedulingHierarchy,
  type GanttModel,
  type ScheduleTracksConfig,
  type ScheduleWindow,
  type SchedulingHierarchyTask,
  type SchedulingReadModel,
} from "@gitpm/scheduling";
import { actualSegments, actualWindow, type TimeEntryRecord } from "@gitpm/time-entries";
import { documentGroups, text, type ExportDocument } from "./documents.js";

export interface ProjectSchedulePlan {
  readonly primary: string;
  readonly workload: string;
  readonly comparison?: string;
  readonly visible: readonly string[];
  readonly titles: ReadonlyMap<string, string>;
}

export interface ExportScheduling {
  readonly plans: ReadonlyMap<string, ProjectSchedulePlan>;
  readonly windows: ReadonlyMap<string, ReadonlyMap<string, ScheduleWindow>>;
  readonly readModels: ReadonlyMap<string, SchedulingReadModel>;
  readonly actual: ReadonlyMap<string, readonly { readonly date: string; readonly hours: number }[]>;
  readonly actualWindows: ReadonlyMap<string, ReturnType<typeof actualWindow>>;
}

function scheduleMap(document: GitPmDocument): Readonly<Record<string, ScheduleWindow>> {
  return document.schedules !== null && typeof document.schedules === "object" && !Array.isArray(document.schedules)
    ? document.schedules as Readonly<Record<string, ScheduleWindow>>
    : {};
}

export function schedulable(document: GitPmDocument, schedules = scheduleMap(document)): SchedulingHierarchyTask {
  const parent = text(document, "parent");
  const milestone = text(document, "milestone");
  return { id: text(document, "id"), schedules, ...(parent === "" ? {} : { parent }), ...(milestone === "" ? {} : { milestone }) };
}

function schedulingConfig(documents: readonly GitPmDocument[]): ScheduleTracksConfig | undefined {
  const document = documents.find((item) => item.schema === "gitpm/schedule-tracks@1");
  if (document === undefined || !Array.isArray(document.tracks) || document.defaults === null || typeof document.defaults !== "object" || Array.isArray(document.defaults)) return undefined;
  const tracks = document.tracks.filter((track): track is ScheduleTracksConfig["tracks"][number] => track !== null && typeof track === "object" && typeof (track as Record<string, unknown>).slug === "string" && typeof (track as Record<string, unknown>).kind === "string" && typeof (track as Record<string, unknown>).title === "string")
    .filter((track) => track.kind === "manual" || track.kind === "actual");
  return tracks.length === 0 ? undefined : { schema: "gitpm/schedule-tracks@1", tracks, defaults: document.defaults as ScheduleTracksConfig["defaults"] };
}

export function buildExportScheduling(documents: readonly ExportDocument[], entries: readonly TimeEntryRecord[]): ExportScheduling {
  const groups = documentGroups(documents);
  const config = schedulingConfig(documents.map((item) => item.document));
  const actual = new Map<string, readonly { readonly date: string; readonly hours: number }[]>();
  const actualWindows = new Map<string, ReturnType<typeof actualWindow>>();
  for (const task of groups.tasks) {
    const taskEntries = entries.filter((entry) => entry.task === text(task, "id"));
    actual.set(text(task, "id"), actualSegments(taskEntries));
    actualWindows.set(text(task, "id"), actualWindow(taskEntries));
  }
  if (config === undefined) return { plans: new Map(), windows: new Map(), readModels: new Map(), actual, actualWindows };
  const plans = new Map<string, ProjectSchedulePlan>();
  const windows = new Map<string, ReadonlyMap<string, ScheduleWindow>>();
  const readModels = new Map<string, SchedulingReadModel>();
  for (const project of groups.projects) {
    const projectId = text(project, "id");
    const planning = resolvePlanning(config, project.planning !== null && typeof project.planning === "object" && !Array.isArray(project.planning) ? project.planning as Parameters<typeof resolvePlanning>[1] : undefined);
    const trackDefinitions = new Map(config.tracks.map((track) => [track.slug, track]));
    const visible = planning.enabled_tracks.filter((track) => trackDefinitions.get(track)?.kind === "manual");
    if (trackDefinitions.get(planning.primary_track)?.kind !== "manual" || !visible.includes(planning.primary_track)) continue;
    const titles = new Map(config.tracks.map((track) => [track.slug, track.title]));
    plans.set(projectId, {
      primary: planning.primary_track,
      workload: planning.workload_track,
      ...(planning.comparison_track === undefined ? {} : { comparison: planning.comparison_track }),
      visible,
      titles,
    });
    const tasks = groups.tasks.filter((task) => text(task, "project") === projectId);
    const milestones = groups.milestones.filter((milestone) => text(milestone, "project") === projectId);
    const hierarchy = resolveSchedulingHierarchy({
      project: schedulable(project),
      milestones: milestones.map((milestone) => schedulable(milestone)),
      tasks: tasks.map((task) => schedulable(task)),
      tracks: [...new Set([...visible, planning.workload_track])],
    });
    for (const [id, model] of hierarchy.readModels) {
      readModels.set(id, model);
      windows.set(id, new Map(model.tracks.flatMap((summary) => summary.effective === undefined ? [] : [[summary.track, summary.effective as ScheduleWindow] as const])));
    }
  }
  return { plans, windows, readModels, actual, actualWindows };
}

export function scheduleWindow(scheduling: ExportScheduling, document: GitPmDocument, track?: string): ScheduleWindow | undefined {
  const projectId = document.schema === "gitpm/project@2" ? text(document, "id") : text(document, "project");
  const plan = scheduling.plans.get(projectId);
  const selected = track ?? plan?.primary;
  return plan === undefined || selected === undefined ? undefined : scheduling.windows.get(text(document, "id"))?.get(selected);
}

export function windowField(scheduling: ExportScheduling, document: GitPmDocument, field: keyof ScheduleWindow, track?: string): string {
  const value = scheduleWindow(scheduling, document, track)?.[field];
  return typeof value === "string" ? value : "";
}

export function projectGantt(tasks: readonly GitPmDocument[], projectId: string, scheduling: ExportScheduling): GanttModel | undefined {
  const plan = scheduling.plans.get(projectId);
  if (plan === undefined) return undefined;
  return buildGanttModel(tasks.map((task) => schedulable(task, Object.fromEntries(scheduling.windows.get(text(task, "id")) ?? []))), {
    primaryTrack: plan.primary,
    visibleTracks: plan.visible,
    actual: scheduling.actual,
  });
}

export function trackTitle(scheduling: ExportScheduling, projectId: string, slug: string): string {
  return scheduling.plans.get(projectId)?.titles.get(slug) ?? slug;
}
