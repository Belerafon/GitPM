import { useId } from "react";
import { message, type Locale, type MessageKey } from "./i18n.js";
import type { ProjectPlanning } from "@gitpm/contracts";
import type { TrackDefinition } from "@gitpm/scheduling";

const NONE = "__none__";
const CAPABILITY_MESSAGE: Readonly<Record<"dates" | "effort" | "dependencies", MessageKey>> = {
  dates: "admin.capabilityDates",
  effort: "admin.capabilityEffort",
  dependencies: "admin.capabilityDependencies",
};

export interface ProjectPlanningEditorProps {
  readonly planning: ProjectPlanning;
  readonly tracks: readonly TrackDefinition[];
  readonly usedTracks?: ReadonlySet<string>;
  readonly disabled: boolean;
  readonly locale: Locale;
  readonly onChange: (next: ProjectPlanning) => void;
}

export function ProjectPlanningEditor({ planning, tracks, usedTracks = new Set(), disabled, locale, onChange }: ProjectPlanningEditorProps) {
  const t = (key: MessageKey, values?: Readonly<Record<string, string | number>>): string => message(locale, key, values);
  const editorId = useId();
  const enabled = planning.enabled_tracks ?? [];
  const enabledSet = new Set(enabled);
  const manualWithDates = (track: TrackDefinition): boolean => track.kind === "manual" && (track.capabilities?.includes("dates") ?? false);
  const hasDatesEffort = (track: TrackDefinition): boolean => (track.capabilities?.includes("dates") ?? false) && (track.capabilities?.includes("effort") ?? false);
  const enabledManual = tracks.filter((track) => enabledSet.has(track.slug) && manualWithDates(track));
  const enabledWorkload = enabledManual.filter(hasDatesEffort);
  const enabledForSelect = tracks.filter((track) => enabledSet.has(track.slug));
  const enabledForComparison = enabledForSelect.filter(manualWithDates);
  const dashboard = planning.dashboard_tracks ?? enabled;
  const dashboardSet = new Set(dashboard);
  const capabilityTitle = (capability: "dates" | "effort" | "dependencies"): string => t(CAPABILITY_MESSAGE[capability]);
  const trackDescription = (track: TrackDefinition): string => track.kind === "actual"
    ? t("planning.actualTrackHint")
    : t("planning.manualTrackHint", { capabilities: track.capabilities?.map(capabilityTitle).join(", ") || t("planning.noCapabilities") });

  const toggle = (slug: string, checked: boolean): readonly string[] => {
    const next = checked ? [...enabled, slug] : enabled.filter((item) => item !== slug);
    return [...new Set(next)];
  };

  const update = (partial: Partial<ProjectPlanning>): void => {
    const merged: ProjectPlanning = {
      enabled_tracks: enabled,
      primary_track: planning.primary_track,
      workload_track: planning.workload_track,
      comparison_track: planning.comparison_track,
      dashboard_tracks: dashboard,
      ...partial,
    };
    onChange(stripUndefined(merged));
  };

  const setEnabled = (nextEnabled: readonly string[]): void => {
    const nextSet = new Set(nextEnabled);
    const manualChoices = tracks.filter((track) => nextSet.has(track.slug) && manualWithDates(track));
    const workloadChoices = manualChoices.filter(hasDatesEffort);
    const primary = manualChoices.find((track) => track.slug === planning.primary_track)?.slug ?? manualChoices[0]?.slug ?? "";
    const workload = workloadChoices.find((track) => track.slug === planning.workload_track)?.slug ?? workloadChoices[0]?.slug ?? "";
    const comparison = manualChoices.find((track) => track.slug === planning.comparison_track)?.slug;
    update({ enabled_tracks: nextEnabled, primary_track: primary, workload_track: workload, comparison_track: comparison, dashboard_tracks: dashboard.filter((slug) => nextSet.has(slug)) });
  };

  const help = (field: MessageKey, hint: MessageKey) => <button
    aria-label={t("planning.helpFor", { field: t(field) })}
    className="planning-help"
    data-control-hint={t(hint)}
    type="button"
  ><span aria-hidden="true">?</span></button>;

  return <fieldset className="project-planning-editor">
    <legend>{t("planning.heading")}</legend>
    <div className="planning-introduction">
      <strong>{t("planning.introductionTitle")}</strong>
      <p>{t("planning.introduction")}</p>
      <p>{t("planning.customNamesHint")}</p>
    </div>
    <section aria-describedby={`${editorId}-enabled-hint`} aria-labelledby={`${editorId}-enabled-label`} className="planning-field planning-section">
      <div className="planning-label-row"><h3 id={`${editorId}-enabled-label`}>{t("planning.enabledTracks")}</h3>{help("planning.enabledTracks", "planning.enabledTracksHint")}</div>
      <p className="planning-field-help" id={`${editorId}-enabled-hint`}>{t("planning.enabledTracksHint")}</p>
      <div className="planning-checkboxes planning-track-options">
        {tracks.map((track) => {
          const enabledTrack = enabledSet.has(track.slug);
          const inUse = enabledTrack && track.kind !== "actual" && usedTracks.has(track.slug);
          const requiredForPlanning = enabledTrack
            && ((manualWithDates(track) && enabledManual.length === 1) || (manualWithDates(track) && hasDatesEffort(track) && enabledWorkload.length === 1));
          const cannotDisable = inUse || requiredForPlanning;
          return <label className="planning-track-option" data-field-hint={t("fieldHint.enabledTracks")} key={track.slug}>
            <input type="checkbox" disabled={disabled || cannotDisable} checked={enabledTrack} onChange={(event) => setEnabled(toggle(track.slug, event.target.checked))} />
            <span className="planning-track-content">
              <span className="planning-track-heading"><span className="planning-track-name">{track.title}</span><span className={`planning-track-kind ${track.kind}`}>{track.kind === "actual" ? t("admin.actualTrack") : t("admin.manualTrack")}</span></span>
              <small className="planning-track-description">{trackDescription(track)}</small>
              {inUse ? <small className="planning-track-warning">{t("planning.trackInUse")}</small> : requiredForPlanning ? <small className="planning-track-warning">{t("planning.trackRequired")}</small> : null}
            </span>
          </label>;
        })}
      </div>
    </section>
    <section className="planning-section planning-roles">
      <div className="planning-section-heading">
        <h3>{t("planning.rolesTitle")}</h3>
        <p>{t("planning.rolesHint")}</p>
      </div>
      <div className="planning-role-grid">
        <div className="planning-field planning-role-field">
          <div className="planning-label-row"><label htmlFor={`${editorId}-primary`}>{t("planning.primaryTrack")}</label>{help("planning.primaryTrack", "planning.primaryTrackHint")}</div>
          <p className="planning-field-help" id={`${editorId}-primary-hint`}>{t("planning.primaryTrackHint")}</p>
          <select aria-describedby={`${editorId}-primary-hint`} disabled={disabled} id={`${editorId}-primary`} value={planning.primary_track ?? ""} onChange={(event) => update({ primary_track: event.target.value })}>{enabledManual.map((track) => <option key={track.slug} value={track.slug}>{track.title}</option>)}</select>
        </div>
        <div className="planning-field planning-role-field">
          <div className="planning-label-row"><label htmlFor={`${editorId}-workload`}>{t("planning.workloadTrack")}</label>{help("planning.workloadTrack", "planning.workloadTrackHint")}</div>
          <p className="planning-field-help" id={`${editorId}-workload-hint`}>{t("planning.workloadTrackHint")}</p>
          <select aria-describedby={`${editorId}-workload-hint`} disabled={disabled} id={`${editorId}-workload`} value={planning.workload_track ?? ""} onChange={(event) => update({ workload_track: event.target.value })}>{enabledWorkload.map((track) => <option key={track.slug} value={track.slug}>{track.title}</option>)}</select>
        </div>
        <div className="planning-field planning-role-field">
          <div className="planning-label-row"><label htmlFor={`${editorId}-comparison`}>{t("planning.comparisonTrack")}</label>{help("planning.comparisonTrack", "planning.comparisonTrackHint")}</div>
          <p className="planning-field-help" id={`${editorId}-comparison-hint`}>{t("planning.comparisonTrackHint")}</p>
          <select aria-describedby={`${editorId}-comparison-hint`} disabled={disabled} id={`${editorId}-comparison`} value={planning.comparison_track ?? NONE} onChange={(event) => update({ comparison_track: event.target.value === NONE ? undefined : event.target.value })}><option value={NONE}>{t("planning.none")}</option>{enabledForComparison.map((track) => <option key={track.slug} value={track.slug}>{track.title}</option>)}</select>
        </div>
      </div>
    </section>
    <section aria-describedby={`${editorId}-dashboard-hint`} aria-labelledby={`${editorId}-dashboard-label`} className="planning-field planning-section planning-dashboard">
      <div className="planning-label-row"><h3 id={`${editorId}-dashboard-label`}>{t("planning.dashboardTracks")}</h3>{help("planning.dashboardTracks", "planning.dashboardTracksHint")}</div>
      <p className="planning-field-help" id={`${editorId}-dashboard-hint`}>{t("planning.dashboardTracksHint")}</p>
      <div className="planning-dashboard-options">
        {enabledForSelect.map((track) => <label data-field-hint={t("fieldHint.dashboardTracks")} key={track.slug}><input type="checkbox" disabled={disabled} checked={dashboardSet.has(track.slug)} onChange={(event) => update({ dashboard_tracks: event.target.checked ? [...dashboard, track.slug] : dashboard.filter((slug) => slug !== track.slug) })} /><span>{track.title}</span></label>)}
      </div>
    </section>
  </fieldset>;
}

function stripUndefined(value: ProjectPlanning): ProjectPlanning {
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) result[key] = entry;
  }
  return result as unknown as ProjectPlanning;
}
