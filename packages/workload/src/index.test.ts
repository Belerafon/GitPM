import { describe, expect, it } from "vitest";
import { calculateWorkload } from "./index.js";

const calendar = { id: "C-26-111111", lifecycle: "active" as const, working_weekdays: [1, 2, 3, 4, 5], holidays: ["2026-07-08"] };
const ada = { id: "U-26-ADA000", name: "Ada", lifecycle: "active" as const, weekly_capacity_hours: 40, calendar: calendar.id };
const linus = { id: "U-26-11N0S0", name: "Linus", lifecycle: "active" as const, weekly_capacity_hours: 32, calendar: calendar.id };

describe("workload calculator", () => {
  it("splits estimates by assignee and their working dates, then compares holiday-adjusted capacity", () => {
    const report = calculateWorkload([
      { id: "T-26-SHARED", title: "Shared", lifecycle: "active", estimate_hours: 40, start: "2026-07-06", due: "2026-07-10", assignees: [ada.id, linus.id] },
      { id: "T-26-ADA000", title: "Ada only", lifecycle: "active", estimate_hours: 8, start: "2026-07-09", due: "2026-07-10", assignees: [ada.id] },
    ], [ada, linus], [calendar]);
    expect(report.weeks).toEqual(["2026-07-06"]);
    expect(report.rows).toEqual([
      { person_id: ada.id, person_name: "Ada", week: "2026-07-06", allocated_hours: 28, capacity_hours: 32, utilization_percent: 87.5, task_ids: ["T-26-ADA000", "T-26-SHARED"] },
      { person_id: linus.id, person_name: "Linus", week: "2026-07-06", allocated_hours: 20, capacity_hours: 25.6, utilization_percent: 78.125, task_ids: ["T-26-SHARED"] },
    ]);
  });

  it("spreads a person share across ISO weeks and reports deterministic exclusions", () => {
    const report = calculateWorkload([
      { id: "T-26-SPAN00", title: "Span", lifecycle: "active", estimate_hours: 36, start: "2026-07-09", due: "2026-07-15", assignees: [ada.id] },
      { id: "T-26-ARCH1V", title: "Archived", lifecycle: "archived", estimate_hours: 10, start: "2026-07-06", due: "2026-07-10", assignees: [ada.id] },
      { id: "T-26-VNDATD", title: "Undated", lifecycle: "active", estimate_hours: 10, assignees: [ada.id] },
      { id: "T-26-VNESTM", title: "Unestimated", lifecycle: "active", start: "2026-07-06", due: "2026-07-10", assignees: [ada.id] },
      { id: "T-26-VNASGN", title: "Unassigned", lifecycle: "active", estimate_hours: 10, start: "2026-07-06", due: "2026-07-10" },
      { id: "T-26-M1SS1N", title: "Missing person", lifecycle: "active", estimate_hours: 10, start: "2026-07-06", due: "2026-07-10", assignees: ["U-26-M1SS1N"] },
    ], [ada], [calendar]);
    expect(report.rows.filter((row) => row.person_id === ada.id).map((row) => [row.week, row.allocated_hours])).toEqual([["2026-07-06", 14.4], ["2026-07-13", 21.6]]);
    expect(report.exclusions).toEqual({ archived: 1, undated: 1, unestimated: 1, unassigned: 1, unavailable_assignees: 1 });
  });

  it("does not reassign an unavailable assignee share to active assignees", () => {
    const archived = { ...linus, lifecycle: "archived" as const };
    const report = calculateWorkload([
      { id: "T-26-SHARED", title: "Shared", lifecycle: "active", estimate_hours: 40, start: "2026-07-06", due: "2026-07-10", assignees: [ada.id, archived.id] },
    ], [ada, archived], [calendar]);

    expect(report.rows).toEqual([
      { person_id: ada.id, person_name: "Ada", week: "2026-07-06", allocated_hours: 20, capacity_hours: 32, utilization_percent: 62.5, task_ids: ["T-26-SHARED"] },
    ]);
    expect(report.included_tasks).toBe(1);
    expect(report.exclusions.unavailable_assignees).toBe(1);
  });
});
