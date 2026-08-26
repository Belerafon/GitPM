import { describe, expect, it } from "vitest";
import {
  addDays,
  barGeometry,
  clipToWindow,
  inclusiveDayCount,
  VACATION_CALENDAR_DAY_WIDTH,
  vacationBars,
  vacationCalendarWindow,
  vacationSummary,
  visiblePeople,
  isWeekend,
  weekendBands,
  type VacationEvent,
  type VacationPerson,
  type VacationTeam,
} from "./vacation-calendar-model.js";

const ada: VacationPerson = { id: "U-26-ADA", name: "Ada", lifecycle: "active" };
const linus: VacationPerson = { id: "U-26-LINUS", name: "Linus", lifecycle: "active" };
const grace: VacationPerson = { id: "U-26-GRACE", name: "Grace", lifecycle: "archived" };
const core: VacationTeam = { id: "G-26-CORE", name: "Core", members: [ada.id], lifecycle: "active" };
const vacation = (overrides: Partial<VacationEvent> & Pick<VacationEvent, "id" | "personId" | "start" | "finish">): VacationEvent => ({
  kind: "vacation",
  state: "planned",
  note: "",
  lifecycle: "active",
  ...overrides,
});

describe("vacation calendar geometry", () => {
  it("builds a 6-month window from the start of the current month", () => {
    const window = vacationCalendarWindow("2026-08-26", 6);
    expect(window.start).toBe("2026-08-01");
    expect(window.finish).toBe("2027-01-31");
    expect(window.days[0]).toBe("2026-08-01");
    expect(window.days.at(-1)).toBe("2027-01-31");
    expect(window.months.map((segment) => segment.key)).toEqual(["2026-08", "2026-09", "2026-10", "2026-11", "2026-12", "2027-01"]);
    expect(window.dayWidth).toBe(VACATION_CALENDAR_DAY_WIDTH[6]);
    expect(window.timelineWidth).toBe(window.days.length * VACATION_CALENDAR_DAY_WIDTH[6]);
  });

  it("builds a 12-month window that keeps August through the following July", () => {
    const window = vacationCalendarWindow("2026-08-26", 12);
    expect(window.start).toBe("2026-08-01");
    expect(window.finish).toBe("2027-07-31");
    expect(window.months).toHaveLength(12);
    expect(window.dayWidth).toBe(VACATION_CALENDAR_DAY_WIDTH[12]);
  });

  it("counts inclusive calendar days and places a bar from the window origin", () => {
    expect(inclusiveDayCount("2026-08-17", "2026-08-21")).toBe(5);
    const geometry = barGeometry("2026-08-17", "2026-08-21", "2026-08-01", 10);
    expect(geometry).toEqual({ offset: 16, duration: 5, left: 160, width: 50 });
  });

  it("clips a bar that starts before the visible window", () => {
    expect(clipToWindow("2026-07-20", "2026-08-05", "2026-08-01", "2027-01-31")).toEqual({ start: "2026-08-01", finish: "2026-08-05" });
    expect(clipToWindow("2026-06-01", "2026-06-10", "2026-08-01", "2027-01-31")).toBeUndefined();
  });

  it("keeps a December vacation visible in both 6-month and 12-month views with scaled widths", () => {
    const event = vacation({ id: "A-26-VACATN", personId: ada.id, start: "2026-12-28", finish: "2026-12-31" });
    const six = vacationCalendarWindow("2026-08-26", 6);
    const twelve = vacationCalendarWindow("2026-08-26", 12);
    const sixBar = vacationBars([event], [ada], six, { teamId: "", personId: "", kind: "", state: "", search: "" })[0]!;
    const twelveBar = vacationBars([event], [ada], twelve, { teamId: "", personId: "", kind: "", state: "", search: "" })[0]!;
    expect(sixBar.offset).toBe(twelveBar.offset);
    expect(sixBar.duration).toBe(4);
    expect(sixBar.width).toBe(4 * VACATION_CALENDAR_DAY_WIDTH[6]);
    expect(twelveBar.width).toBe(4 * VACATION_CALENDAR_DAY_WIDTH[12]);
    expect(sixBar.left).toBe(sixBar.offset * VACATION_CALENDAR_DAY_WIDTH[6]);
    expect(twelveBar.left).toBe(twelveBar.offset * VACATION_CALENDAR_DAY_WIDTH[12]);
  });

  it("builds a whole-year window from 1 January through 31 December", () => {
    const window = vacationCalendarWindow("2026-08-26", "year");
    expect(window.start).toBe("2026-01-01");
    expect(window.finish).toBe("2026-12-31");
    expect(window.months).toHaveLength(12);
    expect(window.months[0]?.key).toBe("2026-01");
    expect(window.months.at(-1)?.key).toBe("2026-12");
    expect(window.dayWidth).toBe(VACATION_CALENDAR_DAY_WIDTH.year);
    expect(window.days).toHaveLength(365);
  });

  it("marks Saturday and Sunday as weekend bands", () => {
    expect(isWeekend("2026-08-01")).toBe(true);
    expect(isWeekend("2026-08-02")).toBe(true);
    expect(isWeekend("2026-08-03")).toBe(false);
    const bands = weekendBands(["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-08", "2026-08-09"], 10);
    expect(bands).toEqual([
      { start: "2026-08-01", finish: "2026-08-02", left: 0, width: 20 },
      { start: "2026-08-08", finish: "2026-08-09", left: 30, width: 20 },
    ]);
  });

  it("shows a far-future absence only in the 12-month view", () => {
    const event = vacation({ id: "A-26-JULY", personId: ada.id, start: "2027-07-01", finish: "2027-07-05" });
    const six = vacationBars([event], [ada], vacationCalendarWindow("2026-08-26", 6), { teamId: "", personId: "", kind: "", state: "", search: "" });
    const twelve = vacationBars([event], [ada], vacationCalendarWindow("2026-08-26", 12), { teamId: "", personId: "", kind: "", state: "", search: "" });
    expect(six).toHaveLength(0);
    expect(twelve).toHaveLength(1);
    expect(twelve[0]?.duration).toBe(5);
  });
});

describe("vacation calendar filters and summary", () => {
  const events: readonly VacationEvent[] = [
    vacation({ id: "A-26-TODAY", personId: ada.id, start: "2026-08-26", finish: "2026-08-28", kind: "vacation" }),
    vacation({ id: "A-26-SOON", personId: linus.id, start: "2026-09-10", finish: "2026-09-12", kind: "sick-leave", state: "taken" }),
    vacation({ id: "A-26-CANCEL", personId: ada.id, start: "2026-10-01", finish: "2026-10-02", state: "cancelled" }),
    vacation({ id: "A-26-ARCHIVED", personId: grace.id, start: "2026-08-26", finish: "2026-08-27" }),
  ];
  const people = [ada, linus, grace];
  const empty = { teamId: "", personId: "", kind: "", state: "", search: "" };

  it("filters people by team, person, and case-insensitive name search", () => {
    expect(visiblePeople(people, [core], { ...empty, teamId: core.id }).map((person) => person.id)).toEqual([ada.id]);
    expect(visiblePeople(people, [core], { ...empty, personId: linus.id }).map((person) => person.id)).toEqual([linus.id]);
    expect(visiblePeople(people, [core], { ...empty, search: "lin" }).map((person) => person.id)).toEqual([linus.id]);
    expect(visiblePeople(people, [core], empty).map((person) => person.id)).toEqual([ada.id, linus.id]);
  });

  it("hides cancelled events by default and can isolate them by state", () => {
    const window = vacationCalendarWindow("2026-08-26", 6);
    expect(vacationBars(events, [ada, linus], window, empty).map((bar) => bar.id)).toEqual(["A-26-TODAY", "A-26-SOON"]);
    expect(vacationBars(events, [ada, linus], window, { ...empty, state: "cancelled" }).map((bar) => bar.id)).toEqual(["A-26-CANCEL"]);
    expect(vacationBars(events, [ada, linus], window, { ...empty, kind: "sick-leave" }).map((bar) => bar.id)).toEqual(["A-26-SOON"]);
  });

  it("counts people absent today, leaving within 30 days, and the peak overlap in the window", () => {
    const window = vacationCalendarWindow("2026-08-26", 6);
    expect(vacationSummary(events, [ada, linus], window, empty, "2026-08-26")).toEqual({ absentToday: 1, leavingSoon: 1, maxOverlap: 1 });
    const overlap = vacation({ id: "A-26-OVERLAP", personId: linus.id, start: "2026-08-26", finish: "2026-08-26", kind: "day-off" });
    expect(vacationSummary([...events, overlap], [ada, linus], window, empty, "2026-08-26").maxOverlap).toBe(2);
    expect(addDays("2026-08-26", 30)).toBe("2026-09-25");
  });
});
