import { describe, expect, it } from "vitest";
import { isWorkingDate, isoWeekday, parseDateOnly, workingDatesBetween } from "./index.js";
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
});
