import { useCallback, useEffect, useMemo, useState } from "react";
import { calculateWorkload, type WorkloadCalendar, type WorkloadPerson, type WorkloadTask } from "@gitpm/workload";
import type { GitPmApi } from "./api.js";
import { formatDateOnly, formatNumber, message, type Locale, type MessageKey } from "./i18n.js";
import type { DraftStatus, EntityResult, GitPmDocument } from "./types.js";

const text = (document: GitPmDocument, key: string) => typeof document[key] === "string" ? document[key] as string : undefined;
const number = (document: GitPmDocument, key: string) => typeof document[key] === "number" ? document[key] as number : undefined;
const strings = (document: GitPmDocument, key: string) => Array.isArray(document[key]) ? (document[key] as unknown[]).filter((item): item is string => typeof item === "string") : [];
const numbers = (document: GitPmDocument, key: string) => Array.isArray(document[key]) ? (document[key] as unknown[]).filter((item): item is number => typeof item === "number") : [];

function task(entity: EntityResult): WorkloadTask {
  return { id: entity.document.id, title: text(entity.document, "title") ?? entity.document.id, lifecycle: entity.document.lifecycle, estimate_hours: number(entity.document, "estimate_hours"), start: text(entity.document, "start"), due: text(entity.document, "due"), assignees: strings(entity.document, "assignees") };
}

function person(entity: EntityResult): WorkloadPerson {
  return { id: entity.document.id, name: text(entity.document, "name") ?? entity.document.id, lifecycle: entity.document.lifecycle, weekly_capacity_hours: number(entity.document, "weekly_capacity_hours") ?? 0, calendar: text(entity.document, "calendar") ?? "" };
}

function calendar(entity: EntityResult): WorkloadCalendar {
  return { id: entity.document.id, lifecycle: entity.document.lifecycle, working_weekdays: numbers(entity.document, "working_weekdays"), holidays: strings(entity.document, "holidays") };
}

export function WorkloadWorkspace({ api, draft, locale }: { readonly api: GitPmApi; readonly draft: DraftStatus; readonly locale: Locale }) {
  const t = (key: MessageKey, values?: Readonly<Record<string, string | number>>) => message(locale, key, values);
  const [tasks, setTasks] = useState<readonly EntityResult[]>([]);
  const [people, setPeople] = useState<readonly EntityResult[]>([]);
  const [calendars, setCalendars] = useState<readonly EntityResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const [nextTasks, nextPeople, nextCalendars] = await Promise.all([
      api.listEntities(draft.draft_id, "tasks"), api.listEntities(draft.draft_id, "people"), api.listEntities(draft.draft_id, "calendars"),
    ]);
    setTasks(nextTasks); setPeople(nextPeople); setCalendars(nextCalendars); setError(null);
  }, [api, draft.draft_id, draft.external_fingerprint]);
  useEffect(() => { void load().catch((caught) => setError(caught instanceof Error ? caught.message : String(caught))); }, [load]);
  const report = useMemo(() => calculateWorkload(tasks.map(task), people.map(person), calendars.map(calendar)), [tasks, people, calendars]);
  const activePeople = [...new Map(report.rows.map((row) => [row.person_id, row.person_name])).entries()];
  const rows = new Map(report.rows.map((row) => [`${row.person_id}:${row.week}`, row]));
  const excluded = Object.values(report.exclusions).reduce((sum, value) => sum + value, 0);

  return <section className="workload-workspace">
    <div className="section-heading"><span className="eyebrow draft-context-id">{draft.draft_id}</span><h2>{t("workload.heading")}</h2><p>{t("workload.description")}</p></div>
    {error !== null && <div className="alert error">{error}</div>}
    <section className="card workload-summary">
      <div><span>{t("workload.included")}</span><strong>{report.included_tasks}</strong></div>
      <div><span>{t("workload.excluded")}</span><strong>{excluded}</strong></div>
      <p>{t("workload.formula")}</p>
      <p>{t("workload.capacityFormula")}</p>
    </section>
    {report.weeks.length === 0 || activePeople.length === 0 ? <section className="card empty-workspace">{t("workload.empty")}</section> : <section className="card workload-table-wrap">
      <table className="workload-table"><thead><tr><th>{t("workload.person")}</th>{report.weeks.map((week) => <th key={week}><time dateTime={week}>{t("workload.week", { date: formatDateOnly(locale, week) })}</time></th>)}</tr></thead>
        <tbody>{activePeople.map(([personId, personName]) => <tr key={personId}><th>{personName}</th>{report.weeks.map((week) => {
          const value = rows.get(`${personId}:${week}`)!; const overloaded = value.capacity_hours === 0 ? value.allocated_hours > 0 : value.allocated_hours > value.capacity_hours;
          return <td className={overloaded ? "overloaded" : "available"} data-person-id={personId} data-week={week} key={week} title={t("workload.tasks", { count: value.task_ids.length })}><strong>{t("workload.hours", { allocated: formatNumber(locale, value.allocated_hours), capacity: formatNumber(locale, value.capacity_hours) })}</strong><span>{value.utilization_percent === null ? t("workload.noCapacity") : t("workload.utilization", { percent: formatNumber(locale, value.utilization_percent) })}</span></td>;
        })}</tr>)}</tbody></table>
    </section>}
    <section className="card workload-exclusions"><h3>{t("workload.exclusionHeading")}</h3><dl>
      <div><dt>{t("workload.archived")}</dt><dd>{report.exclusions.archived}</dd></div><div><dt>{t("workload.undated")}</dt><dd>{report.exclusions.undated}</dd></div><div><dt>{t("workload.unestimated")}</dt><dd>{report.exclusions.unestimated}</dd></div><div><dt>{t("workload.unassigned")}</dt><dd>{report.exclusions.unassigned}</dd></div><div><dt>{t("workload.unavailable")}</dt><dd>{report.exclusions.unavailable_assignees}</dd></div>
    </dl></section>
  </section>;
}
