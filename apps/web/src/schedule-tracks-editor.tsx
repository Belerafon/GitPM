import { useId, useRef, useState, type KeyboardEvent } from "react";
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
  readonly showDependencies?: boolean;
  readonly disabled: boolean;
  readonly locale: Locale;
  readonly onChange: (next: ScheduleMap | undefined) => void;
}

export function ScheduleTracksEditor({ schedules, tracks, actualTrack, primaryTrack, dependencies, showDependencies = true, disabled, locale, onChange }: ScheduleTracksEditorProps) {
  const t = (key: MessageKey, values?: Readonly<Record<string, string | number>>): string => message(locale, key, values);
  const editable = tracks.filter((track) => track.kind === "manual");
  const [active, setActive] = useState(primaryTrack || editable[0]?.slug || "");
  const activeTrack = editable.find((track) => track.slug === active) ?? editable[0];
  const multi = editable.length > 1;
  const editorId = useId();
  const tabs = useRef(new Map<string, HTMLButtonElement>());

  if (editable.length === 0) return <p className="schedule-tracks-empty">{t("scheduleTracks.noManualTracks")}</p>;

  const patchField = (track: string, patch: Partial<{ start: string; finish: string; effort_hours: string }>): void => {
    onChange(updateScheduleWindow(schedules, track, patch));
  };
  const selectTrack = (track: TrackDefinition, focus = false): void => {
    setActive(track.slug);
    if (focus) tabs.current.get(track.slug)?.focus();
  };
  const navigateTabs = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let next = index;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % editable.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index - 1 + editable.length) % editable.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = editable.length - 1;
    else return;
    event.preventDefault();
    selectTrack(editable[next]!, true);
  };

  return <section className="schedule-tracks-editor" aria-labelledby={`${editorId}-heading`}>
    <header className="schedule-tracks-heading">
      <h3 id={`${editorId}-heading`}>{t("scheduleTracks.heading")}</h3>
      {multi && <p>{t("scheduleTracks.description")}</p>}
    </header>
    {multi
      ? <div className="schedule-tracks-tabs" role="tablist" aria-label={t("scheduleTracks.track")}>
        {editable.map((track, index) => {
          const selected = activeTrack?.slug === track.slug;
          return <button
            aria-controls={`${editorId}-panel`}
            aria-selected={selected}
            className={selected ? "is-active" : ""}
            data-control-hint={t("controlHint.scheduleTrackTab")}
            id={`${editorId}-tab-${track.slug}`}
            key={track.slug}
            onClick={() => selectTrack(track)}
            onKeyDown={(event) => navigateTabs(event, index)}
            ref={(node) => { if (node === null) tabs.current.delete(track.slug); else tabs.current.set(track.slug, node); }}
            role="tab"
            tabIndex={selected ? 0 : -1}
            type="button"
          >
            <span>{track.title}</span>
            {track.slug === primaryTrack && <> <small>{t("scheduleTracks.primary")}</small></>}
          </button>;
        })}
      </div>
      : activeTrack !== undefined && <div className="schedule-track-single-title"><span>{activeTrack.title}</span>{activeTrack.slug === primaryTrack && <> <small>{t("scheduleTracks.primary")}</small></>}</div>}
    {activeTrack !== undefined && <div aria-labelledby={multi ? `${editorId}-tab-${activeTrack.slug}` : `${editorId}-heading`} id={`${editorId}-panel`} role={multi ? "tabpanel" : undefined}>
      <ScheduleTrackFields track={activeTrack} schedules={schedules} disabled={disabled} locale={locale} allTasks={dependencies} showDependencies={showDependencies} onPatch={(patch) => patchField(activeTrack.slug, patch)} onDependencies={(ids) => onChange(setScheduleDependencies(schedules, activeTrack.slug, ids))} />
    </div>}
    {actualTrack !== undefined && <p className="schedule-tracks-actual-note"><span aria-hidden="true">i</span>{t("scheduleTracks.actualNote", { title: actualTrack.title })}</p>}
  </section>;
}

interface ScheduleTrackFieldsProps {
  readonly track: TrackDefinition;
  readonly schedules: ScheduleMap | undefined;
  readonly disabled: boolean;
  readonly locale: Locale;
  readonly allTasks: readonly EntityResult[];
  readonly showDependencies: boolean;
  readonly onPatch: (patch: Partial<{ start: string; finish: string; effort_hours: string }>) => void;
  readonly onDependencies: (ids: readonly string[]) => void;
}

function ScheduleTrackFields({ track, schedules, disabled, locale, allTasks, showDependencies, onPatch, onDependencies }: ScheduleTrackFieldsProps) {
  const t = (key: MessageKey, values?: Readonly<Record<string, string | number>>): string => message(locale, key, values);
  const window = schedules?.[track.slug];
  const hasDates = track.capabilities?.includes("dates") ?? false;
  const hasEffort = track.capabilities?.includes("effort") ?? false;
  const hasDependencies = showDependencies && (track.capabilities?.includes("dependencies") ?? false);
  const selectedDependencies = Array.isArray(window?.depends_on) ? window.depends_on.filter((item): item is string => typeof item === "string") : [];
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
    {(hasDates || hasEffort) && <div className="schedule-track-grid">
      {hasDates && <>
        <label className="schedule-track-field" data-field-hint={t("fieldHint.scheduleStart")}><span>{t("scheduleTracks.start")}</span><input data-field="start" disabled={disabled} type="date" value={startValue} onChange={(event) => onPatch(buildPatch({ start: event.target.value }))} /></label>
        <label className="schedule-track-field" data-field-hint={t("fieldHint.scheduleFinish")}><span>{t("scheduleTracks.finish")}</span><input data-field="finish" disabled={disabled} type="date" value={finishValue} onChange={(event) => onPatch(buildPatch({ finish: event.target.value }))} /></label>
      </>}
      {hasEffort && <label className="schedule-track-field schedule-track-effort" data-field-hint={t("fieldHint.estimate")}><span>{t("scheduleTracks.estimate")}</span><span className="schedule-effort-control"><input aria-label={t("scheduleTracks.estimate")} data-field="effort_hours" disabled={disabled} min="0" step="0.25" type="number" value={effortValue} onChange={(event) => onPatch(buildPatch({ effort_hours: event.target.value }))} /><span aria-hidden="true">{t("scheduleTracks.hoursShort")}</span></span></label>}
    </div>}
    {hasDependencies && <DependenciesField disabled={disabled} allTasks={allTasks} selected={selectedDependencies} onAdd={(id) => onDependencies([...selectedDependencies, id])} onRemove={(id) => onDependencies(selectedDependencies.filter((item) => item !== id))} t={t} />}
  </div>;
}

interface DependenciesFieldProps {
  readonly disabled: boolean;
  readonly allTasks: readonly EntityResult[];
  readonly selected: readonly string[];
  readonly onAdd: (id: string) => void;
  readonly onRemove: (id: string) => void;
  readonly t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string;
}

function DependenciesField({ disabled, allTasks, selected, onAdd, onRemove, t }: DependenciesFieldProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const headingId = useId();
  const byId = new Map(allTasks.map((task) => [task.document.id, task]));
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const available = allTasks.filter((task) => !selected.includes(task.document.id));
  const matches = available.filter((task) => normalizedQuery === "" || `${titleOf(task)} ${task.document.id}`.toLocaleLowerCase().includes(normalizedQuery));
  const close = () => { setOpen(false); setQuery(""); };
  return <section className="schedule-dependencies-field" aria-labelledby={headingId}>
    <div className="schedule-dependencies-heading">
      <div><h4 data-field-hint={t("fieldHint.dependencies")} id={headingId}>{t("scheduleTracks.dependenciesForTrack")}</h4><p>{t("scheduleTracks.dependenciesHint")}</p></div>
      {!open && <button className="schedule-dependency-open" disabled={disabled || available.length === 0} onClick={() => setOpen(true)} type="button">+ {t("scheduleTracks.addDependency")}</button>}
    </div>
    <div className="schedule-dependencies-current">
      {selected.length === 0 ? <span className="empty-copy">{t("scheduleTracks.noDependencies")}</span> : selected.map((id) => {
        const task = byId.get(id);
        const title = task !== undefined ? titleOf(task) : id;
        return <div className="schedule-dependency-row" key={id}><span><strong>{title}</strong>{task !== undefined && <code>{id}</code>}</span><button type="button" aria-label={t("scheduleTracks.removeDependency", { title })} disabled={disabled} onClick={() => onRemove(id)}>{t("scheduleTracks.remove")}</button></div>;
      })}
    </div>
    {open && <div className="schedule-dependencies-picker">
      <label data-field-hint={t("fieldHint.scheduleDependencySearch")}><span>{t("scheduleTracks.searchDependency")}</span><input autoFocus disabled={disabled} onChange={(event) => setQuery(event.target.value)} placeholder={t("scheduleTracks.searchDependencyPlaceholder")} type="search" value={query} /></label>
      <div className="schedule-dependency-results">
        {matches.length === 0 ? <span className="empty-copy">{t("scheduleTracks.noDependencyMatches")}</span> : matches.map((task) => <button key={task.document.id} onClick={() => { onAdd(task.document.id); close(); }} type="button"><strong>{titleOf(task)}</strong><code>{task.document.id}</code></button>)}
      </div>
      <button className="schedule-dependency-cancel" onClick={close} type="button">{t("core.cancel")}</button>
    </div>}
  </section>;
}
