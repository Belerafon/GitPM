import { useEffect, useState } from "react";
import { ENTITY_ID_PREFIX, newUniqueEntityId } from "@gitpm/shared";
import { EditorDrawer } from "./editor-drawer.js";
import { dayUnit, formatDateOnly, formatNumber, type Locale, type MessageKey } from "./i18n.js";
import { ANNUAL_VACATION_DAYS, annualVacationAllowance, isPastAbsence, vacationYearBalance, type AvailabilityRecord } from "./people-availability-model.js";
import type { EntityResult, GitPmDocument } from "./types.js";
import { DEFAULT_WORKING_CALENDAR, isIsoDate, localCalendarDate, workingDayCount, type WorkingCalendar } from "./vacation-calendar-model.js";

type Translate = (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string;

const text = (document: GitPmDocument, key: string): string => typeof document[key] === "string" ? document[key] as string : "";
const number = (document: GitPmDocument, key: string): number => typeof document[key] === "number" ? document[key] as number : 0;
const kindKey = (kind: string): MessageKey => ({
  vacation: "availability.kindVacation",
  "day-off": "availability.kindDayOff",
  "sick-leave": "availability.kindSickLeave",
  training: "availability.kindTraining",
  other: "availability.kindOther",
}[kind] ?? "availability.kindOther") as MessageKey;
const stateKey = (state: string): MessageKey => ({
  planned: "availability.statePlanned",
  taken: "availability.stateTaken",
  cancelled: "availability.stateCancelled",
}[state] ?? "availability.statePlanned") as MessageKey;

export function availabilityKindLabel(t: Translate, kind: string): string {
  return t(kindKey(kind));
}

function asRecord(event: EntityResult): AvailabilityRecord {
  return {
    start: text(event.document, "start"),
    finish: text(event.document, "finish"),
    kind: text(event.document, "kind") || "other",
    state: text(event.document, "state") || "planned",
    lifecycle: text(event.document, "lifecycle"),
  };
}

function eventDays(event: EntityResult, calendar: WorkingCalendar): number {
  const start = text(event.document, "start");
  const finish = text(event.document, "finish");
  return isIsoDate(start) && isIsoDate(finish) && start <= finish ? workingDayCount(start, finish, calendar) : 0;
}

function displayStateKey(event: EntityResult, today: string): MessageKey {
  const state = text(event.document, "state");
  if (state !== "cancelled" && isPastAbsence(text(event.document, "finish"), today)) return "availability.past";
  return stateKey(state);
}

export function PeopleAvailability({ events, extraDays = 0, extraDaysReason = "", locale, onCreate, onUpdate, onUpdateAllowance, personId, readOnly, t, today = localCalendarDate(), calendar = DEFAULT_WORKING_CALENDAR }: {
  readonly events: readonly EntityResult[];
  readonly extraDays?: number;
  readonly extraDaysReason?: string;
  readonly locale: Locale;
  readonly onCreate: (document: GitPmDocument) => Promise<boolean>;
  readonly onUpdate: (event: EntityResult, document: GitPmDocument) => Promise<boolean>;
  readonly onUpdateAllowance: (extraDays: number, reason: string) => Promise<boolean>;
  readonly personId: string;
  readonly readOnly: boolean;
  readonly t: Translate;
  readonly today?: string;
  readonly calendar?: WorkingCalendar;
}) {
  const [editing, setEditing] = useState<EntityResult | "new" | null>(null);
  const [allowanceEditorOpen, setAllowanceEditorOpen] = useState(false);
  const [allowanceExtraDays, setAllowanceExtraDays] = useState(extraDays);
  const [allowanceReason, setAllowanceReason] = useState(extraDaysReason);
  useEffect(() => {
    if (allowanceEditorOpen) return;
    setAllowanceExtraDays(extraDays);
    setAllowanceReason(extraDaysReason);
  }, [allowanceEditorOpen, extraDays, extraDaysReason]);
  const active = events.filter((event) => event.document.lifecycle === "active").sort((left, right) => text(left.document, "start").localeCompare(text(right.document, "start")) || left.document.id.localeCompare(right.document.id));
  const upcoming = active.filter((event) => !isPastAbsence(text(event.document, "finish"), today));
  const past = active.filter((event) => isPastAbsence(text(event.document, "finish"), today));
  const allowance = annualVacationAllowance(extraDays);
  const year = vacationYearBalance(active.map(asRecord), today, calendar, allowance);
  const selected = editing === "new" || editing === null ? undefined : editing;
  const title = editing === "new" ? t("availability.add") : t("availability.edit");
  const save = async (form: HTMLFormElement) => {
    const data = new FormData(form);
    const note = String(data.get("note") ?? "").trim();
    const values = {
      person: personId,
      start: String(data.get("start") ?? ""),
      finish: String(data.get("finish") ?? ""),
      kind: String(data.get("kind") ?? "other"),
      availability_percent: Number(data.get("availability_percent")),
      state: String(data.get("state") ?? "planned"),
      ...(note === "" ? {} : { note_markdown: note }),
      lifecycle: "active",
    };
    const success = editing === "new"
      ? await onCreate({ schema: "gitpm/availability-event@1", id: newUniqueEntityId(ENTITY_ID_PREFIX.availability, new Set(events.map((event) => event.document.id))), ...values } as GitPmDocument)
      : selected !== undefined && await onUpdate(selected, { ...selected.document, ...values } as GitPmDocument);
    if (success) setEditing(null);
  };
  const saveAllowance = async () => {
    const success = await onUpdateAllowance(allowanceExtraDays, allowanceReason.trim());
    if (success) setAllowanceEditorOpen(false);
  };

  return <section className="card people-profile-section people-availability-section">
    <div className="card-heading"><div><h3>{t("availability.heading")}</h3><p>{t("availability.description")}</p></div><button className="primary" disabled={readOnly} onClick={() => setEditing("new")} type="button">{t("availability.add")}</button></div>
    <div className="people-availability-year-row"><p className="people-availability-year">{extraDays > 0
      ? t("availability.yearHeadingExtra", { year: today.slice(0, 4), count: year.allowance, base: ANNUAL_VACATION_DAYS, extra: extraDays })
      : t("availability.yearHeading", { year: today.slice(0, 4), count: year.allowance })}</p><button className="people-availability-allowance-action" disabled={readOnly} onClick={() => setAllowanceEditorOpen(true)} type="button">{t("availability.adjustAllowance")}</button></div>
    {extraDays > 0 && extraDaysReason !== "" && <p className="people-availability-extra-reason">{t("availability.extraReason", { reason: extraDaysReason })}</p>}
    <dl className="people-availability-summary">
      <div><dt>{t("availability.yearTaken")}</dt><dd>{t("availability.eventDays", { count: year.taken, unit: dayUnit(locale, year.taken) })}</dd></div>
      <div><dt>{t("availability.yearRemaining")}</dt><dd>{t("availability.eventDays", { count: year.remaining, unit: dayUnit(locale, year.remaining) })}</dd></div>
      <div><dt>{t("availability.yearPlanned")}</dt><dd>{t("availability.eventDays", { count: year.planned, unit: dayUnit(locale, year.planned) })}</dd></div>
    </dl>
    {upcoming.length === 0 ? <p className="people-empty">{t("availability.noUpcoming")}</p> : <div className="people-availability-list">{upcoming.map((event) => <AbsenceRow calendar={calendar} event={event} key={event.document.id} locale={locale} onOpen={() => setEditing(event)} readOnly={readOnly} t={t} today={today} />)}</div>}
    {past.length > 0 && <details className="people-availability-past"><summary>{t("availability.pastGroup", { count: past.length })}</summary><div className="people-availability-list">{past.map((event) => <AbsenceRow calendar={calendar} event={event} key={event.document.id} locale={locale} onOpen={() => setEditing(event)} readOnly={readOnly} t={t} today={today} />)}</div></details>}
    <EditorDrawer closeLabel={t("core.closeEditor")} onClose={() => setEditing(null)} open={editing !== null} title={title}>
      {editing !== null && <form className="editor-drawer-form" key={editing === "new" ? "new" : editing.document.id} onSubmit={(event) => { event.preventDefault(); void save(event.currentTarget); }}>
        <label data-field-hint={t("fieldHint.availabilityStart")}>{t("availability.start")}<input defaultValue={selected === undefined ? "" : text(selected.document, "start")} name="start" required type="date" /></label>
        <label data-field-hint={t("fieldHint.availabilityFinish")}>{t("availability.finish")}<input defaultValue={selected === undefined ? "" : text(selected.document, "finish")} name="finish" required type="date" /></label>
        <label data-field-hint={t("fieldHint.availabilityKind")}>{t("availability.kind")}<select defaultValue={selected === undefined ? "vacation" : text(selected.document, "kind")} name="kind"><option value="vacation">{t("availability.kindVacation")}</option><option value="day-off">{t("availability.kindDayOff")}</option><option value="sick-leave">{t("availability.kindSickLeave")}</option><option value="training">{t("availability.kindTraining")}</option><option value="other">{t("availability.kindOther")}</option></select></label>
        <label>{t("availability.percent")}<input defaultValue={selected === undefined ? 0 : number(selected.document, "availability_percent")} max="100" min="0" name="availability_percent" required step="0.25" type="number" /></label>
        <label data-field-hint={t("fieldHint.availabilityState")}>{t("availability.state")}<select defaultValue={selected === undefined ? "planned" : text(selected.document, "state")} name="state"><option value="planned">{t("availability.statePlanned")}</option><option value="taken">{t("availability.stateTaken")}</option><option value="cancelled">{t("availability.stateCancelled")}</option></select></label>
        <label>{t("availability.note")}<textarea defaultValue={selected === undefined ? "" : text(selected.document, "note_markdown")} name="note" rows={4} /></label>
        <div className="editor-drawer-actions"><button onClick={() => setEditing(null)} type="button">{t("core.cancel")}</button><button className="primary" disabled={readOnly}>{t("core.save")}</button></div>
      </form>}
    </EditorDrawer>
    <EditorDrawer closeLabel={t("core.closeEditor")} onClose={() => setAllowanceEditorOpen(false)} open={allowanceEditorOpen} title={t("availability.allowanceEditorTitle")}>
      <form className="editor-drawer-form" onSubmit={(event) => { event.preventDefault(); void saveAllowance(); }}>
        <label>{t("availability.allowanceDays")}<input aria-label={t("availability.allowanceDays")} min="0" name="annual_vacation_extra_days" onChange={(event) => setAllowanceExtraDays(Number(event.target.value))} step="1" type="number" value={allowanceExtraDays} /><small className="field-help">{t("people.vacationExtraHint")}</small></label>
        <label data-field-hint={t("fieldHint.vacationExtraReason")}>{t("availability.allowanceReason")}<textarea aria-label={t("availability.allowanceReason")} name="annual_vacation_extra_days_reason" onChange={(event) => setAllowanceReason(event.target.value)} required={allowanceExtraDays > 0} rows={3} value={allowanceReason} /></label>
        <div className="editor-drawer-actions"><button onClick={() => setAllowanceEditorOpen(false)} type="button">{t("core.cancel")}</button><button className="primary" disabled={readOnly}>{t("core.save")}</button></div>
      </form>
    </EditorDrawer>
  </section>;
}

function AbsenceRow({ calendar, event, locale, onOpen, readOnly, t, today }: {
  readonly calendar: WorkingCalendar;
  readonly event: EntityResult;
  readonly locale: Locale;
  readonly onOpen: () => void;
  readonly readOnly: boolean;
  readonly t: Translate;
  readonly today: string;
}) {
  const days = eventDays(event, calendar);
  const past = isPastAbsence(text(event.document, "finish"), today);
  return <button className={`${text(event.document, "state")}${past ? " past" : ""}`} disabled={readOnly} onClick={onOpen} type="button">
    <span><strong>{availabilityKindLabel(t, text(event.document, "kind"))}</strong><small>{t(displayStateKey(event, today))}</small></span>
    <time>{t("availability.range", { start: formatDateOnly(locale, text(event.document, "start")), finish: formatDateOnly(locale, text(event.document, "finish")) })}</time>
    <span>{t("availability.eventDays", { count: days, unit: dayUnit(locale, days) })}</span>
    <span>{t("availability.availablePercent", { percent: formatNumber(locale, number(event.document, "availability_percent")) })}</span>
  </button>;
}
