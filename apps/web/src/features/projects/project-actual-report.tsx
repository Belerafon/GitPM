import { useEffect, useMemo, useState } from "react";
import type { SchedulingReadModel } from "@gitpm/scheduling";
import { windowEffort } from "@gitpm/scheduling";
import {
  actualWindow,
  groupByCategory,
  groupByDate,
  groupByPerson,
  groupByTask,
  hoursAfterDate,
  sumHours,
  type TimeEntryRecord,
} from "@gitpm/time-entries";
import { formatDateOnly, formatDurationHours, formatNumber, message, type Locale, type MessageKey } from "../../i18n.js";
import { formatApiError, listAllProjectTimeEntries, type GitPmApi, type ProjectTimeEntryFilters } from "../../api.js";
import type { DraftStatus, EntityResult } from "../../types.js";

export interface ActualReportCategory {
  readonly slug: string;
  readonly title: string;
}

interface ReportFilters {
  readonly task: string;
  readonly milestone: string;
  readonly person: string;
  readonly category: string;
  readonly state: "" | "active" | "voided";
  readonly performed_from: string;
  readonly performed_to: string;
}

const EMPTY_FILTERS: ReportFilters = { task: "", milestone: "", person: "", category: "", state: "", performed_from: "", performed_to: "" };
const text = (entity: EntityResult | undefined, key: string): string => typeof entity?.document[key] === "string" ? String(entity.document[key]) : "";
function requestFilters(filters: ReportFilters): ProjectTimeEntryFilters {
  return {
    ...(filters.task === "" ? {} : { task: filters.task }),
    ...(filters.milestone === "" ? {} : { milestone: filters.milestone }),
    ...(filters.person === "" ? {} : { person: filters.person }),
    ...(filters.category === "" ? {} : { category: filters.category }),
    ...(filters.state === "" ? {} : { state: filters.state }),
    ...(filters.performed_from === "" ? {} : { performed_from: filters.performed_from }),
    ...(filters.performed_to === "" ? {} : { performed_to: filters.performed_to }),
  };
}

function record(entry: Awaited<ReturnType<typeof listAllProjectTimeEntries>>[number], projectId: string): TimeEntryRecord {
  return {
    id: entry.document.id,
    project: projectId,
    task: entry.document.task,
    person: entry.document.person,
    performed_on: entry.document.performed_on,
    hours: entry.document.hours,
    category: entry.document.category,
    state: entry.document.state,
  };
}

function modelEffort(model: SchedulingReadModel | undefined, track: string): number | undefined {
  const summary = model?.tracks.find((item) => item.track === track);
  return windowEffort(summary?.declared) ?? windowEffort(summary?.rolled);
}

function BreakdownTable({ heading, empty, hoursLabel, rows }: { readonly heading: string; readonly empty: string; readonly hoursLabel: string; readonly rows: readonly { readonly key: string; readonly label: string; readonly hours: number }[] }) {
  return <section className="actual-breakdown"><h5>{heading}</h5>{rows.length === 0 ? <p className="empty-copy">{empty}</p> : <table><thead><tr><th>{heading}</th><th>{hoursLabel}</th></tr></thead><tbody>{rows.map((row) => <tr key={row.key}><th>{row.label}</th><td>{row.hours}</td></tr>)}</tbody></table>}</section>;
}

export function ProjectActualReport({ api, categories = [], comparisonFinish, draft, locale, milestones = [], people = [], projectId, readModels, tasks = [], workloadTrack }: {
  readonly api: GitPmApi;
  readonly categories?: readonly ActualReportCategory[];
  readonly comparisonFinish?: string;
  readonly draft: DraftStatus;
  readonly locale: Locale;
  readonly milestones?: readonly EntityResult[];
  readonly people?: readonly EntityResult[];
  readonly projectId: string;
  readonly readModels: ReadonlyMap<string, SchedulingReadModel>;
  readonly tasks?: readonly EntityResult[];
  readonly workloadTrack: string;
}) {
  const t = (key: MessageKey, values?: Readonly<Record<string, string | number>>) => message(locale, key, values);
  const [filters, setFilters] = useState<ReportFilters>(EMPTY_FILTERS);
  const [cutoff, setCutoff] = useState(comparisonFinish ?? "");
  const [entries, setEntries] = useState<Awaited<ReturnType<typeof listAllProjectTimeEntries>> | null>(null);
  const [knownPeople, setKnownPeople] = useState<readonly string[]>([]);
  const [knownCategories, setKnownCategories] = useState<readonly string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setCutoff(comparisonFinish ?? ""); }, [comparisonFinish]);
  useEffect(() => {
    if (filters.performed_from !== "" && filters.performed_to !== "" && filters.performed_from > filters.performed_to) {
      setError(t("actualReport.invalidRange"));
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setError(null);
    void listAllProjectTimeEntries(api, draft.draft_id, projectId, requestFilters(filters))
      .then((result) => {
        if (!active) return;
        setEntries(result);
        setKnownPeople((current) => [...new Set([...current, ...result.map((entry) => entry.document.person)])].sort());
        setKnownCategories((current) => [...new Set([...current, ...result.map((entry) => entry.document.category)])].sort());
      })
      .catch((reason: unknown) => { if (active) setError(formatApiError(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, draft.draft_id, filters, projectId]);

  const records = useMemo(() => (entries ?? []).map((entry) => record(entry, projectId)), [entries, projectId]);
  const actual = actualWindow(records);
  const actualByTask = groupByTask(records);
  const scopeId = filters.task || filters.milestone || projectId;
  const scopeModelPlan = windowEffort(readModels.get(scopeId)?.tracks.find((track) => track.track === workloadTrack)?.declared);
  const scopeRootTasks = tasks.filter((task) => text(task, "parent") === "" && (filters.milestone === "" || text(task, "milestone") === filters.milestone));
  const planned = filters.task !== ""
    ? modelEffort(readModels.get(filters.task), workloadTrack)
    : scopeModelPlan ?? scopeRootTasks.reduce<number | undefined>((total, task) => {
      const effort = modelEffort(readModels.get(task.document.id), workloadTrack);
      return effort === undefined ? total : (total ?? 0) + effort;
    }, undefined);
  const variance = planned === undefined ? undefined : sumHours(records) - planned;
  const ratio = planned === undefined || planned === 0 ? undefined : sumHours(records) / planned * 100;
  const personName = (id: string) => text(people.find((person) => person.document.id === id), "name") || id;
  const categoryName = (slug: string) => categories.find((category) => category.slug === slug)?.title ?? slug;
  const milestoneName = (id: string) => text(milestones.find((milestone) => milestone.document.id === id), "name") || t("actualReport.noMilestone");
  const taskName = (id: string) => text(tasks.find((task) => task.document.id === id), "title") || id;
  const taskOptions = tasks.filter((task) => filters.milestone === "" || text(task, "milestone") === filters.milestone);
  const peopleOptions = [...new Set([...people.map((person) => person.document.id), ...knownPeople])].sort((left, right) => personName(left).localeCompare(personName(right), locale));
  const categoryOptions = [...new Set([...categories.map((category) => category.slug), ...knownCategories])].sort((left, right) => categoryName(left).localeCompare(categoryName(right), locale));
  const scopeTasks = tasks.filter((task) => (filters.task === "" || task.document.id === filters.task) && (filters.milestone === "" || text(task, "milestone") === filters.milestone));
  const actualTaskIds = new Set(records.map((item) => item.task));
  const planActualRows = scopeTasks.map((task) => {
    const taskPlan = modelEffort(readModels.get(task.document.id), workloadTrack);
    const taskActual = actualByTask.get(task.document.id) ?? 0;
    return { id: task.document.id, title: taskName(task.document.id), milestone: milestoneName(text(task, "milestone")), planned: taskPlan, actual: taskActual, variance: taskPlan === undefined ? undefined : taskActual - taskPlan };
  }).filter((row) => row.planned !== undefined || actualTaskIds.has(row.id)).sort((left, right) => left.title.localeCompare(right.title, locale));
  const personRows = [...groupByPerson(records).entries()].map(([key, hours]) => ({ key, label: personName(key), hours })).sort((left, right) => left.label.localeCompare(right.label, locale));
  const categoryRows = [...groupByCategory(records).entries()].map(([key, hours]) => ({ key, label: categoryName(key), hours })).sort((left, right) => left.label.localeCompare(right.label, locale));
  const dateRows = [...groupByDate(records).entries()].map(([key, hours]) => ({ key, label: formatDateOnly(locale, key), hours })).sort((left, right) => right.key.localeCompare(left.key));
  const activeCount = records.filter((item) => item.state !== "voided").length;
  const voidedCount = records.length - activeCount;
  const after = cutoff === "" ? undefined : hoursAfterDate(records, cutoff);
  const filteredActualOnly = filters.person !== "" || filters.category !== "" || filters.state !== "" || filters.performed_from !== "" || filters.performed_to !== "";
  const patchFilter = <Key extends keyof ReportFilters>(key: Key, value: ReportFilters[Key]) => setFilters((current) => ({ ...current, [key]: value }));

  return <section className="actual-hours-report">
    <div className="actual-report-heading"><div><h4>{t("snapshot.actualReport")}</h4><p>{t("actualReport.description", { track: workloadTrack })}</p></div><button type="button" onClick={() => { setFilters(EMPTY_FILTERS); setCutoff(comparisonFinish ?? ""); }}>{t("actualReport.reset")}</button></div>
    <div className="actual-report-filters">
      <label>{t("actualReport.task")}<select value={filters.task} onChange={(event) => patchFilter("task", event.target.value)}><option value="">{t("actualReport.allTasks")}</option>{taskOptions.map((task) => <option key={task.document.id} value={task.document.id}>{taskName(task.document.id)}</option>)}</select></label>
      <label>{t("actualReport.milestone")}<select value={filters.milestone} onChange={(event) => { patchFilter("milestone", event.target.value); if (filters.task !== "" && text(tasks.find((task) => task.document.id === filters.task), "milestone") !== event.target.value) patchFilter("task", ""); }}><option value="">{t("actualReport.allMilestones")}</option>{milestones.map((milestone) => <option key={milestone.document.id} value={milestone.document.id}>{milestoneName(milestone.document.id)}</option>)}</select></label>
      <label>{t("timeEffort.person")}<select value={filters.person} onChange={(event) => patchFilter("person", event.target.value)}><option value="">{t("actualReport.allPeople")}</option>{peopleOptions.map((id) => <option key={id} value={id}>{personName(id)}</option>)}</select></label>
      <label>{t("timeEffort.category")}<select value={filters.category} onChange={(event) => patchFilter("category", event.target.value)}><option value="">{t("actualReport.allCategories")}</option>{categoryOptions.map((slug) => <option key={slug} value={slug}>{categoryName(slug)}</option>)}</select></label>
      <label>{t("actualReport.state")}<select value={filters.state} onChange={(event) => patchFilter("state", event.target.value as ReportFilters["state"])}><option value="">{t("actualReport.allStates")}</option><option value="active">{t("actualReport.active")}</option><option value="voided">{t("actualReport.voided")}</option></select></label>
      <label>{t("actualReport.from")}<input type="date" value={filters.performed_from} onChange={(event) => patchFilter("performed_from", event.target.value)} /></label>
      <label>{t("actualReport.to")}<input type="date" value={filters.performed_to} onChange={(event) => patchFilter("performed_to", event.target.value)} /></label>
      <label>{t("actualReport.after")}<input type="date" value={cutoff} onChange={(event) => setCutoff(event.target.value)} /></label>
    </div>
    {error !== null && <div className="alert error">{error}</div>}
    {loading && <p className="empty-copy">{t("status.loading")}</p>}
    {entries !== null && <>
      <dl className="actual-report-summary">
        <div><dt>{t("snapshot.actualHours")}</dt><dd>{formatDurationHours(locale, sumHours(records))}</dd></div>
        <div><dt>{t("actualReport.activeEntries")}</dt><dd>{activeCount}</dd></div>
        <div><dt>{t("actualReport.voidedEntries")}</dt><dd>{voidedCount}</dd></div>
        {actual?.start !== undefined && <div><dt>{t("timeEffort.firstActivity")}</dt><dd>{formatDateOnly(locale, actual.start)}</dd></div>}
        {actual?.finish !== undefined && <div><dt>{t("timeEffort.lastActivity")}</dt><dd>{formatDateOnly(locale, actual.finish)}</dd></div>}
        {after !== undefined && <div><dt>{t("snapshot.hoursAfter", { date: cutoff })}</dt><dd>{formatDurationHours(locale, after)}</dd></div>}
      </dl>
      <section className="plan-actual-report">
        <div className="plan-actual-heading"><div><h5>{t("actualReport.planActual")}</h5><p>{t("actualReport.planSource", { track: workloadTrack })}</p></div><dl><div><dt>{t("actualReport.planned")}</dt><dd>{planned === undefined ? "—" : formatDurationHours(locale, planned)}</dd></div><div><dt>{t("actualReport.actual")}</dt><dd>{formatDurationHours(locale, sumHours(records))}</dd></div><div><dt>{t("actualReport.variance")}</dt><dd>{variance === undefined ? "—" : formatDurationHours(locale, variance)}</dd></div><div><dt>{t("actualReport.ratio")}</dt><dd>{ratio === undefined ? "—" : `${formatNumber(locale, ratio)}%`}</dd></div></dl></div>
        {filteredActualOnly && <p className="scope-hint">{t("actualReport.actualOnlyFilters")}</p>}
        {planActualRows.length === 0 ? <p className="empty-copy">{t("actualReport.empty")}</p> : <div className="actual-report-table-wrap"><table><thead><tr><th>{t("actualReport.task")}</th><th>{t("actualReport.milestone")}</th><th>{t("actualReport.planned")}</th><th>{t("actualReport.actual")}</th><th>{t("actualReport.variance")}</th></tr></thead><tbody>{planActualRows.map((row) => <tr key={row.id}><th><span>{row.title}</span><code>{row.id}</code></th><td>{row.milestone}</td><td>{row.planned === undefined ? "—" : row.planned}</td><td>{row.actual}</td><td>{row.variance === undefined ? "—" : row.variance}</td></tr>)}</tbody></table></div>}
      </section>
      <div className="actual-breakdowns">
        <BreakdownTable heading={t("actualReport.byPerson")} empty={t("actualReport.empty")} hoursLabel={t("timeEffort.hours")} rows={personRows} />
        <BreakdownTable heading={t("actualReport.byCategory")} empty={t("actualReport.empty")} hoursLabel={t("timeEffort.hours")} rows={categoryRows} />
        <BreakdownTable heading={t("actualReport.byDate")} empty={t("actualReport.empty")} hoursLabel={t("timeEffort.hours")} rows={dateRows} />
      </div>
    </>}
  </section>;
}
