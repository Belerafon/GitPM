import { finishVarianceDays, resolveSchedulingHierarchy, type SchedulingHierarchyTask } from "@gitpm/scheduling";
import { formatDateOnly, message, type Locale, type MessageKey } from "../../i18n.js";
import type { EntityDocument, EntityResult } from "../../types.js";
import { type ScheduleResolver, trackHasCapability } from "../../schedules.js";
import { SchedulingOverflowWarnings } from "../../scheduling-overflow-warnings.js";
import type { WorkspaceNavigate } from "../../workspace-navigation.js";

/**
 * Validate a candidate comparison-track slug against the §5 guards. The slug is only
 * honoured when it resolves to a real track that is enabled for the project, is manual,
 * supports dates, and is distinct from the primary track. Any other value (unknown slug,
 * disabled track, actual-derived track, primary-track alias) collapses to `undefined` so
 * no raw slug can leak into the card. Returns the validated slug, or `undefined`.
 */
function validateComparisonSlug(scheduling: ScheduleResolver, project: EntityDocument, primaryTrack: string, slug: string | undefined): string | undefined {
  if (slug === undefined || slug === "" || slug === primaryTrack) return undefined;
  const planning = scheduling.planning(project.planning);
  const manualSlugSet = new Set(scheduling.manualTracks(planning).map((track) => track.slug));
  if (!manualSlugSet.has(slug)) return undefined;
  const definition = scheduling.raw?.tracks.find((track) => track.slug === slug);
  if (definition === undefined) return undefined;
  return trackHasCapability(definition, "dates") ? slug : undefined;
}

export function ProjectScheduleSummary({ project, locale, milestones, tasks, scheduling, comparisonTrack, projectId, onNavigate }: { readonly project: EntityDocument; readonly locale: Locale; readonly milestones?: readonly EntityResult[]; readonly tasks?: readonly EntityResult[]; readonly scheduling: ScheduleResolver; readonly comparisonTrack?: string; readonly projectId: string; readonly onNavigate: WorkspaceNavigate }) {
  const primaryTrack = scheduling.primaryTrack(project.planning);
  // Both the explicit `comparisonTrack` prop and the project-configured slug pass through the
  // same validation, so an unknown or disabled slug can never reach the user-facing card.
  const effectiveComparison = validateComparisonSlug(scheduling, project, primaryTrack, comparisonTrack ?? scheduling.comparisonTrack(project.planning));
  const tracks = [...new Set([primaryTrack, effectiveComparison].filter((track): track is string => track !== undefined && track !== ""))];
  // Archived milestones and tasks must not shift the current schedule, generate overflow
  // warnings, or inflate the comparison; only active entities feed the current comparison.
  const activeMilestones = (milestones ?? []).filter((milestone) => milestone.document.lifecycle === "active");
  const activeTasks = (tasks ?? []).filter((task) => task.document.lifecycle === "active");
  const hierarchy = resolveSchedulingHierarchy({
    project,
    milestones: activeMilestones.map((milestone) => milestone.document),
    tasks: activeTasks.map((task): SchedulingHierarchyTask => ({
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
  // The comparison dl block exists only to surface a real comparison finish or the deviation
  // computed from it. Configuring a comparison track without dates, or a primary finish alone,
  // is not enough — the primary finish already lives in the project header and must not be
  // duplicated as an empty card.
  const hasDlRows = effectiveComparison !== undefined && comparisonFinish !== undefined;
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
