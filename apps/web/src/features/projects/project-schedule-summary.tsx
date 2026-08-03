import { finishVarianceDays, resolveSchedulingHierarchy, type SchedulingHierarchyTask } from "@gitpm/scheduling";
import { formatDateOnly, message, type Locale, type MessageKey } from "../../i18n.js";
import type { EntityDocument, EntityResult } from "../../types.js";
import type { ScheduleResolver } from "../../schedules.js";
import { SchedulingOverflowWarnings } from "../../scheduling-overflow-warnings.js";

export function ProjectScheduleSummary({ project, locale, milestones, tasks, scheduling, comparisonTrack }: { readonly project: EntityDocument; readonly locale: Locale; readonly milestones?: readonly EntityResult[]; readonly tasks?: readonly EntityResult[]; readonly scheduling: ScheduleResolver; readonly comparisonTrack?: string }) {
  const primaryTrack = scheduling.primaryTrack(project.planning);
  const workloadTrack = scheduling.workloadTrack(project.planning);
  const comparison = comparisonTrack ?? scheduling.comparisonTrack(project.planning);
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
  const variance = primaryFinish !== undefined && comparisonFinish !== undefined ? finishVarianceDays(primaryFinish, comparisonFinish) : undefined;
  if (comparison === undefined && readModel.overflowWarnings.length === 0) return null;
  const t = (key: MessageKey, values?: Readonly<Record<string, string | number>>) => message(locale, key, values);
  const hasDlRows = (comparison !== undefined && comparisonFinish !== undefined) || (comparison !== undefined && primaryFinish !== undefined) || variance !== undefined;
  return (
    <section className="card project-snapshot">
      <h3>{t("snapshot.heading")}</h3>
      {hasDlRows && <dl>
        {comparison !== undefined && comparisonFinish !== undefined && <div><dt>{t("snapshot.comparisonFinish")}</dt><dd>{formatDateOnly(locale, comparisonFinish)}</dd></div>}
        {comparison !== undefined && primaryFinish !== undefined && <div><dt>{t("snapshot.primaryFinish")}</dt><dd>{formatDateOnly(locale, primaryFinish)}</dd></div>}
        {variance !== undefined && <div><dt>{t("snapshot.variance")}</dt><dd data-variance={variance}>{variance === 0 ? t("snapshot.onTime") : variance > 0 ? `+${variance} d` : `${variance} d`}</dd></div>}
      </dl>}
      <SchedulingOverflowWarnings locale={locale} trackTitle={(track) => scheduling.trackTitle(track)} warnings={readModel.overflowWarnings} />
    </section>
  );
}
