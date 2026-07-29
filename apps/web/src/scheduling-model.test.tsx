// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitPmApi } from "./api.js";
import { ScheduleResolver, scheduleTracksConfig } from "./schedules.js";
import type { ConfigurationDocument, ConfigurationResult, DraftStatus, EntityDocument, EntityResult, ProjectWorkspaceResult } from "./types.js";
import { BoardWorkspace } from "./board-ui.js";
import { CoreWorkspace } from "./core-ui.js";
import { GanttWorkspace } from "./gantt-ui.js";
import { PeopleProfileWorkspace } from "./people-profile-ui.js";
import { WorkloadWorkspace } from "./workload-ui.js";
import { ProjectSnapshot } from "./features/projects/project-snapshot.js";
import { ProjectPlanWorkspace } from "./features/projects/project-plan-workspace.js";
import { StageWorkspace } from "./features/stages/stage-workspace.js";

const fingerprint = "b".repeat(64);
const draft: DraftStatus = { draft_id: "DRF-SCHED", owner_gitlab_user_id: "42", branch: "gitpm/42/DRF-SCHED", base_commit: "a".repeat(40), writer_mode: "ui", state: "open", fingerprint, created_at: "2026-07-01T00:00:00.000Z", updated_at: "2026-07-01T00:00:00.000Z" };

const tracksConfig = (): ConfigurationDocument => ({ schema: "gitpm/schedule-tracks@1", tracks: [{ slug: "working", title: "Working", kind: "manual", capabilities: ["dates", "effort", "dependencies"] }, { slug: "actual", title: "Actual", kind: "actual", source: "time_entries", capabilities: ["dates"] }], defaults: { enabled_tracks: ["working", "actual"], primary_track: "working", workload_track: "working", comparison_track: "actual", dashboard_tracks: ["working", "actual"] } });
const planning = { primary_track: "working", workload_track: "working", comparison_track: "actual", enabled_tracks: ["working", "actual"], dashboard_tracks: ["working", "actual"] };

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
    const project = result({ schema: "gitpm/project@2", id: "P-26-111111", name: "Snapshot project", status: "in-progress", lifecycle: "active", planning, schedules: { working: { finish: "2026-09-30" } } });
    render(<ProjectSnapshot project={project.document} locale="en" scheduling={new ScheduleResolver(scheduleTracksConfig(tracksConfig()))} />);
    const label = screen.getByText("Primary finish");
    expect(label.parentElement?.textContent).toMatch(/Sep|30/);
  });

  it("gantt reads working-track bars and dependencies", async () => {
    const projectId = "P-26-111111";
    const project = result({ schema: "gitpm/project@2", id: projectId, name: "Gantt project", status: "backlog", lifecycle: "active", planning });
    const first = result({ schema: "gitpm/task@2", id: "T-26-111111", project: projectId, title: "First task", type: "task", status: "backlog", lifecycle: "active", schedules: { working: { start: "2026-07-01", finish: "2026-07-03" } } });
    const second = result({ schema: "gitpm/task@2", id: "T-26-222222", project: projectId, title: "Second task", type: "task", status: "backlog", lifecycle: "active", schedules: { working: { start: "2026-07-04", finish: "2026-07-06", depends_on: [first.document.id] } } });
    const milestone = result({ schema: "gitpm/milestone@2", id: "M-26-888888", project: projectId, name: "Release", lifecycle: "active", schedules: { working: { finish: "2026-07-06" } } });
    const entities = [project, first, second, milestone];
    const api = { listEntities: listEntitiesMock(entities), getConfiguration: buildGetConfiguration(), listTimeEntries: vi.fn(async () => []) } as unknown as GitPmApi;
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
    const api = { listEntities: listEntitiesMock(entities), getConfiguration: buildGetConfiguration() } as unknown as GitPmApi;
    const { container } = render(<WorkloadWorkspace api={api} draft={draft} locale="en" onNavigate={vi.fn()} />);
    await waitFor(() => expect(container.querySelector(".workload-table")).not.toBeNull());
    expect(Array.from(container.querySelectorAll(".workload-table td")).some((cell) => /40h/u.test(cell.textContent ?? ""))).toBe(true);
  });

  it("people profile resolves the per-project working primary track", async () => {
    const personId = "U-26-ADA";
    const projectId = "P-26-111111";
    const person = result({ schema: "gitpm/person@1", id: personId, name: "Ada Lovelace", weekly_capacity_hours: 32, lifecycle: "active" });
    const project = result({ schema: "gitpm/project@2", id: projectId, name: "Alpha", owner: personId, status: "in-progress", lifecycle: "active", planning });
    const task = result({ schema: "gitpm/task@2", id: "T-26-222222", project: projectId, title: "Profile task", status: "in-progress", assignees: [personId], schedules: { working: { start: "2026-07-20", finish: "2026-07-24" } }, lifecycle: "active" });
    const entities = [person, project, task];
    const api = { listEntities: listEntitiesMock(entities), getConfiguration: buildGetConfiguration() } as unknown as GitPmApi;
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
    const api = { projectWorkspace: vi.fn(async () => workspace), listEntities: listEntitiesMock([project]), getConfiguration: buildGetConfiguration() } as unknown as GitPmApi;
    const { container } = render(<ProjectPlanWorkspace api={api} draft={draft} locale="en" onChanged={vi.fn(async () => undefined)} onNavigate={vi.fn()} projectId={projectId} />);
    await screen.findByRole("heading", { name: "Plan project" });
    expect(container.textContent).toContain("Jul 1, 2026");
    expect(container.textContent).toContain("Jul 20, 2026");
    expect(container.textContent).toContain("Aug 15, 2026");
  });

  it("stage workspace renders the working-track stage due date and task title", async () => {
    const projectId = "P-26-111111";
    const project = result({ schema: "gitpm/project@2", id: projectId, name: "Stage project", status: "backlog", lifecycle: "active", planning });
    const milestone = result({ schema: "gitpm/milestone@2", id: "M-26-888888", project: projectId, name: "Launch", lifecycle: "active", schedules: { working: { finish: "2026-08-15" } } });
    const task = result({ schema: "gitpm/task@2", id: "T-26-333333", project: projectId, milestone: milestone.document.id, title: "Stage task", type: "task", status: "backlog", lifecycle: "active", schedules: { working: { start: "2026-07-10", finish: "2026-08-01", effort_hours: 8 } } });
    const workspace: ProjectWorkspaceResult = { project, milestones: [milestone], tasks: [task], draft_fingerprint: fingerprint };
    const api = { projectWorkspace: vi.fn(async () => workspace), listEntities: listEntitiesMock([]), getConfiguration: buildGetConfiguration() } as unknown as GitPmApi;
    const { container } = render(<StageWorkspace api={api} draft={draft} locale="en" onChanged={vi.fn(async () => undefined)} onNavigate={vi.fn()} projectId={projectId} stageId={milestone.document.id} />);
    await screen.findByRole("heading", { name: "Launch" });
    expect(screen.getByText("Stage task")).toBeTruthy();
    expect(container.textContent).toContain("Aug 15, 2026");
  });

  it("board renders tasks grouped by status without depending on the plan track", async () => {
    const projectId = "P-26-111111";
    const project = result({ schema: "gitpm/project@2", id: projectId, name: "Board project", status: "backlog", lifecycle: "active", planning });
    const task = result({ schema: "gitpm/task@2", id: "T-26-222222", project: projectId, title: "Board task", type: "task", status: "backlog", lifecycle: "active", schedules: { working: { start: "2026-07-01", finish: "2026-07-03" } } });
    const entities = [project, task];
    const api = { listEntities: listEntitiesMock(entities), getConfiguration: buildGetConfiguration() } as unknown as GitPmApi;
    render(<BoardWorkspace api={api} draft={draft} locale="en" onChanged={vi.fn(async () => undefined)} />);
    expect(await screen.findByText("Board task")).toBeTruthy();
  });

  it("core task panel renders working-track start, due and effort", async () => {
    const projectId = "P-26-111111";
    const project = result({ schema: "gitpm/project@2", id: projectId, name: "Core project", status: "backlog", lifecycle: "active", planning });
    const task = result({ schema: "gitpm/task@2", id: "T-26-333333", project: projectId, title: "Detail task", type: "task", status: "backlog", lifecycle: "active", schedules: { working: { start: "2026-07-20", finish: "2026-07-24", effort_hours: 16 } } });
    const entities = [project, task];
    const api = { listEntities: listEntitiesMock(entities), getConfiguration: buildGetConfiguration() } as unknown as GitPmApi;
    const { container } = render(<CoreWorkspace api={api} draft={draft} initialProjectId={projectId} initialTaskId={task.document.id} locale="en" surface="tasks" onNavigate={vi.fn()} onChanged={vi.fn(async () => undefined)} />);
    await screen.findByRole("heading", { name: "Detail task" });
    const metadata = container.querySelector<HTMLElement>(".task-detail-meta")!;
    expect(metadata.textContent).toContain("Jul 20, 2026");
    expect(metadata.textContent).toContain("Jul 24, 2026");
    expect(metadata.textContent).toContain("16 h");
  });
});
