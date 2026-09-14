import { describe, expect, it } from "vitest";
import { buildWorkloadReport, calculateWorkload, type WorkloadEntityDocument, type WorkloadTask } from "./index.js";

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

const tracks = { schema: "gitpm/schedule-tracks@1", tracks: [{ slug: "plan", title: "Plan", kind: "manual", capabilities: ["dates", "effort"] }], defaults: { enabled_tracks: ["plan"], primary_track: "plan", workload_track: "plan", dashboard_tracks: ["plan"] } };
const entity = (document: WorkloadEntityDocument): WorkloadEntityDocument => document;
const reportInput = {
  scheduleTracks: tracks,
  calendars: [entity({ schema: "gitpm/calendar@1", id: calendar.id, working_weekdays: calendar.working_weekdays, holidays: calendar.holidays, lifecycle: "active" })],
  projects: [entity({ schema: "gitpm/project@2", id: project.id, lifecycle: "active" })],
  people: [
    entity({ schema: "gitpm/person@1", id: ada.id, name: "Ada", weekly_capacity_hours: 40, calendar: calendar.id, lifecycle: "active" }),
    entity({ schema: "gitpm/person@1", id: linus.id, name: "Linus", weekly_capacity_hours: 32, calendar: calendar.id, lifecycle: "active" }),
  ],
  teams: [entity({ schema: "gitpm/team@1", id: "G-26-REVIEW", name: "Reviewers", members: [linus.id], lifecycle: "active" })],
  tasks: [
    entity({ schema: "gitpm/task@2", id: "T-26-SHARED", project: project.id, title: "Shared", lifecycle: "active", assignees: [ada.id, linus.id], schedules: { plan: { effort_hours: 40, start: "2026-07-06", finish: "2026-07-10" } } }),
    entity({ schema: "gitpm/task@2", id: "T-26-ADA000", project: project.id, title: "Ada only", lifecycle: "active", assignees: [ada.id], schedules: { plan: { effort_hours: 8, start: "2026-07-06", finish: "2026-07-10" } } }),
  ],
};

describe("workload person and task scopes", () => {
  it("limits rows to team members and keeps outsider shares out of the grid", () => {
    const report = buildWorkloadReport({ ...reportInput, filters: { team: "G-26-REVIEW" } });
    expect(report.included_tasks).toBe(2);
    expect(report.rows.map((row) => row.person_id)).toEqual([linus.id]);
    expect(report.rows[0]).toMatchObject({ allocated_hours: 20, task_ids: ["T-26-SHARED"] });
    expect(report.person_census).toEqual({ total_active: 2, scoped: 1, calculable: 1, without_calendar: [] });
  });

  it("keeps selected people in rows when a project filter leaves them with zero hours", () => {
    const otherProject = entity({ schema: "gitpm/project@2", id: "P-26-OTHER0", lifecycle: "active" });
    const report = buildWorkloadReport({
      ...reportInput,
      projects: [...reportInput.projects, otherProject],
      filters: { team: "G-26-REVIEW", project: otherProject.id as string, from: "2026-07-06", weeks: 1 },
    });
    expect(report.included_tasks).toBe(0);
    expect(report.weeks).toEqual(["2026-07-06"]);
    expect(report.rows).toEqual([expect.objectContaining({ person_id: linus.id, allocated_hours: 0, task_ids: [] })]);
    expect(report.person_census.scoped).toBe(1);
  });

  it("emits the requested calendar window even when a week has no tasks", () => {
    const report = buildWorkloadReport({ ...reportInput, filters: { person: ada.id, from: "2026-07-06", weeks: 2 } });
    expect(report.weeks).toEqual(["2026-07-06", "2026-07-13"]);
    expect(report.rows).toHaveLength(2);
    expect(report.rows[1]).toMatchObject({ person_id: ada.id, week: "2026-07-13", allocated_hours: 0 });
  });

  it("counts scoped people without an active calendar instead of dropping them", () => {
    const report = buildWorkloadReport({
      ...reportInput,
      people: [
        ...reportInput.people,
        entity({ schema: "gitpm/person@1", id: "U-26-NOCAL0", name: "No Calendar", weekly_capacity_hours: 40, calendar: "C-26-MISSING", lifecycle: "active" }),
      ],
      teams: [entity({ schema: "gitpm/team@1", id: "G-26-REVIEW", name: "Reviewers", members: [linus.id, "U-26-NOCAL0"], lifecycle: "active" })],
      filters: { team: "G-26-REVIEW" },
    });
    expect(report.rows.map((row) => row.person_id)).toEqual([linus.id]);
    expect(report.person_census).toEqual({
      total_active: 3,
      scoped: 2,
      calculable: 1,
      without_calendar: [{ person_id: "U-26-NOCAL0", person_name: "No Calendar" }],
    });
  });
});
