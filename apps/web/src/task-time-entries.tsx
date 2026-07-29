import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { actualWindow, sumHours } from "@gitpm/time-entries";
import { formatApiError, type GitPmApi } from "./api.js";
import { formatDateOnly, message, type Locale, type MessageKey } from "./i18n.js";
import type { DraftStatus, EntityResult } from "./types.js";
import type { TimeEntryResult } from "./api.js";

interface WorkCategory { readonly slug: string; readonly title: string; readonly active: boolean }

const NO_ASSIGNEES: readonly string[] = [];

function todayISODate(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function TaskTimeEntries(props: {
  readonly api: GitPmApi;
  readonly draft: DraftStatus;
  readonly fingerprint: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly people: readonly EntityResult[];
  readonly readOnly: boolean;
  readonly locale: Locale;
  readonly assigneeIds?: readonly string[];
  readonly onFingerprintChange: (fingerprint: string) => Promise<void>;
}) {
  const { api, draft, projectId, taskId, people, readOnly, locale, assigneeIds = NO_ASSIGNEES } = props;
  const t = (key: MessageKey, values?: Readonly<Record<string, string | number>>) => message(locale, key, values);
  const [entries, setEntries] = useState<readonly TimeEntryResult[]>([]);
  const [categories, setCategories] = useState<readonly WorkCategory[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fingerprint, setFingerprint] = useState(props.fingerprint);

  const personName = useCallback((id: string): string => people.find((person) => person.document.id === id)?.document.name ?? id, [people]);

  useEffect(() => { void (async () => {
    let loadError: string | null = null;
    try {
      setEntries(await api.listTimeEntries(draft.draft_id, projectId, taskId));
    } catch (candidate) {
      loadError = formatApiError(candidate);
    }
    try {
      const config = await api.getConfiguration(draft.draft_id, "work-categories");
      setCategories((config.document.categories as readonly WorkCategory[] | undefined)?.filter((category) => category.active) ?? []);
    } catch {
      setCategories([]);
    }
    setError(loadError);
  })(); }, [api, draft.draft_id, projectId, taskId]);

  useEffect(() => { setFingerprint(props.fingerprint); }, [props.fingerprint]);

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
  const [open, setOpen] = useState(true);
  const defaultPersonId = useMemo(() => assigneeIds.find((id) => activePeople.some((person) => person.document.id === id)), [assigneeIds, activePeople]);
  const today = useMemo(() => todayISODate(), []);
  const activeCount = entries.filter((entry) => entry.document.state === "active").length;

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

  return (
    <section className="task-time-entries">
      <div className="task-time-entries-heading">
        <h3><button aria-controls={`time-entry-body-${taskId}`} aria-expanded={open} className="section-toggle" onClick={() => setOpen((value) => !value)} type="button"><span aria-hidden="true" className="section-toggle-chevron">▾</span>{t("timeEffort.heading")}</button></h3>
        {activeCount > 0 && <span className="task-time-entries-count">{activeCount}</span>}
      </div>
      {open && (
        <>
          {error !== null && <div className="alert error">{error}</div>}
          <dl className="time-entry-summary">
            <div><dt>{t("timeEffort.totalHours")}</dt><dd>{totalHours || "—"}</dd></div>
            <div><dt>{t("timeEffort.firstActivity")}</dt><dd>{actual?.start ? formatDateOnly(locale, actual.start) : "—"}</dd></div>
            <div><dt>{t("timeEffort.lastActivity")}</dt><dd>{actual?.finish ? formatDateOnly(locale, actual.finish) : "—"}</dd></div>
          </dl>
          <ul className="time-entry-list">
            {entries.map((entry) => (
              <li key={entry.document.id} className={`time-entry-row${entry.document.state === "voided" ? " voided" : ""}`}>
                <span className="time-entry-date">{formatDateOnly(locale, entry.document.performed_on)}</span>
                <span className="time-entry-hours">{entry.document.hours} h</span>
                <span className="time-entry-person">{personName(entry.document.person)}</span>
                <span className="time-entry-category">{categories.find((category) => category.slug === entry.document.category)?.title ?? entry.document.category}</span>
                {typeof entry.document.note_markdown === "string" && entry.document.note_markdown !== "" && <span className="time-entry-note">{entry.document.note_markdown}</span>}
                {entry.document.state === "active" && !readOnly && <button className="text-link" disabled={busy} onClick={() => void voidEntry(entry)} type="button">{t("timeEffort.void")}</button>}
              </li>
            ))}
            {entries.length === 0 && <li className="empty-copy">{t("timeEffort.empty")}</li>}
          </ul>
          {!readOnly && (
            <form className="time-entry-form" onSubmit={createEntry}>
              <label>{t("timeEffort.person")}<select defaultValue={defaultPersonId} disabled={busy} name="person" required>{activePeople.map((person) => <option key={person.document.id} value={person.document.id}>{person.document.name}</option>)}</select></label>
              <label>{t("timeEffort.date")}<input defaultValue={today} disabled={busy} name="performed_on" required type="date" /></label>
              <label>{t("timeEffort.hours")}<input disabled={busy} min="0.25" name="hours" required step="0.25" type="number" /></label>
              <label>{t("timeEffort.category")}<select disabled={busy} name="category" required>{categories.map((category) => <option key={category.slug} value={category.slug}>{category.title}</option>)}</select></label>
              <label>{t("timeEffort.note")}<input disabled={busy} name="note" type="text" /></label>
              <button className="primary" disabled={busy} type="submit">{t("timeEffort.add")}</button>
            </form>
          )}
        </>
      )}
    </section>
  );
}
