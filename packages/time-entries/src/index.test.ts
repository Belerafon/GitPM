import { describe, expect, it } from "vitest";
import {
  activeEntries,
  actualSegments,
  actualWindow,
  groupByCategory,
  groupByDate,
  groupByPerson,
  groupByProject,
  groupByTask,
  groupByWeek,
  hoursAfterDate,
  isoWeekStart,
  sumHours,
  validateEntry,
  type TimeEntryRecord,
} from "./index.js";

const entry = (overrides: Partial<TimeEntryRecord> & Pick<TimeEntryRecord, "id">): TimeEntryRecord => ({
  project: "P-26-1",
  task: "T-26-1",
  person: "U-26-A",
  performed_on: "2026-08-17",
  hours: 3.5,
  category: "warranty",
  state: "active",
  ...overrides,
});

const entries: readonly TimeEntryRecord[] = [
  entry({ id: "E-26-1", performed_on: "2026-08-17", hours: 3.5, person: "U-26-A", category: "warranty" }),
  entry({ id: "E-26-2", performed_on: "2026-08-18", hours: 4, person: "U-26-B", category: "regular" }),
  entry({ id: "E-26-3", performed_on: "2026-08-25", hours: 2.25, person: "U-26-A", category: "regular", task: "T-26-2" }),
  entry({ id: "E-26-4", performed_on: "2026-12-12", hours: 1.5, person: "U-26-A", category: "support", state: "voided" }),
];

describe("active filtering and totals", () => {
  it("ignores voided entries", () => {
    expect(activeEntries(entries)).toHaveLength(3);
  });

  it("sums active hours", () => {
    expect(sumHours(entries)).toBe(9.75);
  });
});

describe("grouping", () => {
  it("groups by person, category, task and project", () => {
    expect([...groupByPerson(entries).entries()].sort()).toEqual([["U-26-A", 5.75], ["U-26-B", 4]]);
    expect([...groupByCategory(entries).entries()].sort()).toEqual([["regular", 6.25], ["warranty", 3.5]]);
    expect(groupByTask(entries).get("T-26-2")).toBe(2.25);
    expect(groupByProject(entries).get("P-26-1")).toBe(9.75);
  });

  it("groups by date and ISO week", () => {
    expect([...groupByDate(entries).entries()].sort()).toEqual([["2026-08-17", 3.5], ["2026-08-18", 4], ["2026-08-25", 2.25]]);
    expect(isoWeekStart("2026-08-17")).toBe("2026-08-17");
    expect(isoWeekStart("2026-08-19")).toBe("2026-08-17");
    expect(isoWeekStart("2026-08-23")).toBe("2026-08-17");
    expect(isoWeekStart("2026-08-24")).toBe("2026-08-24");
    expect(groupByWeek(entries).get("2026-08-17")).toBe(7.5);
    expect(groupByWeek(entries).get("2026-08-24")).toBe(2.25);
  });
});

describe("actual window", () => {
  it("keeps activity discrete without stretching idle gaps", () => {
    const window = actualWindow(entries);
    expect(window).toEqual({
      start: "2026-08-17",
      finish: "2026-08-25",
      effort_hours: 9.75,
      activity_by_date: { "2026-08-17": 3.5, "2026-08-18": 4, "2026-08-25": 2.25 },
    });
  });

  it("returns undefined when there are no active entries", () => {
    expect(actualWindow([entry({ id: "E-26-9", state: "voided" })])).toBeUndefined();
  });

  it("exposes discrete actual segments", () => {
    expect(actualSegments(entries)).toEqual([
      { date: "2026-08-17", hours: 3.5 },
      { date: "2026-08-18", hours: 4 },
      { date: "2026-08-25", hours: 2.25 },
    ]);
  });
});

describe("hours after cutoff", () => {
  it("sums hours performed after the chosen graph finish", () => {
    expect(hoursAfterDate(entries, "2026-08-25")).toBe(0);
    expect(hoursAfterDate([...entries, entry({ id: "E-26-5", performed_on: "2026-12-12", hours: 2 })], "2026-08-25")).toBe(2);
  });

  it("rejects an invalid cutoff", () => {
    expect(() => hoursAfterDate(entries, "08/25/2026")).toThrow();
  });
});

describe("entry validation", () => {
  const context = {
    categories: new Set(["regular", "warranty", "support"]),
    tasks: new Set(["T-26-1", "T-26-2"]),
    people: new Set(["U-26-A", "U-26-B"]),
    projects: new Set(["P-26-1"]),
  };

  it("accepts a well-formed entry", () => {
    expect(validateEntry(entry({ id: "E-26-OK" }), context)).toEqual([]);
  });

  it("flags invalid hours, dates and unknown references", () => {
    const issues = validateEntry(entry({ id: "E-26-BAD", hours: 3.1, performed_on: "2026-13-40", category: "ghost", task: "T-26-GHOST", person: "U-26-GHOST", project: "P-26-GHOST" }), context);
    const codes = issues.map((issue) => issue.code);
    expect(codes).toContain("TIME_ENTRY_HOURS_INVALID");
    expect(codes).toContain("TIME_ENTRY_DATE_INVALID");
    expect(codes).toContain("TIME_ENTRY_CATEGORY_UNKNOWN");
    expect(codes).toContain("TIME_ENTRY_TASK_UNKNOWN");
    expect(codes).toContain("TIME_ENTRY_PERSON_UNKNOWN");
    expect(codes).toContain("TIME_ENTRY_PROJECT_UNKNOWN");
  });
});
