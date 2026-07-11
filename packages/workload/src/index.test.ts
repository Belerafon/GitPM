import { describe, expect, it } from "vitest";
import { calculateWorkload } from "./index.js";

const calendar = { id: "CAL-1", lifecycle: "active" as const, working_weekdays: [1, 2, 3, 4, 5], holidays: ["2026-07-08"] };
const ada = { id: "PER-ADA", name: "Ada", lifecycle: "active" as const, weekly_capacity_hours: 40, calendar: calendar.id };
const linus = { id: "PER-LINUS", name: "Linus", lifecycle: "active" as const, weekly_capacity_hours: 32, calendar: calendar.id };

describe("workload calculator", () => {
  it("splits estimates by assignee and their working dates, then compares holiday-adjusted capacity", () => {
    const report = calculateWorkload([
      { id: "TSK-SHARED", title: "Shared", lifecycle: "active", estimate_hours: 40, start: "2026-07-06", due: "2026-07-10", assignees: [ada.id, linus.id] },
      { id: "TSK-ADA", title: "Ada only", lifecycle: "active", estimate_hours: 8, start: "2026-07-09", due: "2026-07-10", assignees: [ada.id] },
    ], [ada, linus], [calendar]);
    expect(report.weeks).toEqual(["2026-07-06"]);
    expect(report.rows).toEqual([
      { person_id: ada.id, person_name: "Ada", week: "2026-07-06", allocated_hours: 28, capacity_hours: 32, utilization_percent: 87.5, task_ids: ["TSK-ADA", "TSK-SHARED"] },
      { person_id: linus.id, person_name: "Linus", week: "2026-07-06", allocated_hours: 20, capacity_hours: 25.6, utilization_percent: 78.125, task_ids: ["TSK-SHARED"] },
    ]);
  });

  it("spreads a person share across ISO weeks and reports deterministic exclusions", () => {
    const report = calculateWorkload([
      { id: "TSK-SPAN", title: "Span", lifecycle: "active", estimate_hours: 36, start: "2026-07-09", due: "2026-07-15", assignees: [ada.id] },
      { id: "TSK-ARCHIVED", title: "Archived", lifecycle: "archived", estimate_hours: 10, start: "2026-07-06", due: "2026-07-10", assignees: [ada.id] },
      { id: "TSK-UNDATED", title: "Undated", lifecycle: "active", estimate_hours: 10, assignees: [ada.id] },
      { id: "TSK-UNESTIMATED", title: "Unestimated", lifecycle: "active", start: "2026-07-06", due: "2026-07-10", assignees: [ada.id] },
      { id: "TSK-UNASSIGNED", title: "Unassigned", lifecycle: "active", estimate_hours: 10, start: "2026-07-06", due: "2026-07-10" },
      { id: "TSK-MISSING", title: "Missing person", lifecycle: "active", estimate_hours: 10, start: "2026-07-06", due: "2026-07-10", assignees: ["PER-MISSING"] },
    ], [ada], [calendar]);
    expect(report.rows.filter((row) => row.person_id === ada.id).map((row) => [row.week, row.allocated_hours])).toEqual([["2026-07-06", 14.4], ["2026-07-13", 21.6]]);
    expect(report.exclusions).toEqual({ archived: 1, undated: 1, unestimated: 1, unassigned: 1, unavailable_assignees: 1 });
  });
});
