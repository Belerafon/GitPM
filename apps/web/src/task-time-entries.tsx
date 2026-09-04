import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { actualWindow, sumHours } from "@gitpm/time-entries";
import { formatApiError, type GitPmApiPort } from "./api.js";
import { formatDateOnly, formatDurationHours, message, type Locale, type MessageKey } from "./i18n.js";
import type { DraftStatus, EntityResult } from "./types.js";
import type { TimeEntryResult } from "./api.js";
import { EditorDrawer } from "./editor-drawer.js";
import { PersonLink } from "./person-link.js";
import { ProjectFileMarkdownField, type ProjectFileReferenceContext } from "./project-file-reference-ui.js";
import { SafeMarkdown } from "./safe-markdown.js";
import { usePersonNameFormatter } from "./person-name.js";

interface WorkCategory { readonly slug: string; readonly title: string; readonly active: boolean }
interface TimeEntryCorrection { readonly person: string; readonly performed_on: string; readonly hours: number; readonly category: string; readonly note: string }

const NO_ASSIGNEES: readonly string[] = [];

function todayISODate(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function TaskTimeEntries(props: {
  readonly api: GitPmApiPort<"createTimeEntry" | "getConfiguration" | "getEntity" | "listTimeEntries" | "replaceTimeEntry" | "voidTimeEntry">;
  readonly draft: DraftStatus;
  readonly fileContext?: ProjectFileReferenceContext;
  readonly fingerprint: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly people: readonly EntityResult[];
  readonly readOnly: boolean;
  readonly locale: Locale;
  readonly assigneeIds?: readonly string[];
  readonly onFingerprintChange: (fingerprint: string) => Promise<void>;
  readonly onOpenPerson?: (personId: string) => void;
}) {
  const { api, draft, fileContext, projectId, taskId, people, readOnly, locale, onOpenPerson, assigneeIds = NO_ASSIGNEES } = props;
  const t = (key: MessageKey, values?: Readonly<Record<string, string | number>>) => message(locale, key, values);
  const formatEmployeeName = usePersonNameFormatter();
  const [entries, setEntries] = useState<readonly TimeEntryResult[]>([]);
  const [categories, setCategories] = useState<readonly WorkCategory[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fingerprint, setFingerprint] = useState(props.fingerprint);
  const [editingEntry, setEditingEntry] = useState<TimeEntryResult | null>(null);
  const [correction, setCorrection] = useState<TimeEntryCorrection | null>(null);
  const [historicalPerson, setHistoricalPerson] = useState<EntityResult | null>(null);

  const personName = useCallback((id: string): string => {
    const person = people.find((item) => item.document.id === id);
    const historical = historicalPerson?.document.id === id ? historicalPerson : undefined;
    const match = person ?? historical;
    if (match !== undefined) {
      const name = formatEmployeeName(match.document) || id;
      // Archived people are shown by name with an explicit "(archived)" marker rather than their technical id.
      return match.document.lifecycle === "archived" ? t("actualReport.archivedEntity", { name }) : name;
    }
    return id;
  }, [formatEmployeeName, historicalPerson, people, t]);

  useEffect(() => { void (async () => {
    let loadError: string | null = null;
    try {
      setEntries(await api.listTimeEntries(draft.draft_id, projectId, taskId));
    } catch (candidate) {
      loadError = formatApiError(candidate);
    }
    try {
      const config = await api.getConfiguration(draft.draft_id, "work-categories");
      setCategories((config.document.categories as readonly WorkCategory[] | undefined) ?? []);
    } catch {
      setCategories([]);
    }
    setError(loadError);
  })(); }, [api, draft.draft_id, projectId, taskId]);

  useEffect(() => { setFingerprint(props.fingerprint); }, [props.fingerprint]);

  useEffect(() => {
    if (editingEntry === null || people.some((person) => person.document.id === editingEntry.document.person)) {
      setHistoricalPerson(null);
      return;
    }
    let cancelled = false;
    void api.getEntity(draft.draft_id, "people", editingEntry.document.person)
      .then((person) => { if (!cancelled) setHistoricalPerson(person); })
      .catch(() => { if (!cancelled) setHistoricalPerson(null); });
    return () => { cancelled = true; };
  }, [api, draft.draft_id, editingEntry, people]);

  const records = useMemo(() => entries.map((entry) => ({
    id: entry.document.id,
    person: entry.document.person,
    performed_on: entry.document.performed_on,
    hours: entry.document.hours,
    category: entry.document.category,
    state: entry.document.state,
    note: typeof entry.document.note_markdown === "string" ? entry.document.note_markdown : "",
    blob_id: entry.blob_id,
  })), [entries]);

  const actual = useMemo(() => actualWindow(records.map((record) => ({ id: record.id, project: projectId, task: taskId, person: record.person, performed_on: record.performed_on, hours: record.hours, category: record.category, state: record.state }))), [records, projectId, taskId]);
  const totalHours = useMemo(() => sumHours(records.map((record) => ({ id: record.id, project: projectId, task: taskId, person: record.person, performed_on: record.performed_on, hours: record.hours, category: record.category, state: record.state }))), [records, projectId, taskId]);
  const activePeople = useMemo(() => people.filter((person) => person.document.lifecycle === "active"), [people]);
  const activeCategories = useMemo(() => categories.filter((category) => category.active), [categories]);
  const correctionPeople = useMemo(() => {
    const active = activePeople.map((person) => ({ id: String(person.document.id), name: formatEmployeeName(person.document) || person.document.id, archived: false }));
    if (editingEntry === null || active.some((person) => person.id === editingEntry.document.person)) return active;
    const historical = people.find((person) => person.document.id === editingEntry.document.person)
      ?? (historicalPerson?.document.id === editingEntry.document.person ? historicalPerson : undefined);
    return [...active, { id: editingEntry.document.person, name: historical === undefined ? editingEntry.document.person : formatEmployeeName(historical.document), archived: true }];
  }, [activePeople, editingEntry, formatEmployeeName, historicalPerson, people]);
  const correctionCategories = useMemo(() => {
    if (editingEntry === null || activeCategories.some((category) => category.slug === editingEntry.document.category)) return activeCategories;
    const historical = categories.find((category) => category.slug === editingEntry.document.category);
    return [...activeCategories, historical ?? { slug: editingEntry.document.category, title: editingEntry.document.category, active: false }];
  }, [activeCategories, categories, editingEntry]);
  const [open, setOpen] = useState(true);
  const defaultPersonId = useMemo(() => assigneeIds.find((id) => activePeople.some((person) => person.document.id === id)), [assigneeIds, activePeople]);
  const today = useMemo(() => todayISODate(), []);
  const activeCount = entries.filter((entry) => entry.document.state === "active").length;
  const closeCorrection = () => { setEditingEntry(null); setCorrection(null); };
  const beginCorrection = (entry: TimeEntryResult) => {
    setEditingEntry(entry);
    setCorrection({ person: entry.document.person, performed_on: entry.document.performed_on, hours: entry.document.hours, category: entry.document.category, note: entry.document.note_markdown ?? "" });
  };

  const createEntry = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const input = {
      person: String(data.get("person") ?? ""),
      performed_on: String(data.get("performed_on") ?? ""),
      hours: Number(data.get("hours") ?? 0),
      category: String(data.get("category") ?? ""),
      ...(data.get("note") === null || String(data.get("note")) === "" ? {} : { note_markdown: String(data.get("note")) }),
    };
    setBusy(true);
    try {
      const created = await api.createTimeEntry(draft.draft_id, projectId, taskId, fingerprint, input);
      setEntries((current) => [...current, created]);
      setFingerprint(created.draft_fingerprint);
      await props.onFingerprintChange(created.draft_fingerprint);
      setError(null);
      (event.target as HTMLFormElement).reset();
    } catch (candidate) {
      setError(formatApiError(candidate));
    } finally {
      setBusy(false);
    }
  };

  const voidEntry = async (entry: TimeEntryResult) => {
    setBusy(true);
    try {
      const voided = await api.voidTimeEntry(draft.draft_id, projectId, taskId, entry, fingerprint);
      setEntries((current) => current.map((item) => item.document.id === voided.document.id ? voided : item));
      setFingerprint(voided.draft_fingerprint);
      await props.onFingerprintChange(voided.draft_fingerprint);
      setError(null);
    } catch (candidate) {
      setError(formatApiError(candidate));
    } finally {
      setBusy(false);
    }
  };

  const replaceEntry = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (editingEntry === null || correction === null) return;
    if (!correctionPeople.some((person) => person.id === correction.person) || !correctionCategories.some((category) => category.slug === correction.category)) {
      setError(t("timeEffort.historicalValueUnavailable")); return;
    }
    const input = {
      person: correction.person,
      performed_on: correction.performed_on,
      hours: correction.hours,
      category: correction.category,
      ...(correction.note === "" ? {} : { note_markdown: correction.note }),
    };
    setBusy(true);
    try {
      const replaced = await api.replaceTimeEntry(draft.draft_id, projectId, taskId, editingEntry, fingerprint, input);
      setEntries((current) => current.flatMap((item) => item.document.id === editingEntry.document.id ? [replaced.voided, replaced.created] : [item]));
      setFingerprint(replaced.created.draft_fingerprint);
      await props.onFingerprintChange(replaced.created.draft_fingerprint);
      closeCorrection();
      setError(null);
    } catch (candidate) {
      setError(formatApiError(candidate));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="task-time-entries">
      <div className="task-time-entries-heading">
        <h3><button aria-controls={`time-entry-body-${taskId}`} aria-expanded={open} className="section-toggle" data-control-hint={t("fieldHint.actualHeading")} onClick={() => setOpen((value) => !value)} type="button"><span aria-hidden="true" className="section-toggle-chevron">▾</span>{t("timeEffort.heading")}</button></h3>
        {activeCount > 0 && <span className="task-time-entries-count">{activeCount}</span>}
      </div>
      {open && (
        <>
          {error !== null && <div className="alert error">{error}</div>}
          <dl className="time-entry-summary">
            <div><dt data-field-hint={t("fieldHint.totalHours")} tabIndex={0}>{t("timeEffort.totalHours")}</dt><dd>{totalHours > 0 ? formatDurationHours(locale, totalHours) : "—"}</dd></div>
            <div><dt data-field-hint={t("fieldHint.firstActivity")} tabIndex={0}>{t("timeEffort.firstActivity")}</dt><dd>{actual?.start ? formatDateOnly(locale, actual.start) : "—"}</dd></div>
            <div><dt data-field-hint={t("fieldHint.lastActivity")} tabIndex={0}>{t("timeEffort.lastActivity")}</dt><dd>{actual?.finish ? formatDateOnly(locale, actual.finish) : "—"}</dd></div>
          </dl>
          <ul className="time-entry-list">
            {entries.map((entry) => (
              <li key={entry.document.id} className={`time-entry-row${entry.document.state === "voided" ? " voided" : ""}`}>
                <span className="time-entry-date">{formatDateOnly(locale, entry.document.performed_on)}</span>
                <span className="time-entry-hours">{formatDurationHours(locale, entry.document.hours)}</span>
                <span className="time-entry-person"><PersonLink name={personName(entry.document.person)} onOpen={onOpenPerson} personId={entry.document.person} /></span>
                <span className="time-entry-category">{categories.find((category) => category.slug === entry.document.category)?.title ?? entry.document.category}</span>
                {typeof entry.document.note_markdown === "string" && entry.document.note_markdown !== "" && <div className="time-entry-note"><SafeMarkdown fileContext={fileContext} source={entry.document.note_markdown} /></div>}
                {entry.document.state === "active" && !readOnly && <><button className="text-link" data-control-hint={t("fieldHint.correctTime")} disabled={busy} onClick={() => beginCorrection(entry)} type="button">{t("timeEffort.correct")}</button><button className="text-link" data-control-hint={t("fieldHint.voidTime")} disabled={busy} onClick={() => void voidEntry(entry)} type="button">{t("timeEffort.void")}</button></>}
              </li>
            ))}
            {entries.length === 0 && <li className="empty-copy">{t("timeEffort.empty")}</li>}
          </ul>
          {!readOnly && (
            <form className="time-entry-form" onSubmit={createEntry}>
              <label>{t("timeEffort.person")}<select defaultValue={defaultPersonId} disabled={busy} name="person" required>{activePeople.map((person) => <option key={person.document.id} value={person.document.id}>{formatEmployeeName(person.document)}</option>)}</select></label>
              <label>{t("timeEffort.date")}<input defaultValue={today} disabled={busy} name="performed_on" required type="date" /></label>
              <label>{t("timeEffort.hours")}<input disabled={busy} min="0.25" name="hours" required step="0.25" type="number" /></label>
              <label>{t("timeEffort.category")}<select disabled={busy} name="category" required>{activeCategories.map((category) => <option key={category.slug} value={category.slug}>{category.title}</option>)}</select></label>
              <ProjectFileMarkdownField context={fileContext} disabled={busy} label={t("timeEffort.note")} name="note" />
              <button className="primary" data-control-hint={t("controlHint.addTimeEntry")} disabled={busy} type="submit">{t("timeEffort.add")}</button>
            </form>
          )}
          <EditorDrawer closeLabel={t("core.closeEditor")} onClose={closeCorrection} open={editingEntry !== null && correction !== null} title={t("timeEffort.correctTitle")}>
            {editingEntry !== null && correction !== null && <form className="editor-drawer-form time-entry-form" onSubmit={replaceEntry}>
              <label>{t("timeEffort.person")}<select disabled={busy} name="person" onChange={(event) => setCorrection({ ...correction, person: event.currentTarget.value })} required value={correction.person}>{correctionPeople.map((person) => <option key={person.id} value={person.id}>{person.name}{person.archived ? ` (${t("core.archived")})` : ""}</option>)}</select></label>
              <label>{t("timeEffort.date")}<input disabled={busy} name="performed_on" onChange={(event) => setCorrection({ ...correction, performed_on: event.currentTarget.value })} required type="date" value={correction.performed_on} /></label>
              <label>{t("timeEffort.hours")}<input disabled={busy} min="0.25" name="hours" onChange={(event) => setCorrection({ ...correction, hours: event.currentTarget.valueAsNumber })} required step="0.25" type="number" value={correction.hours} /></label>
              <label>{t("timeEffort.category")}<select disabled={busy} name="category" onChange={(event) => setCorrection({ ...correction, category: event.currentTarget.value })} required value={correction.category}>{correctionCategories.map((category) => <option key={category.slug} value={category.slug}>{category.title}{category.active ? "" : ` (${t("admin.inactive")})`}</option>)}</select></label>
              <ProjectFileMarkdownField context={fileContext} disabled={busy} label={t("timeEffort.note")} onValueChange={(note) => setCorrection({ ...correction, note })} value={correction.note} />
              <div className="editor-drawer-actions"><button disabled={busy} onClick={closeCorrection} type="button">{t("core.cancel")}</button><button className="primary" disabled={busy || !Number.isFinite(correction.hours)} type="submit">{t("core.save")}</button></div>
            </form>}
          </EditorDrawer>
        </>
      )}
    </section>
  );
}
