import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { actualWindow, sumHours } from "@gitpm/time-entries";
import { formatApiError, type GitPmApi } from "./api.js";
import { formatDateOnly, type Locale } from "./i18n.js";
import type { DraftStatus, EntityResult } from "./types.js";
import type { TimeEntryResult } from "./api.js";

interface WorkCategory { readonly slug: string; readonly title: string; readonly active: boolean }

export function TaskTimeEntries(props: {
  readonly api: GitPmApi;
  readonly draft: DraftStatus;
  readonly fingerprint: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly people: readonly EntityResult[];
  readonly readOnly: boolean;
  readonly locale: Locale;
  readonly onFingerprintChange: (fingerprint: string) => Promise<void>;
}) {
  const { api, draft, projectId, taskId, people, readOnly, locale } = props;
  const [entries, setEntries] = useState<readonly TimeEntryResult[]>([]);
  const [categories, setCategories] = useState<readonly WorkCategory[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fingerprint, setFingerprint] = useState(props.fingerprint);

  const personName = useCallback((id: string): string => people.find((person) => person.document.id === id)?.document.name ?? id, [people]);

  useEffect(() => { void (async () => {
    try {
      const [entryList, config] = await Promise.all([
        api.listTimeEntries(draft.draft_id, projectId, taskId),
        api.getConfiguration(draft.draft_id, "work-categories"),
      ]);
      setEntries(entryList);
      setCategories((config.document.categories as readonly WorkCategory[] | undefined)?.filter((category) => category.active) ?? []);
      setError(null);
    } catch (candidate) {
      setError(formatApiError(candidate));
    }
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
    <section className="card task-time-entries">
      <h3>Actual effort</h3>
      <dl className="time-entry-summary">
        <div><dt>Total hours</dt><dd>{totalHours || "—"}</dd></div>
        <div><dt>First activity</dt><dd>{actual?.start ? formatDateOnly(locale, actual.start) : "—"}</dd></div>
        <div><dt>Last activity</dt><dd>{actual?.finish ? formatDateOnly(locale, actual.finish) : "—"}</dd></div>
      </dl>
      {error !== null && <p className="error-text">{error}</p>}
      <ul className="time-entry-list">
        {entries.map((entry) => (
          <li key={entry.document.id} className={`time-entry-row${entry.document.state === "voided" ? " voided" : ""}`}>
            <span className="time-entry-date">{formatDateOnly(locale, entry.document.performed_on)}</span>
            <span className="time-entry-hours">{entry.document.hours} h</span>
            <span className="time-entry-person">{personName(entry.document.person)}</span>
            <span className="time-entry-category">{categories.find((category) => category.slug === entry.document.category)?.title ?? entry.document.category}</span>
            {typeof entry.document.note_markdown === "string" && entry.document.note_markdown !== "" && <span className="time-entry-note">{entry.document.note_markdown}</span>}
            {entry.document.state === "active" && !readOnly && <button className="text-link" disabled={busy} onClick={() => void voidEntry(entry)} type="button">Void</button>}
          </li>
        ))}
        {entries.length === 0 && <li className="empty-copy">No actual effort recorded.</li>}
      </ul>
      {!readOnly && (
        <form className="time-entry-form" onSubmit={createEntry}>
          <label>Person<select disabled={busy} name="person" required>{activePeople.map((person) => <option key={person.document.id} value={person.document.id}>{person.document.name}</option>)}</select></label>
          <label>Date<input disabled={busy} name="performed_on" required type="date" /></label>
          <label>Hours<input disabled={busy} min="0.25" name="hours" required step="0.25" type="number" /></label>
          <label>Category<select disabled={busy} name="category" required>{categories.map((category) => <option key={category.slug} value={category.slug}>{category.title}</option>)}</select></label>
          <label>Note<input disabled={busy} name="note" type="text" /></label>
          <button className="primary" disabled={busy} type="submit">Add effort</button>
        </form>
      )}
    </section>
  );
}
