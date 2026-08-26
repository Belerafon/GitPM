import { describe, expect, it } from "vitest";
import { currentAbsence, isPastAbsence, vacationYearBalance, type AvailabilityRecord } from "./people-availability-model.js";

const vacation = (overrides: Partial<AvailabilityRecord> & Pick<AvailabilityRecord, "start" | "finish">): AvailabilityRecord => ({
  kind: "vacation",
  state: "planned",
  lifecycle: "active",
  ...overrides,
});

describe("vacation year balance", () => {
  it("counts past vacation weekdays as taken and future weekdays as planned against a 20-day allowance", () => {
    const events = [
      vacation({ start: "2026-01-10", finish: "2026-01-19" }),
      vacation({ start: "2026-09-01", finish: "2026-09-05", state: "planned" }),
      vacation({ start: "2025-12-30", finish: "2026-01-02" }),
      vacation({ start: "2026-08-01", finish: "2026-08-02", state: "cancelled" }),
    ];
    expect(vacationYearBalance(events, "2026-08-26")).toEqual({ taken: 8, planned: 4, remaining: 12, allowance: 20 });
  });

  it("splits an in-progress vacation between taken and planned weekdays", () => {
    expect(vacationYearBalance([vacation({ start: "2026-08-25", finish: "2026-08-28" })], "2026-08-26")).toEqual({
      taken: 1,
      planned: 3,
      remaining: 19,
      allowance: 20,
    });
  });

  it("skips holidays from the working calendar so 2-4 November with a 4 November holiday is two days", () => {
    expect(vacationYearBalance(
      [vacation({ start: "2026-11-02", finish: "2026-11-04" })],
      "2026-08-26",
      { workingWeekdays: [1, 2, 3, 4, 5], holidays: ["2026-11-04"] },
    )).toEqual({ taken: 0, planned: 2, remaining: 20, allowance: 20 });
  });

  it("treats finished events as past even when still marked planned", () => {
    expect(isPastAbsence("2026-08-21", "2026-08-26")).toBe(true);
    expect(isPastAbsence("2026-08-26", "2026-08-26")).toBe(false);
    expect(currentAbsence([vacation({ start: "2026-08-25", finish: "2026-08-28" })], "2026-08-26")?.finish).toBe("2026-08-28");
    expect(currentAbsence([vacation({ start: "2026-08-17", finish: "2026-08-21" })], "2026-08-26")).toBeUndefined();
  });
});
