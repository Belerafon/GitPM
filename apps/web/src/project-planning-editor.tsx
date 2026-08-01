import { message, type Locale, type MessageKey } from "./i18n.js";
import type { ProjectPlanning } from "@gitpm/contracts";
import type { TrackDefinition } from "@gitpm/scheduling";

const NONE = "__none__";

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
    const comparison = (planning.comparison_track !== undefined && nextSet.has(planning.comparison_track)) ? planning.comparison_track : undefined;
    update({ enabled_tracks: nextEnabled, primary_track: primary, workload_track: workload, comparison_track: comparison, dashboard_tracks: dashboard.filter((slug) => nextSet.has(slug)) });
  };

  return <fieldset className="project-planning-editor">
    <legend>{t("planning.heading")}</legend>
    <div className="planning-field">
      <span className="planning-field-label">{t("planning.enabledTracks")}</span>
      <div className="planning-checkboxes">
        {tracks.map((track) => {
          const cannotDisable = enabledSet.has(track.slug) && track.kind !== "actual" && usedTracks.has(track.slug);
          return <label key={track.slug}><span><input type="checkbox" disabled={disabled || cannotDisable} checked={enabledSet.has(track.slug)} onChange={(event) => setEnabled(toggle(track.slug, event.target.checked))} />{track.title}</span>{cannotDisable && <small>{t("planning.trackInUse")}</small>}</label>;
        })}
      </div>
    </div>
    <label className="planning-field">{t("planning.primaryTrack")}<select disabled={disabled} value={planning.primary_track ?? ""} onChange={(event) => update({ primary_track: event.target.value })}><option value="">{t("planning.none")}</option>{enabledManual.map((track) => <option key={track.slug} value={track.slug}>{track.title}</option>)}</select></label>
    <label className="planning-field">{t("planning.workloadTrack")}<select disabled={disabled} value={planning.workload_track ?? ""} onChange={(event) => update({ workload_track: event.target.value })}><option value="">{t("planning.none")}</option>{enabledWorkload.map((track) => <option key={track.slug} value={track.slug}>{track.title}</option>)}</select></label>
    <label className="planning-field">{t("planning.comparisonTrack")}<select disabled={disabled} value={planning.comparison_track ?? NONE} onChange={(event) => update({ comparison_track: event.target.value === NONE ? undefined : event.target.value })}><option value={NONE}>{t("planning.none")}</option>{enabledForComparison.map((track) => <option key={track.slug} value={track.slug}>{track.title}</option>)}</select></label>
    <div className="planning-field">
      <span className="planning-field-label">{t("planning.dashboardTracks")}</span>
      <div className="planning-checkboxes">
        {enabledForSelect.map((track) => <label key={track.slug}><input type="checkbox" disabled={disabled} checked={dashboardSet.has(track.slug)} onChange={(event) => update({ dashboard_tracks: event.target.checked ? [...dashboard, track.slug] : dashboard.filter((slug) => slug !== track.slug) })} />{track.title}</label>)}
      </div>
    </div>
  </fieldset>;
}

function stripUndefined(value: ProjectPlanning): ProjectPlanning {
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) result[key] = entry;
  }
  return result as unknown as ProjectPlanning;
}
