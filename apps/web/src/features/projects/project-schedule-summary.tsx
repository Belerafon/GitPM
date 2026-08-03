import { finishVarianceDays, resolveSchedulingHierarchy, type SchedulingHierarchyTask } from "@gitpm/scheduling";
import { formatDateOnly, message, type Locale, type MessageKey } from "../../i18n.js";
import type { EntityDocument, EntityResult } from "../../types.js";
import type { ScheduleResolver } from "../../schedules.js";
import { SchedulingOverflowWarnings } from "../../scheduling-overflow-warnings.js";
import type { WorkspaceNavigate } from "../../workspace-navigation.js";

export function ProjectScheduleSummary({ project, locale, milestones, tasks, scheduling, comparisonTrack, projectId, onNavigate }: { readonly project: EntityDocument; readonly locale: Locale; readonly milestones?: readonly EntityResult[]; readonly tasks?: readonly EntityResult[]; readonly scheduling: ScheduleResolver; readonly comparisonTrack?: string; readonly projectId: string; readonly onNavigate: WorkspaceNavigate }) {
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
  const openGantt = () => onNavigate("gantt", { projectId });
  const hasDlRows = (comparison !== undefined && comparisonFinish !== undefined) || (comparison !== undefined && primaryFinish !== undefined) || variance !== undefined;
  return (
    <section className="card project-snapshot">
      <div className="project-snapshot-header">
        <h3>{comparison !== undefined ? t("snapshot.comparisonHeading") : t("snapshot.scheduleHeading")}</h3>
        <button className="project-snapshot-gantt" onClick={openGantt} type="button">{t("snapshot.openGantt")}</button>
      </div>
      {hasDlRows && <dl>
        {comparison !== undefined && primaryFinish !== undefined && <div><dt><span className="schedule-track-title">{scheduling.trackTitle(primaryTrack)}</span><span className="schedule-track-role">{t("snapshot.primaryGraph")}</span></dt><dd>{formatDateOnly(locale, primaryFinish)}</dd></div>}
        {comparison !== undefined && comparisonFinish !== undefined && <div><dt><span className="schedule-track-title">{scheduling.trackTitle(comparison)}</span><span className="schedule-track-role">{t("snapshot.comparisonGraph")}</span></dt><dd>{formatDateOnly(locale, comparisonFinish)}</dd></div>}
        {variance !== undefined && <div><dt>{t("snapshot.variance")}</dt><dd data-variance={variance}>{variance === 0 ? t("snapshot.onTime") : variance > 0 ? `+${variance} d` : `${variance} d`}</dd></div>}
      </dl>}
      <SchedulingOverflowWarnings locale={locale} trackTitle={(track) => scheduling.trackTitle(track)} warnings={readModel.overflowWarnings} onOpenGantt={openGantt} />
    </section>
  );
}
