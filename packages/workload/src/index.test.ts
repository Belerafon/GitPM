import { describe, expect, it } from "vitest";
import { calculateWorkload, type WorkloadTask } from "./index.js";

const calendar = { id: "C-26-111111", lifecycle: "active" as const, working_weekdays: [1, 2, 3, 4, 5], holidays: ["2026-07-08"] };
const ada = { id: "U-26-ADA000", name: "Ada", lifecycle: "active" as const, weekly_capacity_hours: 40, calendar: calendar.id };
const linus = { id: "U-26-11N0S0", name: "Linus", lifecycle: "active" as const, weekly_capacity_hours: 32, calendar: calendar.id };
const project = { id: "P-26-ACT1VE", lifecycle: "active" as const };
const projectTask = (task: Omit<WorkloadTask, "project">): WorkloadTask => ({ project: project.id, ...task });

describe("workload calculator", () => {
  it("splits estimates by assignee and their working dates, then compares holiday-adjusted capacity", () => {
    const report = calculateWorkload([
      projectTask({ id: "T-26-SHARED", title: "Shared", lifecycle: "active", estimate_hours: 40, start: "2026-07-06", finish: "2026-07-10", assignees: [ada.id, linus.id] }),
      projectTask({ id: "T-26-ADA000", title: "Ada only", lifecycle: "active", estimate_hours: 8, start: "2026-07-09", finish: "2026-07-10", assignees: [ada.id] }),
    ], [ada, linus], [calendar], [project]);
    expect(report.weeks).toEqual(["2026-07-06"]);
    expect(report.rows).toEqual([
      { person_id: ada.id, person_name: "Ada", week: "2026-07-06", allocated_hours: 28, base_capacity_hours: 32, capacity_hours: 32, unavailable_hours: 0, utilization_percent: 87.5, task_ids: ["T-26-ADA000", "T-26-SHARED"], task_allocations: [{ task_id: "T-26-ADA000", allocated_hours: 8 }, { task_id: "T-26-SHARED", allocated_hours: 20 }] },
      { person_id: linus.id, person_name: "Linus", week: "2026-07-06", allocated_hours: 20, base_capacity_hours: 25.6, capacity_hours: 25.6, unavailable_hours: 0, utilization_percent: 78.125, task_ids: ["T-26-SHARED"], task_allocations: [{ task_id: "T-26-SHARED", allocated_hours: 20 }] },
    ]);
  });

  it("spreads a person share across ISO weeks and reports deterministic exclusions", () => {
    const report = calculateWorkload([
      projectTask({ id: "T-26-SPAN00", title: "Span", lifecycle: "active", estimate_hours: 36, start: "2026-07-09", finish: "2026-07-15", assignees: [ada.id] }),
      projectTask({ id: "T-26-ARCH1V", title: "Archived", lifecycle: "archived", estimate_hours: 10, start: "2026-07-06", finish: "2026-07-10", assignees: [ada.id] }),
      projectTask({ id: "T-26-VNDATD", title: "Undated", lifecycle: "active", estimate_hours: 10, assignees: [ada.id] }),
      projectTask({ id: "T-26-VNESTM", title: "Unestimated", lifecycle: "active", start: "2026-07-06", finish: "2026-07-10", assignees: [ada.id] }),
      projectTask({ id: "T-26-VNASGN", title: "Unassigned", lifecycle: "active", estimate_hours: 10, start: "2026-07-06", finish: "2026-07-10" }),
      projectTask({ id: "T-26-M1SS1N", title: "Missing person", lifecycle: "active", estimate_hours: 10, start: "2026-07-06", finish: "2026-07-10", assignees: ["U-26-M1SS1N"] }),
    ], [ada], [calendar], [project]);
    expect(report.rows.filter((row) => row.person_id === ada.id).map((row) => [row.week, row.allocated_hours])).toEqual([["2026-07-06", 14.4], ["2026-07-13", 21.6]]);
    expect(report.exclusions).toEqual({ archived: 1, undated: 1, unestimated: 1, unassigned: 1, unavailable_assignees: 1 });
  });

  it("does not reassign an unavailable assignee share to active assignees", () => {
    const archived = { ...linus, lifecycle: "archived" as const };
    const report = calculateWorkload([
      projectTask({ id: "T-26-SHARED", title: "Shared", lifecycle: "active", estimate_hours: 40, start: "2026-07-06", finish: "2026-07-10", assignees: [ada.id, archived.id] }),
    ], [ada, archived], [calendar], [project]);

    expect(report.rows).toEqual([
      { person_id: ada.id, person_name: "Ada", week: "2026-07-06", allocated_hours: 20, base_capacity_hours: 32, capacity_hours: 32, unavailable_hours: 0, utilization_percent: 62.5, task_ids: ["T-26-SHARED"], task_allocations: [{ task_id: "T-26-SHARED", allocated_hours: 20 }] },
    ]);
    expect(report.included_tasks).toBe(1);
    expect(report.exclusions.unavailable_assignees).toBe(1);
  });

  it("excludes an active task when its owning Project is archived", () => {
    const report = calculateWorkload([
      projectTask({ id: "T-26-0RPHAN", title: "Archived project task", lifecycle: "active", estimate_hours: 40, start: "2026-07-06", finish: "2026-07-10", assignees: [ada.id] }),
    ], [ada], [calendar], [{ ...project, lifecycle: "archived" }]);

    expect(report).toMatchObject({ included_tasks: 0, weeks: [], rows: [], exclusions: { archived: 1 } });
  });

  it("removes personal absence from capacity and never allocates task effort to a fully unavailable day", () => {
    const report = calculateWorkload([
      projectTask({ id: "T-26-LEAVE0", title: "Spans leave", lifecycle: "active", estimate_hours: 40, start: "2026-07-06", finish: "2026-07-10", assignees: [ada.id] }),
    ], [ada], [calendar], [project], [{
      id: "A-26-LEAVE0", person: ada.id, start: "2026-07-09", finish: "2026-07-09", availability_percent: 0, state: "planned", lifecycle: "active",
    }]);

    expect(report.formula).toBe("equal-assignee-share/capacity-weighted-person-day/v2");
    expect(report.rows[0]).toMatchObject({ allocated_hours: 40, base_capacity_hours: 32, capacity_hours: 24, unavailable_hours: 8, utilization_percent: 166.6667 });
  });
});
