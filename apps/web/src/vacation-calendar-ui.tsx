import { useCallback, useEffect, useMemo, useState } from "react";
import type { GitPmApi } from "./api.js";
import { AsyncBoundary, useAsyncLoad } from "./async-data.js";
import { dayUnit, formatDateOnly, localeRegistry, message, type Locale, type MessageKey } from "./i18n.js";
import { currentAbsence, vacationYearBalance } from "./people-availability-model.js";
import { availabilityKindLabel } from "./people-availability-ui.js";
import type { DraftStatus, EntityResult, GitPmDocument } from "./types.js";
import {
  emptyVacationFilters,
  localCalendarDate,
  VACATION_CALENDAR_HEADER_HEIGHT,
  VACATION_CALENDAR_MONTHS,
  VACATION_CALENDAR_ROW_HEIGHT,
  vacationBars,
  vacationCalendarWindow,
  vacationSummary,
  visiblePeople,
  type VacationCalendarFilters,
  type VacationCalendarMonths,
  type VacationEvent,
  type VacationPerson,
  type VacationTeam,
} from "./vacation-calendar-model.js";
import type { WorkspaceNavigate } from "./workspace-navigation.js";

const text = (document: GitPmDocument, key: string): string => typeof document[key] === "string" ? document[key] as string : "";
const strings = (document: GitPmDocument, key: string): readonly string[] => Array.isArray(document[key]) ? document[key].filter((item): item is string => typeof item === "string") : [];
const kindClass = (kind: string): string => ({ vacation: "kind-vacation", "day-off": "kind-day-off", "sick-leave": "kind-sick-leave", training: "kind-training", other: "kind-other" }[kind] ?? "kind-other");
const stateKey = (state: string): MessageKey => ({ planned: "availability.statePlanned", taken: "availability.stateTaken", cancelled: "availability.stateCancelled" }[state] ?? "availability.statePlanned") as MessageKey;

function asPerson(entity: EntityResult): VacationPerson {
  return { id: entity.document.id, name: text(entity.document, "name") || entity.document.id, lifecycle: text(entity.document, "lifecycle") };
}

function asTeam(entity: EntityResult): VacationTeam {
  return { id: entity.document.id, name: text(entity.document, "name") || entity.document.id, members: strings(entity.document, "members"), lifecycle: text(entity.document, "lifecycle") };
}

function asEvent(entity: EntityResult): VacationEvent {
  return {
    id: entity.document.id,
    personId: text(entity.document, "person"),
    start: text(entity.document, "start"),
    finish: text(entity.document, "finish"),
    kind: text(entity.document, "kind") || "other",
    state: text(entity.document, "state") || "planned",
    note: text(entity.document, "note_markdown"),
    lifecycle: text(entity.document, "lifecycle"),
  };
}

export function VacationCalendarWorkspace({ api, draft, locale, onNavigate = () => undefined, today = localCalendarDate() }: {
  readonly api: GitPmApi;
  readonly draft: DraftStatus;
  readonly locale: Locale;
  readonly onNavigate?: WorkspaceNavigate;
  readonly today?: string;
}) {
  const t = (key: MessageKey, values?: Readonly<Record<string, string | number>>) => message(locale, key, values);
  const [people, setPeople] = useState<readonly EntityResult[]>([]);
  const [teams, setTeams] = useState<readonly EntityResult[]>([]);
  const [events, setEvents] = useState<readonly EntityResult[]>([]);
  const [months, setMonths] = useState<VacationCalendarMonths>(6);
  const [filters, setFilters] = useState<VacationCalendarFilters>(emptyVacationFilters);
  const loadRequest = useAsyncLoad();
  const load = useCallback(async () => {
    await loadRequest.run(async () => {
      const [nextPeople, nextTeams, nextEvents] = await Promise.all([
        api.listEntities(draft.draft_id, "people"),
        api.listEntities(draft.draft_id, "teams"),
        api.listEntities(draft.draft_id, "availability-events"),
      ]);
      return { nextPeople, nextTeams, nextEvents };
    }, ({ nextPeople, nextTeams, nextEvents }) => {
      setPeople(nextPeople);
      setTeams(nextTeams.filter((item) => item.document.lifecycle === "active"));
      setEvents(nextEvents);
    });
  }, [api, draft.draft_id, draft.external_fingerprint, loadRequest.run]);
  useEffect(() => { void load(); }, [load]);
  const modeledPeople = useMemo(() => people.map(asPerson), [people]);
  const modeledTeams = useMemo(() => teams.map(asTeam), [teams]);
  const modeledEvents = useMemo(() => events.map(asEvent), [events]);
  const window = useMemo(() => vacationCalendarWindow(today, months), [today, months]);
  const rows = useMemo(() => visiblePeople(modeledPeople, modeledTeams, filters), [modeledPeople, modeledTeams, filters]);
  const bars = useMemo(() => vacationBars(modeledEvents, rows, window, filters), [modeledEvents, rows, window, filters]);
  const summary = useMemo(() => vacationSummary(modeledEvents, rows, window, filters, today), [modeledEvents, rows, window, filters, today]);
  const barsByPerson = useMemo(() => {
    const grouped = new Map<string, typeof bars>();
    for (const bar of bars) grouped.set(bar.personId, [...(grouped.get(bar.personId) ?? []), bar]);
    return grouped;
  }, [bars]);
  const eventsByPerson = useMemo(() => {
    const grouped = new Map<string, VacationEvent[]>();
    for (const event of modeledEvents) grouped.set(event.personId, [...(grouped.get(event.personId) ?? []), event]);
    return grouped;
  }, [modeledEvents]);
  const personOptions = useMemo(() => visiblePeople(modeledPeople, modeledTeams, { ...filters, personId: "", search: "" }), [modeledPeople, modeledTeams, filters]);
  const monthLabel = (key: string) => new Intl.DateTimeFormat(localeRegistry[locale]?.languageTag ?? "en", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${key}-01T00:00:00Z`));
  const todayOffset = window.days.indexOf(today);
  const updateFilter = <K extends keyof VacationCalendarFilters>(key: K, value: VacationCalendarFilters[K]) => {
    setFilters((current) => {
      const next = { ...current, [key]: value };
      if (key === "teamId") next.personId = "";
      return next;
    });
  };
  const barTitle = (bar: (typeof bars)[number]) => {
    const values = { kind: availabilityKindLabel(t, bar.kind), state: t(stateKey(bar.state)), start: formatDateOnly(locale, bar.start), finish: formatDateOnly(locale, bar.finish), days: bar.days, unit: dayUnit(locale, bar.days) };
    return bar.note === "" ? t("vacationCalendar.tooltip", values) : t("vacationCalendar.tooltipNote", { ...values, note: bar.note });
  };

  return <section className="vacation-calendar-workspace">
    <div className="section-heading"><span className="eyebrow draft-context-id">{draft.draft_id}</span><h2 aria-hidden="true">{t("vacationCalendar.heading")}</h2><p>{t("vacationCalendar.description")}</p></div>
    <AsyncBoundary state={loadRequest.state} loading={t("status.loading")} retry={() => { void load(); }} error={(loadError, retry) => <div className="alert error">{loadError}<button onClick={retry}>{t("status.retry")}</button></div>}>
    <>
    <section className="card vacation-calendar-toolbar">
      <label>{t("workload.teamFilter")}<select aria-label={t("workload.teamFilter")} value={filters.teamId} onChange={(event) => updateFilter("teamId", event.target.value)}><option value="">{t("workload.allTeams")}</option>{modeledTeams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label>
      <label>{t("vacationCalendar.personFilter")}<select aria-label={t("vacationCalendar.personFilter")} value={filters.personId} onChange={(event) => updateFilter("personId", event.target.value)}><option value="">{t("vacationCalendar.allPeople")}</option>{personOptions.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label>
      <label>{t("availability.kind")}<select aria-label={t("availability.kind")} value={filters.kind} onChange={(event) => updateFilter("kind", event.target.value)}><option value="">{t("vacationCalendar.allKinds")}</option><option value="vacation">{t("availability.kindVacation")}</option><option value="day-off">{t("availability.kindDayOff")}</option><option value="sick-leave">{t("availability.kindSickLeave")}</option><option value="training">{t("availability.kindTraining")}</option><option value="other">{t("availability.kindOther")}</option></select></label>
      <label>{t("availability.state")}<select aria-label={t("availability.state")} value={filters.state} onChange={(event) => updateFilter("state", event.target.value)}><option value="">{t("vacationCalendar.allStates")}</option><option value="planned">{t("availability.statePlanned")}</option><option value="taken">{t("availability.stateTaken")}</option><option value="cancelled">{t("availability.stateCancelled")}</option></select></label>
      <label>{t("vacationCalendar.search")}<input aria-label={t("vacationCalendar.search")} onChange={(event) => updateFilter("search", event.target.value)} type="search" value={filters.search} /></label>
      <button onClick={() => setFilters(emptyVacationFilters())} type="button">{t("people.resetFilters")}</button>
    </section>
    <section className="card vacation-calendar-period" aria-label={t("vacationCalendar.months")}>
      <span>{t("vacationCalendar.months")}</span>
      <div className="vacation-calendar-months" role="group" aria-label={t("vacationCalendar.months")}>
        {VACATION_CALENDAR_MONTHS.map((value) => <button aria-pressed={months === value} className={months === value ? "active" : ""} key={value} onClick={() => setMonths(value)} type="button">{t(`vacationCalendar.months${value}` as MessageKey)}</button>)}
      </div>
    </section>
    <section className="card vacation-calendar-summary">
      <div><span>{t("vacationCalendar.absentToday")}</span><strong>{summary.absentToday}</strong></div>
      <div><span>{t("vacationCalendar.leavingSoon")}</span><strong>{summary.leavingSoon}</strong></div>
      <div><span>{t("vacationCalendar.maxOverlap")}</span><strong>{summary.maxOverlap}</strong></div>
    </section>
    <div className="vacation-calendar-legend" aria-label={t("vacationCalendar.heading")}>
      <span className="kind-vacation">{t("availability.kindVacation")}</span>
      <span className="kind-day-off">{t("availability.kindDayOff")}</span>
      <span className="kind-sick-leave">{t("availability.kindSickLeave")}</span>
      <span className="kind-training">{t("availability.kindTraining")}</span>
      <span className="kind-other">{t("availability.kindOther")}</span>
      <span className="today">{t("gantt.legendToday")}</span>
      <span className="away">{t("vacationCalendar.legendAway")}</span>
    </div>
    {rows.length === 0 ? <section className="card empty-workspace">{t("vacationCalendar.empty")}</section> : <section aria-label={t("vacationCalendar.chart")} className="card vacation-calendar-scroll" data-finish={window.finish} data-months={months} data-start={window.start}>
      <div className="vacation-calendar-labels">
        <div className="vacation-calendar-label-head">{t("workload.person")}</div>
        {rows.map((person) => {
          const personEvents = eventsByPerson.get(person.id) ?? [];
          const away = currentAbsence(personEvents, today);
          const year = vacationYearBalance(personEvents, today);
          const stats = t("vacationCalendar.personStats", { taken: year.taken, planned: year.planned, remaining: year.remaining });
          const hint = away === undefined ? `${t("vacationCalendar.availableToday")}. ${stats}` : `${t("vacationCalendar.awayUntil", { kind: availabilityKindLabel(t, away.kind), date: formatDateOnly(locale, away.finish) })}. ${stats}`;
          return <div className={`vacation-calendar-label${away === undefined ? "" : " away"}`} data-person-id={person.id} key={person.id} title={hint}>
            <button className="text-link" onClick={() => onNavigate("people", { personId: person.id })} title={hint} type="button">{person.name}</button>
            <small>{stats}</small>
          </div>;
        })}
      </div>
      <div className="vacation-calendar-timeline" style={{ width: `${window.timelineWidth}px` }}>
        <div className="vacation-calendar-months-row" style={{ gridTemplateColumns: window.months.map((segment) => `${segment.days * window.dayWidth}px`).join(" ") }}>{window.months.map((segment) => <time dateTime={`${segment.key}-01`} key={segment.key}>{monthLabel(segment.key)}</time>)}</div>
        {rows.map((person, index) => currentAbsence(eventsByPerson.get(person.id) ?? [], today) === undefined ? null : <div className="vacation-calendar-row away" data-person-id={person.id} key={person.id} style={{ top: `${VACATION_CALENDAR_HEADER_HEIGHT + index * VACATION_CALENDAR_ROW_HEIGHT}px`, height: `${VACATION_CALENDAR_ROW_HEIGHT}px` }} />)}
        {todayOffset >= 0 && <div aria-label={t("gantt.legendToday")} className="vacation-calendar-today" style={{ left: `${todayOffset * window.dayWidth + window.dayWidth / 2}px` }} />}
        <div className="vacation-calendar-grid" style={{ backgroundSize: `${window.dayWidth}px 100%`, height: `${rows.length * VACATION_CALENDAR_ROW_HEIGHT}px` }} />
        {rows.map((person, index) => (barsByPerson.get(person.id) ?? []).map((bar) => <div className={`vacation-calendar-bar ${kindClass(bar.kind)} state-${bar.state}`} data-duration={bar.duration} data-event-id={bar.id} data-finish={bar.finish} data-offset={bar.offset} data-person-id={bar.personId} data-start={bar.start} key={bar.id} style={{ left: `${bar.left}px`, top: `${VACATION_CALENDAR_HEADER_HEIGHT + index * VACATION_CALENDAR_ROW_HEIGHT + 8}px`, width: `${bar.width}px` }} title={barTitle(bar)}><span>{t("vacationCalendar.barText", { start: formatDateOnly(locale, bar.start), finish: formatDateOnly(locale, bar.finish), days: bar.days })}</span></div>))}
      </div>
    </section>}
    </>
    </AsyncBoundary>
  </section>;
}
