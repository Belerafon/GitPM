import { finishVarianceDays, resolveSchedulingHierarchy, type SchedulingHierarchyTask } from "@gitpm/scheduling";
import { formatDateOnly, message, type Locale, type MessageKey } from "../../i18n.js";
import type { EntityDocument, EntityResult } from "../../types.js";
import type { ScheduleResolver } from "../../schedules.js";
import { SchedulingOverflowWarnings } from "../../scheduling-overflow-warnings.js";
import type { WorkspaceNavigate } from "../../workspace-navigation.js";

export function ProjectScheduleSummary({ project, locale, milestones, tasks, scheduling, comparisonTrack, projectId, onNavigate }: { readonly project: EntityDocument; readonly locale: Locale; readonly milestones?: readonly EntityResult[]; readonly tasks?: readonly EntityResult[]; readonly scheduling: ScheduleResolver; readonly comparisonTrack?: string; readonly projectId: string; readonly onNavigate: WorkspaceNavigate }) {
  const primaryTrack = scheduling.primaryTrack(project.planning);
  const requestedComparison = comparisonTrack ?? scheduling.comparisonTrack(project.planning);
  const effectiveComparison = requestedComparison === undefined || requestedComparison === "" || requestedComparison === primaryTrack ? undefined : requestedComparison;
  const tracks = [...new Set([primaryTrack, effectiveComparison].filter((track): track is string => track !== undefined && track !== ""))];
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
  const comparisonFinish = effectiveComparison === undefined ? undefined : readModel.tracks.find((track) => track.track === effectiveComparison)?.effective?.finish;
  const variance = primaryFinish !== undefined && comparisonFinish !== undefined ? finishVarianceDays(primaryFinish, comparisonFinish) : undefined;
  const hasDlRows = effectiveComparison !== undefined && (comparisonFinish !== undefined || primaryFinish !== undefined || variance !== undefined);
  // The card exists only to surface a comparison row or an overflow warning. A primary
  // finish alone is already shown in the project header, and merely configuring a
  // comparison track is not enough to render an empty card.
  if (readModel.overflowWarnings.length === 0 && !hasDlRows) return null;
  const t = (key: MessageKey, values?: Readonly<Record<string, string | number>>) => message(locale, key, values);
  const openGantt = () => onNavigate("gantt", { projectId });
  const varianceLabel = (days: number): string => days === 0 ? t("snapshot.onTime") : days > 0 ? t("snapshot.varianceAhead", { count: days }) : t("snapshot.varianceBehind", { count: Math.abs(days) });
  return (
    <section className="card project-schedule-summary">
      <div className="project-schedule-summary-header">
        <h3>{effectiveComparison !== undefined ? t("snapshot.comparisonHeading") : t("snapshot.scheduleHeading")}</h3>
        <button className="project-schedule-summary-gantt" onClick={openGantt} type="button">{t("snapshot.openGantt")}</button>
      </div>
      {hasDlRows && <dl>
        {effectiveComparison !== undefined && primaryFinish !== undefined && <div><dt><span className="schedule-track-title">{scheduling.trackTitle(primaryTrack)}</span><span className="schedule-track-role">{t("snapshot.primaryGraph")}</span></dt><dd>{formatDateOnly(locale, primaryFinish)}</dd></div>}
        {effectiveComparison !== undefined && comparisonFinish !== undefined && <div><dt><span className="schedule-track-title">{scheduling.trackTitle(effectiveComparison)}</span><span className="schedule-track-role">{t("snapshot.comparisonGraph")}</span></dt><dd>{formatDateOnly(locale, comparisonFinish)}</dd></div>}
        {variance !== undefined && <div><dt>{t("snapshot.variance")}</dt><dd data-variance={variance}>{varianceLabel(variance)}</dd></div>}
      </dl>}
      <SchedulingOverflowWarnings locale={locale} trackTitle={(track) => scheduling.trackTitle(track)} warnings={readModel.overflowWarnings} onOpenGantt={openGantt} />
    </section>
  );
}
