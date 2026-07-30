import { useState } from "react";
import type { TrackDefinition } from "@gitpm/scheduling";
import { message, type Locale, type MessageKey } from "./i18n.js";
import type { EntityResult } from "./types.js";
import { setScheduleDependencies, updateScheduleWindow, type ScheduleMap } from "./schedules.js";

const stringValue = (document: Readonly<Record<string, unknown>>, key: string): string => typeof document[key] === "string" ? document[key] as string : "";
const titleOf = (task: EntityResult): string => stringValue(task.document, "title") || task.document.id;

export interface ScheduleTracksEditorProps {
  readonly schedules: ScheduleMap | undefined;
  readonly tracks: readonly TrackDefinition[];
  readonly actualTrack?: TrackDefinition;
  readonly primaryTrack: string;
  readonly dependencies: readonly EntityResult[];
  readonly disabled: boolean;
  readonly locale: Locale;
  readonly onChange: (next: ScheduleMap | undefined) => void;
}

export function ScheduleTracksEditor({ schedules, tracks, actualTrack, primaryTrack, dependencies, disabled, locale, onChange }: ScheduleTracksEditorProps) {
  const t = (key: MessageKey, values?: Readonly<Record<string, string | number>>): string => message(locale, key, values);
  const editable = tracks.filter((track) => track.kind === "manual");
  const [active, setActive] = useState(primaryTrack || editable[0]?.slug || "");
  const activeTrack = editable.find((track) => track.slug === active) ?? editable[0];
  const multi = editable.length > 1;

  if (editable.length === 0) return <p className="schedule-tracks-empty">{t("scheduleTracks.noManualTracks")}</p>;

  const patchField = (track: string, patch: Partial<{ start: string; finish: string; effort_hours: string }>): void => {
    onChange(updateScheduleWindow(schedules, track, patch));
  };

  return <fieldset className="schedule-tracks-editor" data-multi={multi || undefined}>
    {multi && <div className="schedule-tracks-tabs" role="tablist" aria-label={t("scheduleTracks.track")}>
      {editable.map((track) => <button type="button" role="tab" key={track.slug} aria-selected={activeTrack?.slug === track.slug} className={activeTrack?.slug === track.slug ? "is-active" : ""} onClick={() => setActive(track.slug)}>{track.title}{track.slug === primaryTrack ? ` · ${t("scheduleTracks.primary")}` : ""}</button>)}
    </div>}
    {activeTrack !== undefined && <ScheduleTrackFields track={activeTrack} schedules={schedules} disabled={disabled} locale={locale} allTasks={dependencies} onPatch={(patch) => patchField(activeTrack.slug, patch)} onDependencies={(ids) => onChange(setScheduleDependencies(schedules, activeTrack.slug, ids))} />}
    {actualTrack !== undefined && <p className="schedule-tracks-actual-note">{t("scheduleTracks.actualNote", { title: actualTrack.title })}</p>}
  </fieldset>;
}

interface ScheduleTrackFieldsProps {
  readonly track: TrackDefinition;
  readonly schedules: ScheduleMap | undefined;
  readonly disabled: boolean;
  readonly locale: Locale;
  readonly allTasks: readonly EntityResult[];
  readonly onPatch: (patch: Partial<{ start: string; finish: string; effort_hours: string }>) => void;
  readonly onDependencies: (ids: readonly string[]) => void;
}

function ScheduleTrackFields({ track, schedules, disabled, locale, allTasks, onPatch, onDependencies }: ScheduleTrackFieldsProps) {
  const t = (key: MessageKey, values?: Readonly<Record<string, string | number>>): string => message(locale, key, values);
  const window = schedules?.[track.slug];
  const hasDates = track.capabilities?.includes("dates") ?? false;
  const hasEffort = track.capabilities?.includes("effort") ?? false;
  const hasDependencies = track.capabilities?.includes("dependencies") ?? false;
  const selectedDependencies = Array.isArray(window?.depends_on) ? window!.depends_on!.filter((item): item is string => typeof item === "string") : [];
  const [adding, setAdding] = useState("");
  const startValue = typeof window?.start === "string" ? window.start : "";
  const finishValue = typeof window?.finish === "string" ? window.finish : "";
  const effortValue = typeof window?.effort_hours === "number" ? String(window.effort_hours) : "";

  const buildPatch = (override: Partial<{ start: string; finish: string; effort_hours: string }>): Partial<{ start: string; finish: string; effort_hours: string }> => {
    const patch: { start?: string; finish?: string; effort_hours?: string } = {};
    if (hasDates) {
      patch.start = override.start !== undefined ? override.start : startValue;
      patch.finish = override.finish !== undefined ? override.finish : finishValue;
    }
    if (hasEffort) patch.effort_hours = override.effort_hours !== undefined ? override.effort_hours : effortValue;
    return patch;
  };

  return <div className="schedule-track-fields" data-track={track.slug}>
    {hasDates && <>
      <label>{t("projectPlan.start")}<input data-field="start" disabled={disabled} type="date" value={startValue} onChange={(event) => onPatch(buildPatch({ start: event.target.value }))} /></label>
      <label>{t("core.due")}<input data-field="finish" disabled={disabled} type="date" value={finishValue} onChange={(event) => onPatch(buildPatch({ finish: event.target.value }))} /></label>
    </>}
    {hasEffort && <label>{t("projectPlan.estimate")}<input data-field="effort_hours" disabled={disabled} min="0" step="0.25" type="number" value={effortValue} onChange={(event) => onPatch(buildPatch({ effort_hours: event.target.value }))} /></label>}
    {hasDependencies && <DependenciesField disabled={disabled} allTasks={allTasks} selected={selectedDependencies} adding={adding} onAdding={setAdding} onAdd={(id) => { onDependencies([...selectedDependencies, id]); setAdding(""); }} onRemove={(id) => onDependencies(selectedDependencies.filter((item) => item !== id))} t={t} />}
  </div>;
}

interface DependenciesFieldProps {
  readonly disabled: boolean;
  readonly allTasks: readonly EntityResult[];
  readonly selected: readonly string[];
  readonly adding: string;
  readonly onAdding: (value: string) => void;
  readonly onAdd: (id: string) => void;
  readonly onRemove: (id: string) => void;
  readonly t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string;
}

function DependenciesField({ disabled, allTasks, selected, adding, onAdding, onAdd, onRemove, t }: DependenciesFieldProps) {
  const byId = new Map(allTasks.map((task) => [task.document.id, task]));
  const available = allTasks.filter((task) => !selected.includes(task.document.id));
  return <fieldset className="schedule-dependencies-field">
    <legend>{t("scheduleTracks.dependencies")}</legend>
    <div className="schedule-dependencies-current">
      {selected.length === 0 ? <span className="empty-copy">{t("scheduleTracks.noDependencies")}</span> : selected.map((id) => {
        const task = byId.get(id);
        const title = task !== undefined ? titleOf(task) : id;
        return <div className="schedule-dependency-row" key={id}><span>{title}</span><button type="button" aria-label={t("scheduleTracks.removeDependency", { title })} disabled={disabled} onClick={() => onRemove(id)}>{t("scheduleTracks.remove")}</button></div>;
      })}
    </div>
    {available.length > 0 && <div className="schedule-dependencies-add">
      <select aria-label={t("scheduleTracks.addDependency")} disabled={disabled} value={adding} onChange={(event) => onAdding(event.target.value)}>
        <option value="">{t("scheduleTracks.addDependency")}</option>
        {available.map((task) => <option key={task.document.id} value={task.document.id}>{titleOf(task)}</option>)}
      </select>
      <button type="button" className="schedule-dependency-add-button" disabled={disabled || adding === ""} onClick={() => { if (adding !== "") onAdd(adding); }}>{t("scheduleTracks.add")}</button>
    </div>}
  </fieldset>;
}
