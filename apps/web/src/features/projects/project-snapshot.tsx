import { finishVarianceDays, resolveSchedulingHierarchy, type SchedulingHierarchyTask } from "@gitpm/scheduling";
import { formatDateOnly, message, type Locale, type MessageKey } from "../../i18n.js";
import type { GitPmApi } from "../../api.js";
import type { DraftStatus, EntityDocument, EntityResult } from "../../types.js";
import type { ScheduleResolver } from "../../schedules.js";
import { SchedulingOverflowWarnings } from "../../scheduling-overflow-warnings.js";
import { ProjectActualReport, type ActualReportCategory } from "./project-actual-report.js";

export function ProjectSnapshot({ project, locale, api, categories, draft, milestones, people, tasks, scheduling, comparisonTrack }: { readonly project: EntityDocument; readonly locale: Locale; readonly api?: GitPmApi; readonly categories?: readonly ActualReportCategory[]; readonly draft?: DraftStatus; readonly milestones?: readonly EntityResult[]; readonly people?: readonly EntityResult[]; readonly tasks?: readonly EntityResult[]; readonly scheduling: ScheduleResolver; readonly comparisonTrack?: string }) {
  const primaryTrack = scheduling.primaryTrack(project.planning);
  const workloadTrack = scheduling.workloadTrack(project.planning);
  const comparison = comparisonTrack ?? scheduling.comparisonTrack(project.planning);
  const actualEnabled = scheduling.actualTrack(project.planning)?.source === "time_entries";
  const tracks = [...new Set([primaryTrack, workloadTrack, comparison].filter((track): track is string => track !== undefined && track !== ""))];
  const hierarchy = resolveSchedulingHierarchy({
    project,
    milestones: (milestones ?? []).map((milestone) => milestone.document),
    tasks: (tasks ?? []).map((task): SchedulingHierarchyTask => ({
      ...task.document,
      parent: typeof task.document.parent === "string" && task.document.parent !== "" ? task.document.parent : undefined,
      milestone: typeof task.document.milestone === "string" && task.document.milestone !== "" ? task.document.milestone : undefined,
    })),
    tracks,
  });
  const readModel = hierarchy.readModels.get(project.id)!;
  const primaryFinish = primaryTrack === "" ? undefined : readModel.tracks.find((track) => track.track === primaryTrack)?.effective?.finish;
  const comparisonFinish = comparison === undefined ? undefined : readModel.tracks.find((track) => track.track === comparison)?.effective?.finish;
  const actualAvailable = actualEnabled && api !== undefined && draft !== undefined;
  if (primaryFinish === undefined && comparisonFinish === undefined && !actualAvailable && readModel.overflowWarnings.length === 0) return null;
  const variance = primaryFinish !== undefined && comparisonFinish !== undefined ? finishVarianceDays(primaryFinish, comparisonFinish) : undefined;
  const t = (key: MessageKey, values?: Readonly<Record<string, string | number>>) => message(locale, key, values);
  return (
    <section className="card project-snapshot">
      <h3>{t("snapshot.heading")}</h3>
      <dl>
        {primaryFinish !== undefined && <div><dt>{t("snapshot.primaryFinish")}</dt><dd>{formatDateOnly(locale, primaryFinish)}</dd></div>}
        {comparison !== undefined && comparisonFinish !== undefined && <div><dt>{t("snapshot.comparisonFinish")}</dt><dd>{formatDateOnly(locale, comparisonFinish)}</dd></div>}
        {variance !== undefined && <div><dt>{t("snapshot.variance")}</dt><dd data-variance={variance}>{variance === 0 ? t("snapshot.onTime") : variance > 0 ? `+${variance} d` : `${variance} d`}</dd></div>}
      </dl>
      <SchedulingOverflowWarnings locale={locale} trackTitle={(track) => scheduling.trackTitle(track)} warnings={readModel.overflowWarnings} />
      {actualAvailable && <ProjectActualReport api={api} categories={categories} comparisonFinish={comparisonFinish} draft={draft} locale={locale} milestones={milestones} people={people} projectId={String(project.id)} readModels={hierarchy.readModels} tasks={tasks} workloadTrack={workloadTrack} />}
    </section>
  );
}
