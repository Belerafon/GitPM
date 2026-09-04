// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gitPmApi } from "./test-gitpm-api.js";
import { ScheduleResolver, scheduleTracksConfig } from "./schedules.js";
import type { ConfigurationDocument, ConfigurationResult, DraftStatus, EntityDocument, EntityResult, ProjectWorkspaceResult } from "./types.js";
import { BoardWorkspace } from "./board-ui.js";
import { CoreWorkspace } from "./core-ui.js";
import { GanttWorkspace } from "./gantt-ui.js";
import { PeopleProfileWorkspace } from "./people-profile-ui.js";
import { WorkloadWorkspace } from "./workload-ui.js";
import { ProjectScheduleSummary } from "./features/projects/project-schedule-summary.js";
import { ProjectPlanWorkspace } from "./features/projects/project-plan-workspace.js";

const fingerprint = "b".repeat(64);
const draft: DraftStatus = { draft_id: "DRF-SCHED", owner_gitlab_user_id: "42", branch: "gitpm/42/DRF-SCHED", base_commit: "a".repeat(40), writer_mode: "ui", state: "open", fingerprint, created_at: "2026-07-01T00:00:00.000Z", updated_at: "2026-07-01T00:00:00.000Z" };

const tracksConfig = (): ConfigurationDocument => ({ schema: "gitpm/schedule-tracks@1", tracks: [{ slug: "working", title: "Working", kind: "manual", capabilities: ["dates", "effort", "dependencies"] }, { slug: "target", title: "Target", kind: "manual", capabilities: ["dates"] }, { slug: "actual", title: "Actual", kind: "actual", source: "time_entries" }], defaults: { enabled_tracks: ["working", "target", "actual"], primary_track: "working", workload_track: "working", dashboard_tracks: ["working", "target", "actual"] } });
const planning = { primary_track: "working", workload_track: "working", enabled_tracks: ["working", "target", "actual"], dashboard_tracks: ["working", "target", "actual"] };

const result = (document: EntityDocument): EntityResult => ({ document, path: `${document.id}.yaml`, blob_id: "a".repeat(40), draft_fingerprint: fingerprint });
const configResult = (document: ConfigurationDocument): ConfigurationResult => ({ document, path: document.schema, blob_id: "a".repeat(40), draft_fingerprint: fingerprint });

const schemaByType: Record<string, string> = { people: "gitpm/person@1", calendars: "gitpm/calendar@1", teams: "gitpm/team@1", projects: "gitpm/project@2", tasks: "gitpm/task@2", milestones: "gitpm/milestone@2", views: "gitpm/saved-view@1" };
const listEntitiesMock = (entities: readonly EntityResult[]) => vi.fn(async (_draftId: string, type: string, project?: string) => entities.filter((item) => item.document.schema === schemaByType[type] && (project === undefined || item.document.project === project)));
const buildGetConfiguration = () => vi.fn(async (_draftId: string, kind: string): Promise<ConfigurationResult> => {
  if (kind === "schedule-tracks") return configResult(tracksConfig());
  if (kind === "statuses") return configResult({ schema: "gitpm/statuses@2", statuses: [{ slug: "backlog", title: "Backlog", active: true, category: "backlog" }, { slug: "done", title: "Done", active: true, category: "done" }] });
  return configResult({ schema: "gitpm/issue-types@1", issue_types: [{ slug: "task", title: "Task", active: true }] });
});

afterEach(() => { cleanup(); localStorage.clear(); });

describe("unified scheduling model", () => {
  it("project snapshot resolves the primary finish through the configured working track", () => {
    const project = result({ schema: "gitpm/project@2", id: "P-26-111111", name: "Snapshot project", status: "in-progress", lifecycle: "active", planning, schedules: { working: { finish: "2026-09-30" }, target: { finish: "2026-09-15" } } });
    render(<ProjectScheduleSummary project={project.document} projectId="P-26-111111" onNavigate={vi.fn()} locale="en" scheduling={new ScheduleResolver(scheduleTracksConfig(tracksConfig()))} comparisonTrack="target" />);
    const label = screen.getByText("Primary schedule");
    expect(label.closest("div")?.textContent).toMatch(/Sep|30/);
  });

  it("project snapshot rolls up the primary finish when the project has no declared schedule", () => {
    const projectId = "P-26-111111";
    const project = result({ schema: "gitpm/project@2", id: projectId, name: "Rolled snapshot", status: "in-progress", lifecycle: "active", planning, schedules: { target: { finish: "2026-10-01" } } });
    const task = result({ schema: "gitpm/task@2", id: "T-26-111111", project: projectId, title: "Child task", type: "task", status: "backlog", lifecycle: "active", schedules: { working: { start: "2026-09-01", finish: "2026-10-02" } } });
    render(<ProjectScheduleSummary project={project.document} projectId={projectId} onNavigate={vi.fn()} locale="en" scheduling={new ScheduleResolver(scheduleTracksConfig(tracksConfig()))} tasks={[task]} comparisonTrack="target" />);
    const label = screen.getByText("Primary schedule");
    expect(label.closest("div")?.textContent).toMatch(/Oct|2/);
  });

  it("project snapshot prefers the declared project window over a later rolled-up child window", () => {
    const projectId = "P-26-DECLARED";
    const project = result({ schema: "gitpm/project@2", id: projectId, name: "Declared wins", status: "in-progress", lifecycle: "active", planning, schedules: { working: { start: "2026-09-01", finish: "2026-09-30" }, target: { finish: "2026-09-10" } } });
    const task = result({ schema: "gitpm/task@2", id: "T-26-DECLARED", project: projectId, title: "Later child", type: "task", status: "backlog", lifecycle: "active", schedules: { working: { start: "2026-09-01", finish: "2026-11-15" } } });
    render(<ProjectScheduleSummary project={project.document} projectId={projectId} onNavigate={vi.fn()} locale="en" scheduling={new ScheduleResolver(scheduleTracksConfig(tracksConfig()))} tasks={[task]} comparisonTrack="target" />);
    const primary = screen.getByText("Primary schedule").closest("div")!;
    expect(primary.textContent).toMatch(/Sep|30/);
    expect(primary.textContent).not.toMatch(/Nov/u);
  });

  it("gantt reads working-track bars and dependencies", async () => {
    const projectId = "P-26-111111";
    const project = result({ schema: "gitpm/project@2", id: projectId, name: "Gantt project", status: "backlog", lifecycle: "active", planning });
    const first = result({ schema: "gitpm/task@2", id: "T-26-111111", project: projectId, title: "First task", type: "task", status: "backlog", lifecycle: "active", schedules: { working: { start: "2026-07-01", finish: "2026-07-03" } } });
    const second = result({ schema: "gitpm/task@2", id: "T-26-222222", project: projectId, title: "Second task", type: "task", status: "backlog", lifecycle: "active", schedules: { working: { start: "2026-07-04", finish: "2026-07-06", depends_on: [first.document.id] } } });
    const milestone = result({ schema: "gitpm/milestone@2", id: "M-26-888888", project: projectId, name: "Release", lifecycle: "active", schedules: { working: { finish: "2026-07-06" } } });
    const entities = [project, first, second, milestone];
    const api = gitPmApi({ listEntities: listEntitiesMock(entities), getConfiguration: buildGetConfiguration(), listProjectTimeEntries: vi.fn(async () => ({ items: [], total: 0, offset: 0, limit: 200 })), listTimeEntries: vi.fn(async () => []) });
    const { container } = render(<GanttWorkspace api={api} draft={draft} locale="en" onNavigate={vi.fn()} />);
    await waitFor(() => expect(container.querySelectorAll(".gantt-bar")).toHaveLength(2));
    expect(container.querySelectorAll(".gantt-dependencies path[data-from]").length).toBeGreaterThan(0);
  });

  it("workload allocates effort from the configured working workload track", async () => {
    const projectId = "P-26-111111";
    const adaId = "U-26-222222";
    const calendarId = "C-26-333333";
    const calendar = result({ schema: "gitpm/calendar@1", id: calendarId, name: "Engineering", working_weekdays: [1, 2, 3, 4, 5], holidays: [], lifecycle: "active" });
    const ada = result({ schema: "gitpm/person@1", id: adaId, name: "Ada", weekly_capacity_hours: 40, calendar: calendarId, lifecycle: "active" });
    const project = result({ schema: "gitpm/project@2", id: projectId, name: "Workload project", status: "backlog", lifecycle: "active", planning });
    const task = result({ schema: "gitpm/task@2", id: "T-26-444444", project: projectId, title: "Sized task", type: "task", status: "backlog", lifecycle: "active", schedules: { working: { start: "2026-07-06", finish: "2026-07-10", effort_hours: 40 } }, assignees: [adaId] });
    const entities = [calendar, ada, project, task];
    const api = gitPmApi({ listEntities: listEntitiesMock(entities), getConfiguration: buildGetConfiguration() });
    const { container } = render(<WorkloadWorkspace api={api} draft={draft} locale="en" onNavigate={vi.fn()} />);
    await waitFor(() => expect(container.querySelector(".workload-table")).not.toBeNull());
    expect(Array.from(container.querySelectorAll(".workload-table td")).some((cell) => /40h/u.test(cell.textContent ?? ""))).toBe(true);
  });

  it("§14.11: allocates per person using each assignee's own working calendar, independent of primary/comparison roles", async () => {
    // Two assignees on DIFFERENT calendars. Ada works Mon–Fri with no holidays. Bo works
    // Mon–Fri but has a Wednesday holiday in week 1. The task window spans two ISO weeks
    // (Mon Jul 6 – Fri Jul 17). Effort lives on the WORKLOAD track (`estimate`); the
    // primary track (`working`) carries a 999h sentinel that must be ignored, and the
    // comparison track (`forecast`) is unrelated. This pins that the project-overview
    // refactor did not touch the calendar/availability algorithm and did not tie the
    // working calendar to the primary track.
    const multiTrackCfg: ConfigurationDocument = { schema: "gitpm/schedule-tracks@1", tracks: [{ slug: "working", title: "Working", kind: "manual", capabilities: ["dates", "effort"] }, { slug: "forecast", title: "Forecast", kind: "manual", capabilities: ["dates"] }, { slug: "estimate", title: "Estimate", kind: "manual", capabilities: ["dates", "effort"] }, { slug: "actual", title: "Actual", kind: "actual", source: "time_entries" }], defaults: { enabled_tracks: ["working", "forecast", "estimate", "actual"], primary_track: "working", workload_track: "estimate", comparison_track: "forecast", dashboard_tracks: ["working", "forecast", "estimate", "actual"] } };
    const getConfiguration = vi.fn(async (_draftId: string, kind: string): Promise<ConfigurationResult> => {
      if (kind === "schedule-tracks") return configResult(multiTrackCfg);
      if (kind === "statuses") return configResult({ schema: "gitpm/statuses@2", statuses: [{ slug: "backlog", title: "Backlog", active: true, category: "backlog" }] });
      return configResult({ schema: "gitpm/issue-types@1", issue_types: [{ slug: "task", title: "Task", active: true }] });
    });
    const projectId = "P-26-CAL";
    const adaId = "U-26-ADA";
    const boId = "U-26-BO";
    const engCalendarId = "C-26-ENG";
    const supportCalendarId = "C-26-SUP";
    const eng = result({ schema: "gitpm/calendar@1", id: engCalendarId, name: "Engineering", working_weekdays: [1, 2, 3, 4, 5], holidays: [], lifecycle: "active" });
    const support = result({ schema: "gitpm/calendar@1", id: supportCalendarId, name: "Support", working_weekdays: [1, 2, 3, 4, 5], holidays: ["2026-07-08"], lifecycle: "active" });
    const ada = result({ schema: "gitpm/person@1", id: adaId, name: "Ada", weekly_capacity_hours: 40, calendar: engCalendarId, lifecycle: "active" });
    const bo = result({ schema: "gitpm/person@1", id: boId, name: "Bo", weekly_capacity_hours: 40, calendar: supportCalendarId, lifecycle: "active" });
    const calProject = result({ schema: "gitpm/project@2", id: projectId, name: "Calendar project", status: "backlog", lifecycle: "active", planning: { enabled_tracks: ["working", "forecast", "estimate", "actual"], primary_track: "working", workload_track: "estimate", comparison_track: "forecast", dashboard_tracks: ["working", "forecast", "estimate", "actual"] } });
    const calTask = result({ schema: "gitpm/task@2", id: "T-26-CAL", project: projectId, title: "Shared task", type: "task", status: "backlog", lifecycle: "active", schedules: { working: { effort_hours: 999 }, estimate: { start: "2026-07-06", finish: "2026-07-17", effort_hours: 80 } }, assignees: [adaId, boId] });
    const entities = [eng, support, ada, bo, calProject, calTask];
    const api = gitPmApi({ listEntities: listEntitiesMock(entities), getConfiguration });
    const { container } = render(<WorkloadWorkspace api={api} draft={draft} locale="en" onNavigate={vi.fn()} />);
    await waitFor(() => expect(container.querySelector(".workload-table")).not.toBeNull());

    const adaWeek1 = container.querySelector<HTMLElement>(`td[data-person-id="${adaId}"][data-week="2026-07-06"]`)!;
    const boWeek1 = container.querySelector<HTMLElement>(`td[data-person-id="${boId}"][data-week="2026-07-06"]`)!;
    const adaWeek2 = container.querySelector<HTMLElement>(`td[data-person-id="${adaId}"][data-week="2026-07-13"]`)!;
    const boWeek2 = container.querySelector<HTMLElement>(`td[data-person-id="${boId}"][data-week="2026-07-13"]`)!;

    // Ada (no holiday): 80h split two ways = 40h, spread evenly across her 10 working
    // days => 20h land in each week, against full 40h weekly capacity.
    expect(adaWeek1.querySelector("strong")!.textContent).toBe("20h / 40h");
    expect(adaWeek2.querySelector("strong")!.textContent).toBe("20h / 40h");
    // Bo's Wednesday holiday removes one working day from week 1: only ~17.78h land in
    // week 1 (and her weekly capacity also drops to 32h), while the balance shifts into
    // week 2 (~22.22h). This is only explainable if allocation honored Bo's own calendar.
    expect(boWeek1.querySelector("strong")!.textContent).toBe("17.78h / 32h");
    expect(boWeek2.querySelector("strong")!.textContent).toBe("22.22h / 40h");
    // Per-person allocation differs in both weeks precisely because the calendars differ.
    expect(adaWeek1.querySelector("strong")!.textContent).not.toBe(boWeek1.querySelector("strong")!.textContent);
    expect(adaWeek2.querySelector("strong")!.textContent).not.toBe(boWeek2.querySelector("strong")!.textContent);
    // The primary-track 999h sentinel never reaches any cell — allocation is driven by
    // the workload track, not the primary track, and is independent of comparison roles.
    expect(Array.from(container.querySelectorAll(".workload-table td")).some((cell) => /999/u.test(cell.textContent ?? ""))).toBe(false);
  });

  it("people profile resolves the per-project working primary track", async () => {
    const personId = "U-26-ADA";
    const projectId = "P-26-111111";
    const person = result({ schema: "gitpm/person@1", id: personId, name: "Ada Lovelace", weekly_capacity_hours: 32, lifecycle: "active" });
    const project = result({ schema: "gitpm/project@2", id: projectId, name: "Alpha", owner: personId, status: "in-progress", lifecycle: "active", planning });
    const task = result({ schema: "gitpm/task@2", id: "T-26-222222", project: projectId, title: "Profile task", status: "in-progress", assignees: [personId], schedules: { working: { start: "2026-07-20", finish: "2026-07-24" } }, lifecycle: "active" });
    const entities = [person, project, task];
    const api = gitPmApi({ listEntities: listEntitiesMock(entities), getConfiguration: buildGetConfiguration() });
    render(<PeopleProfileWorkspace api={api} draft={draft} locale="en" onNavigate={vi.fn()} personId={personId} />);
    expect(await screen.findByText("Jul 20, 2026 — Jul 24, 2026")).toBeTruthy();
    expect(screen.getAllByText("Profile task").length).toBeGreaterThan(0);
  });

  it("project plan renders working-track project, stage and task dates", async () => {
    const projectId = "P-26-111111";
    const project = result({ schema: "gitpm/project@2", id: projectId, name: "Plan project", status: "backlog", lifecycle: "active", planning, schedules: { working: { start: "2026-07-01", finish: "2026-09-30" } } });
    const milestone = result({ schema: "gitpm/milestone@2", id: "M-26-888888", project: projectId, name: "Launch", lifecycle: "active", schedules: { working: { finish: "2026-08-15" } } });
    const task = result({ schema: "gitpm/task@2", id: "T-26-333333", project: projectId, milestone: milestone.document.id, title: "Plan task", type: "task", status: "backlog", lifecycle: "active", schedules: { working: { start: "2026-07-10", finish: "2026-07-20", effort_hours: 12 } } });
    const workspace: ProjectWorkspaceResult = { project, milestones: [milestone], tasks: [task], draft_fingerprint: fingerprint };
    const api = gitPmApi({ projectWorkspace: vi.fn(async () => workspace), listEntities: listEntitiesMock([project]), getConfiguration: buildGetConfiguration() });
    const { container } = render(<ProjectPlanWorkspace api={api} draft={draft} locale="en" onChanged={vi.fn(async () => undefined)} onNavigate={vi.fn()} projectId={projectId} />);
    await screen.findByRole("heading", { name: "Plan project" });
    expect(container.textContent).toContain("Jul 1, 2026");
    expect(container.textContent).toContain("Jul 20, 2026");
    expect(container.textContent).toContain("Aug 15, 2026");
  });

  it("selected milestone route renders the working-track due date and task title in the project workspace", async () => {
    const projectId = "P-26-111111";
    const project = result({ schema: "gitpm/project@2", id: projectId, name: "Stage project", status: "backlog", lifecycle: "active", planning });
    const milestone = result({ schema: "gitpm/milestone@2", id: "M-26-888888", project: projectId, name: "Launch", lifecycle: "active", schedules: { working: { finish: "2026-08-15" } } });
    const task = result({ schema: "gitpm/task@2", id: "T-26-333333", project: projectId, milestone: milestone.document.id, title: "Stage task", type: "task", status: "backlog", lifecycle: "active", schedules: { working: { start: "2026-07-10", finish: "2026-08-01", effort_hours: 8 } } });
    const workspace: ProjectWorkspaceResult = { project, milestones: [milestone], tasks: [task], draft_fingerprint: fingerprint };
    const api = gitPmApi({ projectWorkspace: vi.fn(async () => workspace), listEntities: listEntitiesMock([]), getConfiguration: buildGetConfiguration() });
    const { container } = render(<ProjectPlanWorkspace api={api} draft={draft} locale="en" onChanged={vi.fn(async () => undefined)} onNavigate={vi.fn()} projectId={projectId} selectedStageId={milestone.document.id} />);
    await screen.findByRole("complementary", { name: "Milestone" });
    expect(screen.getByRole("button", { name: /Stage task/u })).toBeTruthy();
    expect(container.textContent).toContain("Aug 15, 2026");
  });

  it("board renders tasks grouped by status without depending on the plan track", async () => {
    const projectId = "P-26-111111";
    const project = result({ schema: "gitpm/project@2", id: projectId, name: "Board project", status: "backlog", lifecycle: "active", planning });
    const task = result({ schema: "gitpm/task@2", id: "T-26-222222", project: projectId, title: "Board task", type: "task", status: "backlog", lifecycle: "active", schedules: { working: { start: "2026-07-01", finish: "2026-07-03" } } });
    const entities = [project, task];
    const api = gitPmApi({ listEntities: listEntitiesMock(entities), getConfiguration: buildGetConfiguration() });
    render(<BoardWorkspace api={api} draft={draft} locale="en" onChanged={vi.fn(async () => undefined)} />);
    expect(await screen.findByText("Board task")).toBeTruthy();
  });

  it("core task panel renders working-track start, due and effort", async () => {
    const projectId = "P-26-111111";
    const project = result({ schema: "gitpm/project@2", id: projectId, name: "Core project", status: "backlog", lifecycle: "active", planning });
    const task = result({ schema: "gitpm/task@2", id: "T-26-333333", project: projectId, title: "Detail task", type: "task", status: "backlog", lifecycle: "active", schedules: { working: { start: "2026-07-20", finish: "2026-07-24", effort_hours: 16 } } });
    const entities = [project, task];
    const api = gitPmApi({ listEntities: listEntitiesMock(entities), getConfiguration: buildGetConfiguration() });
    const { container } = render(<CoreWorkspace api={api} draft={draft} initialProjectId={projectId} initialTaskId={task.document.id} locale="en" surface="tasks" onNavigate={vi.fn()} onChanged={vi.fn(async () => undefined)} />);
    await screen.findByRole("heading", { name: "Detail task" });
    const metadata = container.querySelector<HTMLElement>(".task-detail-meta")!;
    expect(metadata.textContent).toContain("Jul 20, 2026");
    expect(metadata.textContent).toContain("Jul 24, 2026");
    expect(metadata.textContent).toContain("16 h");
  });

  it("rolls an active task with a non-existent parent into the project deadline", () => {
    // Scenario 1: the task points at a parent id that does not exist. After normalization it
    // becomes a root, so its Dec 10 finish reaches the rolled-up project schedule instead of
    // being silently dropped under a parent the hierarchy cannot resolve.
    const projectId = "P-26-ORPHAN";
    const projectDoc = result({ schema: "gitpm/project@2", id: projectId, name: "Orphan project", status: "in-progress", lifecycle: "active", planning, schedules: { target: { finish: "2026-09-15" } } }).document;
    const orphan = result({ schema: "gitpm/task@2", id: "T-26-ORPHAN", project: projectId, parent: "T-26-GONE", title: "Orphan task", type: "task", status: "backlog", lifecycle: "active", schedules: { working: { finish: "2026-12-10", effort_hours: 20 } } });
    render(<ProjectScheduleSummary project={projectDoc} projectId={projectId} onNavigate={vi.fn()} locale="en" scheduling={new ScheduleResolver(scheduleTracksConfig(tracksConfig()))} tasks={[orphan]} comparisonTrack="target" />);
    const primary = screen.getByText("Primary schedule").closest("div")!;
    expect(primary.textContent).toMatch(/Dec|10/);
  });

  it("rolls an active child of an archived parent into the project deadline", () => {
    // Scenario 2: the parent is archived. The active child must not disappear under it; the
    // child's finish reaches the rolled-up project schedule and the archived parent's own
    // stale window does not.
    const projectId = "P-26-ARCHPARENT";
    const projectDoc = result({ schema: "gitpm/project@2", id: projectId, name: "Archived parent project", status: "in-progress", lifecycle: "active", planning, schedules: { target: { finish: "2026-09-15" } } }).document;
    const archivedParent = result({ schema: "gitpm/task@2", id: "T-26-AP", project: projectId, title: "Archived parent", type: "task", status: "done", lifecycle: "archived", schedules: { working: { finish: "2026-01-01", effort_hours: 99 } } });
    const activeChild = result({ schema: "gitpm/task@2", id: "T-26-AC", project: projectId, parent: archivedParent.document.id, title: "Active child", type: "task", status: "backlog", lifecycle: "active", schedules: { working: { finish: "2026-12-10", effort_hours: 20 } } });
    render(<ProjectScheduleSummary project={projectDoc} projectId={projectId} onNavigate={vi.fn()} locale="en" scheduling={new ScheduleResolver(scheduleTracksConfig(tracksConfig()))} tasks={[archivedParent, activeChild]} comparisonTrack="target" />);
    const primary = screen.getByText("Primary schedule").closest("div")!;
    expect(primary.textContent).toMatch(/Dec|10/);
    expect(primary.textContent).not.toMatch(/Jan/u);
  });

  it("treats a self-referential parent as a root and still rolls the task finish up", () => {
    // Scenario 4: the task points parent at its own id. There must be no recursion and the
    // task's finish must reach the rolled-up project schedule.
    const projectId = "P-26-SELF";
    const projectDoc = result({ schema: "gitpm/project@2", id: projectId, name: "Self-ref project", status: "in-progress", lifecycle: "active", planning, schedules: { target: { finish: "2026-09-15" } } }).document;
    const selfRef = result({ schema: "gitpm/task@2", id: "T-26-SELF", project: projectId, parent: "T-26-SELF", title: "Self-ref task", type: "task", status: "backlog", lifecycle: "active", schedules: { working: { finish: "2026-12-10", effort_hours: 20 } } });
    render(<ProjectScheduleSummary project={projectDoc} projectId={projectId} onNavigate={vi.fn()} locale="en" scheduling={new ScheduleResolver(scheduleTracksConfig(tracksConfig()))} tasks={[selfRef]} comparisonTrack="target" />);
    const primary = screen.getByText("Primary schedule").closest("div")!;
    expect(primary.textContent).toMatch(/Dec|10/);
  });
});
