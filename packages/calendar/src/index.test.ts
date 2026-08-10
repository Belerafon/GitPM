import { describe, expect, it } from "vitest";
import { availabilityPercentOnDate, CALENDAR_PRESETS, calendarPreset, isWorkingDate, isoWeekday, parseDateOnly, workingDatesBetween } from "./index.js";
import type { CalendarError } from "./index.js";

const calendar = {
  working_weekdays: [1, 2, 3, 4, 5],
  holidays: ["2026-07-13"],
};

describe("date-only calendar", () => {
  it("uses ISO weekdays without local timezone conversion", () => {
    expect(isoWeekday("2026-07-10")).toBe(5);
    expect(isoWeekday("2026-07-12")).toBe(7);
  });

  it("excludes weekends and holidays from an inclusive range", () => {
    expect(workingDatesBetween("2026-07-10", "2026-07-14", calendar)).toEqual(["2026-07-10", "2026-07-14"]);
    expect(isWorkingDate("2026-07-13", calendar)).toBe(false);
  });

  it.each(["2026-02-30", "2026-13-01", "2026-7-01"])("rejects invalid date %s", (value) => {
    expect(() => parseDateOnly(value)).toThrowError(expect.objectContaining<Partial<CalendarError>>({ code: "DATE_INVALID" }));
  });

  it("rejects an inverted range", () => {
    expect(() => workingDatesBetween("2026-07-14", "2026-07-10", calendar)).toThrowError(
      expect.objectContaining<Partial<CalendarError>>({ code: "DATE_RANGE" }),
    );
  });

  it("resolves personal availability without changing the shared calendar", () => {
    const exceptions = [{ start: "2026-07-09", finish: "2026-07-10", availability_percent: 0 }, { start: "2026-07-10", finish: "2026-07-10", availability_percent: 50 }];
    expect(availabilityPercentOnDate("2026-07-08", exceptions)).toBe(100);
    expect(availabilityPercentOnDate("2026-07-09", exceptions)).toBe(0);
    expect(availabilityPercentOnDate("2026-07-10", exceptions)).toBe(0);
  });

  it("provides validated built-in presets", () => {
    expect(CALENDAR_PRESETS.map((preset) => preset.id)).toEqual([
      "standard-five-day",
      "russia-2026-five-day",
      "every-day",
    ]);
    for (const preset of CALENDAR_PRESETS) {
      expect(() => workingDatesBetween("2026-07-01", "2026-07-07", preset)).not.toThrow();
    }
  });

  it("matches the official Russian five-day calendar for 2026", () => {
    const preset = calendarPreset("russia-2026-five-day");
    expect(preset.holidays).toHaveLength(14);
    expect(workingDatesBetween("2026-01-01", "2026-12-31", preset)).toHaveLength(247);
    expect(isWorkingDate("2026-01-09", preset)).toBe(false);
    expect(isWorkingDate("2026-01-12", preset)).toBe(true);
    expect(isWorkingDate("2026-12-31", preset)).toBe(false);
  });
});
