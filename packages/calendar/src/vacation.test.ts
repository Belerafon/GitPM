import { describe, expect, it } from "vitest";
import {
  annualVacationAllowance,
  availabilityProgress,
  currentAbsence,
  vacationSummary,
  vacationYearBalance,
  workingDayCount,
  type VacationEvent,
  type VacationPerson,
} from "./vacation.js";

const ada: VacationPerson = { id: "U-26-ADA", name: "Ada", lifecycle: "active", calendarId: "C-1", extraDays: 0, extraDaysReason: "" };
const vacation = (overrides: Partial<VacationEvent> & Pick<VacationEvent, "id" | "personId" | "start" | "finish">): VacationEvent => ({
  kind: "vacation",
  state: "active",
  note: "",
  lifecycle: "active",
  ...overrides,
});

describe("vacation leave calculations", () => {
  it("derives planned, in-progress and taken from dates and keeps cancellation independent of the calendar", () => {
    const active = { state: "active", start: "2026-08-17", finish: "2026-08-21" };
    expect(availabilityProgress(active, "2026-08-16")).toBe("planned");
    expect(availabilityProgress(active, "2026-08-17")).toBe("in-progress");
    expect(availabilityProgress(active, "2026-08-21")).toBe("in-progress");
    expect(availabilityProgress(active, "2026-08-22")).toBe("taken");
    expect(availabilityProgress({ state: "cancelled", start: "2026-08-17", finish: "2026-08-21" }, "2026-08-22")).toBe("cancelled");
  });

  it("adds a positive personal adjustment to the standard 20-day allowance", () => {
    expect(annualVacationAllowance()).toBe(20);
    expect(annualVacationAllowance(5)).toBe(25);
    expect(annualVacationAllowance(-2)).toBe(20);
  });

  it("counts working days without weekends", () => {
    expect(workingDayCount("2026-08-17", "2026-08-21")).toBe(5);
  });

  it("splits an in-progress vacation between taken and planned weekdays", () => {
    expect(vacationYearBalance([{ kind: "vacation", state: "active", lifecycle: "active", start: "2026-08-25", finish: "2026-08-28" }], "2026-08-26")).toEqual({
      taken: 1,
      planned: 3,
      remaining: 19,
      allowance: 20,
    });
  });

  it("summarizes absences and overlap for the visible people", () => {
    const events = [
      vacation({ id: "A-1", personId: ada.id, start: "2026-08-26", finish: "2026-08-28" }),
      vacation({ id: "A-2", personId: ada.id, start: "2026-09-01", finish: "2026-09-02" }),
    ];
    expect(vacationSummary(events, [ada], { start: "2026-08-01", finish: "2026-09-30", days: ["2026-08-26", "2026-09-01"] }, {
      teamId: "", personId: "", kind: "", state: "", search: "",
    }, "2026-08-26")).toEqual({ absentToday: 1, leavingSoon: 1, maxOverlap: 1 });
    expect(currentAbsence(events, "2026-08-26")?.start).toBe("2026-08-26");
  });
});
