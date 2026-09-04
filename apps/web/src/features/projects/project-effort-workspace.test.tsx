// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfigurationDocument, ConfigurationResult, DraftStatus, EntityDocument, EntityResult, ProjectWorkspaceResult } from "../../types.js";
import { ProjectEffortWorkspace, type ProjectEffortWorkspaceApi } from "./project-effort-workspace.js";

const fingerprint = "b".repeat(64);
const draft: DraftStatus = { draft_id: "DRF-EFFORT", owner_gitlab_user_id: "42", branch: "gitpm/42/DRF-EFFORT", base_commit: "a".repeat(40), writer_mode: "ui", state: "open", fingerprint, created_at: "2026-07-10T00:00:00.000Z", updated_at: "2026-07-10T00:00:00.000Z" };
const result = (document: EntityDocument): EntityResult => ({ document, path: `${document.id}.yaml`, blob_id: "a".repeat(40), draft_fingerprint: fingerprint });
const configuration = (document: ConfigurationDocument): ConfigurationResult => ({ document, path: document.schema, blob_id: "a".repeat(40), draft_fingerprint: fingerprint });

// Track-agnostic configuration: none of the slugs is `plan`. The workload role
// binds to the made-up `estimate` track to prove the workspace is track-agnostic.
const tracksConfig: ConfigurationDocument = {
  schema: "gitpm/schedule-tracks@1",
  tracks: [
    { slug: "working", title: "Working", kind: "manual", capabilities: ["dates", "effort"] },
    { slug: "estimate", title: "Estimate", kind: "manual", capabilities: ["dates", "effort"] },
    { slug: "actual", title: "Actual", kind: "actual", source: "time_entries" },
  ],
  defaults: { enabled_tracks: ["working", "estimate", "actual"], primary_track: "working", workload_track: "estimate", dashboard_tracks: ["working", "estimate", "actual"] },
};
const planning = { enabled_tracks: ["working", "estimate", "actual"], primary_track: "working", workload_track: "estimate", dashboard_tracks: ["working", "estimate", "actual"] };

const projectId = "P-26-EFFORT";
const project = result({ schema: "gitpm/project@2", id: projectId, name: "Effort project", status: "in-progress", lifecycle: "active", planning });
const person = result({ schema: "gitpm/person@1", id: "U-26-ADA", name: "Ada", weekly_capacity_hours: 40, lifecycle: "active" });
const task = result({ schema: "gitpm/task@2", id: "T-26-WORK", project: projectId, title: "Effort task", type: "task", status: "in-progress", lifecycle: "active", schedules: { estimate: { start: "2026-09-01", finish: "2026-09-30", effort_hours: 25 } }, assignees: [person.document.id] });

const timeEntry = (hours: number, performedOn: string) => ({ document: { schema: "gitpm/time-entry@1" as const, id: `E-${performedOn}`, project: projectId, task: task.document.id, person: person.document.id, performed_on: performedOn, hours, category: "regular", created_at: `${performedOn}T00:00:00.000Z`, state: "active" as const }, path: "e", blob_id: "a", draft_fingerprint: fingerprint });

function api() {
  const workspace: ProjectWorkspaceResult = { project, milestones: [], tasks: [task], draft_fingerprint: fingerprint };
  const listProjectTimeEntries = vi.fn(async (_draftId: string, _projectId: string, filters: { readonly offset?: number; readonly limit?: number } = {}) => {
    const items = [timeEntry(4, "2026-09-10")];
    const offset = filters.offset ?? 0; const limit = filters.limit ?? 200;
    return { total: items.length, offset, limit, items: items.slice(offset, offset + limit) };
  });
  return {
    projectWorkspace: vi.fn(async () => workspace),
    listEntities: vi.fn(async (_draftId: string, type: string) => type === "people" ? [person] : []),
    getConfiguration: vi.fn(async (_draftId: string, kind: "statuses" | "issue-types" | "work-categories" | "schedule-tracks") => configuration(kind === "work-categories"
      ? { schema: "gitpm/work-categories@1", categories: [{ slug: "regular", title: "Regular work", active: true }] }
      : kind === "schedule-tracks"
      ? tracksConfig
      : { schema: "gitpm/issue-types@1", issue_types: [{ slug: "task", title: "Task", active: true }] })),
    listProjectTimeEntries,
  } satisfies ProjectEffortWorkspaceApi;
}

afterEach(() => { cleanup(); localStorage.clear(); });

describe("ProjectEffortWorkspace", () => {
  it("renders the actual effort report header, summed actual hours and the workload Planned value", async () => {
    const client = api();
    render(<ProjectEffortWorkspace api={client} draft={draft} locale="en" onNavigate={vi.fn()} projectId={projectId} />);

    await screen.findByRole("heading", { name: "Effort project" });
    expect(screen.getByText(projectId).tagName).toBe("CODE");
    await screen.findByRole("heading", { name: "Actual hours report" });

    await waitFor(() => expect(screen.getAllByText("Actual hours")[0]?.parentElement?.textContent).toMatch(/4 hours/u));
    // The plan of the selected scope (whole project, sum of the single root task) is the
    // workload-track estimate of 25h, surfaced through the new plan/actual summary.
    await waitFor(() => expect(screen.getByText("Plan of selected scope").parentElement?.textContent).toMatch(/25 hours/u));
  });

  it("loads project, people, work-categories and schedule-tracks in parallel and never per task", async () => {
    const client = api();
    render(<ProjectEffortWorkspace api={client} draft={draft} locale="en" onNavigate={vi.fn()} projectId={projectId} />);

    await waitFor(() => expect(client.projectWorkspace).toHaveBeenCalledTimes(1));
    expect(client.projectWorkspace).toHaveBeenCalledWith(draft.draft_id, projectId);
    expect(client.listEntities).toHaveBeenCalledWith(draft.draft_id, "people");
    expect(client.getConfiguration).toHaveBeenCalledWith(draft.draft_id, "work-categories");
    expect(client.getConfiguration).toHaveBeenCalledWith(draft.draft_id, "schedule-tracks");
    expect(client.listEntities).not.toHaveBeenCalledWith(draft.draft_id, "tasks", expect.anything());

    // The actual report loads time entries once for the whole project, not per task.
    await waitFor(() => expect(client.listProjectTimeEntries).toHaveBeenCalled());
    expect(client.listProjectTimeEntries.mock.calls.every((call) => call[1] === projectId)).toBe(true);
  });

  it("scenario 7: keeps the active child of an archived parent in the plan and separates history from the current plan", async () => {
    // Fixture mix required by the integration scenario:
    //  - active root task with a 20h estimate on the workload track;
    //  - archived task with a 99h estimate but NO time records (must not inflate the plan);
    //  - archived task WITH historical time records (must surface as a historical row);
    //  - active task whose parent is the archived 99h task (must not disappear from the plan).
    const activeRoot = result({ schema: "gitpm/task@2", id: "T-ACT-ROOT", project: projectId, title: "Active root", type: "task", status: "in-progress", lifecycle: "active", schedules: { estimate: { effort_hours: 20 } }, assignees: [] });
    const archivedGhost = result({ schema: "gitpm/task@2", id: "T-ARCH-GHOST", project: projectId, title: "Archived ghost", type: "task", status: "done", lifecycle: "archived", schedules: { estimate: { effort_hours: 99 } }, assignees: [] });
    const archivedHist = result({ schema: "gitpm/task@2", id: "T-ARCH-HIST", project: projectId, title: "Archived with hours", type: "task", status: "done", lifecycle: "archived", schedules: { estimate: { effort_hours: 50 } }, assignees: [] });
    const activeChildOfArchived = result({ schema: "gitpm/task@2", id: "T-ACT-CHILD", project: projectId, parent: archivedGhost.document.id, title: "Active child of archived", type: "task", status: "backlog", lifecycle: "active", schedules: { estimate: { effort_hours: 20 } }, assignees: [] });
    const scenarioTasks = [activeRoot, archivedGhost, archivedHist, activeChildOfArchived];
    const scenarioWorkspace: ProjectWorkspaceResult = { project, milestones: [], tasks: scenarioTasks, draft_fingerprint: fingerprint };
    // The API returns historical hours for the archived-with-history task and nothing else.
    const historyEntry = { document: { schema: "gitpm/time-entry@1" as const, id: "E-HIST", project: projectId, task: archivedHist.document.id, person: person.document.id, performed_on: "2026-09-05", hours: 7, category: "regular", created_at: "2026-09-05T00:00:00.000Z", state: "active" as const }, path: "e", blob_id: "a", draft_fingerprint: fingerprint };
    const listProjectTimeEntries = vi.fn(async (_draftId: string, _projectId: string, _filters: { readonly offset?: number; readonly limit?: number } = {}) => {
      const items = [historyEntry];
      const offset = _filters.offset ?? 0; const limit = _filters.limit ?? 200;
      return { total: items.length, offset, limit, items: items.slice(offset, offset + limit) };
    });
    const scenarioApi = {
      projectWorkspace: vi.fn(async () => scenarioWorkspace),
      listEntities: vi.fn(async (_draftId: string, type: string) => type === "people" ? [person] : []),
      getConfiguration: vi.fn(async (_draftId: string, kind: "statuses" | "issue-types" | "work-categories" | "schedule-tracks") => configuration(kind === "work-categories"
        ? { schema: "gitpm/work-categories@1", categories: [{ slug: "regular", title: "Regular work", active: true }] }
        : kind === "schedule-tracks"
        ? tracksConfig
        : { schema: "gitpm/issue-types@1", issue_types: [{ slug: "task", title: "Task", active: true }] })),
      listProjectTimeEntries,
    } satisfies ProjectEffortWorkspaceApi;

    render(<ProjectEffortWorkspace api={scenarioApi} draft={draft} locale="en" onNavigate={vi.fn()} projectId={projectId} />);
    await screen.findByRole("heading", { name: "Effort project" });

    // The current plan is the sum of ACTIVE root tasks only: activeRoot (20h) plus
    // activeChildOfArchived (20h, promoted to root because its parent is archived). The
    // archived ghost's 99h and the archived-with-history task's 50h must NOT join the plan.
    const plan = await waitFor(() => screen.getByText("Plan of selected scope").parentElement!);
    expect(plan.textContent ?? "").toMatch(/40 hours/u);
    expect(plan.textContent ?? "").not.toMatch(/99|50|90/u);

    // The archived task WITHOUT history is absent from both the table and the task selector.
    await waitFor(() => expect(document.querySelector('tr[data-task-id="T-ARCH-GHOST"]')).toBeNull());
    const taskSelect = screen.getByLabelText("Task") as HTMLSelectElement;
    expect(Array.from(taskSelect.options).some((option) => option.value === archivedGhost.document.id)).toBe(false);

    // The archived task WITH history surfaces as a historical row carrying its 7 hours, with an
    // empty (—) plan cell because it is not part of the current read models.
    await waitFor(() => expect(document.querySelector(`tr[data-task-id="${archivedHist.document.id}"]`)).not.toBeNull());
    const histRow = document.querySelector<HTMLElement>(`tr[data-task-id="${archivedHist.document.id}"]`)!;
    expect(histRow.querySelectorAll("td")[2]?.textContent).toMatch(/7 hours/u);
    expect(histRow.querySelectorAll("td")[0]?.textContent).toMatch(/—/u);

    // The active child of the archived parent is present in the table and in the selector — it
    // was not lost under the archived parent.
    expect(document.querySelector(`tr[data-task-id="${activeChildOfArchived.document.id}"]`)).not.toBeNull();
    expect(Array.from(taskSelect.options).some((option) => option.value === activeChildOfArchived.document.id)).toBe(true);

    // The active root is present too.
    expect(document.querySelector(`tr[data-task-id="${activeRoot.document.id}"]`)).not.toBeNull();
  });

  it("scenario 5: resets historical tasks, entries, and catalogs when the draft changes", async () => {
    // First draft: an archived task owns historical hours. Second draft: that history is gone.
    // After switching drafts the archived task of the first draft must disappear from the
    // selector and its records must not leak into the second draft's report.
    const archivedWithHistory = result({ schema: "gitpm/task@2", id: "T-ARCH-D1", project: projectId, title: "Draft 1 archived", type: "task", status: "done", lifecycle: "archived", schedules: { estimate: { effort_hours: 7 } }, assignees: [] });
    const firstWorkspace: ProjectWorkspaceResult = { project, milestones: [], tasks: [task, archivedWithHistory], draft_fingerprint: fingerprint };
    const secondWorkspace: ProjectWorkspaceResult = { project, milestones: [], tasks: [task], draft_fingerprint: fingerprint };
    const firstEntry = { document: { schema: "gitpm/time-entry@1" as const, id: "E-D1", project: projectId, task: archivedWithHistory.document.id, person: person.document.id, performed_on: "2026-09-05", hours: 5, category: "regular", created_at: "2026-09-05T00:00:00.000Z", state: "active" as const }, path: "e", blob_id: "a", draft_fingerprint: fingerprint };
    const listProjectTimeEntries = vi.fn(async (_draftId: string, _projectId: string, _filters: { readonly offset?: number; readonly limit?: number } = {}) => {
      // Only the first draft has the archived task's record.
      const items = _draftId === "DRF-EFFORT" ? [firstEntry, timeEntry(4, "2026-09-10")] : [timeEntry(4, "2026-09-10")];
      const offset = _filters.offset ?? 0; const limit = _filters.limit ?? 200;
      return { total: items.length, offset, limit, items: items.slice(offset, offset + limit) };
    });
    const changingApi = {
      projectWorkspace: vi.fn(async (draftId: string) => draftId === "DRF-EFFORT" ? firstWorkspace : secondWorkspace),
      listEntities: vi.fn(async (_draftId: string, type: string) => type === "people" ? [person] : []),
      getConfiguration: vi.fn(async (_draftId: string, kind: "statuses" | "issue-types" | "work-categories" | "schedule-tracks") => configuration(kind === "work-categories"
        ? { schema: "gitpm/work-categories@1", categories: [{ slug: "regular", title: "Regular work", active: true }] }
        : kind === "schedule-tracks"
        ? tracksConfig
        : { schema: "gitpm/issue-types@1", issue_types: [{ slug: "task", title: "Task", active: true }] })),
      listProjectTimeEntries,
    } satisfies ProjectEffortWorkspaceApi;

    const draftTwo: DraftStatus = { ...draft, draft_id: "DRF-EFFORT-2" };

    const rendered = render(<ProjectEffortWorkspace api={changingApi} draft={draft} locale="en" onNavigate={vi.fn()} projectId={projectId} />);
    await screen.findByRole("heading", { name: "Effort project" });
    // The archived task of draft 1 is selectable because it owns historical hours.
    await waitFor(() => {
      const select = screen.getByLabelText("Task") as HTMLSelectElement;
      expect(Array.from(select.options).some((option) => option.value === archivedWithHistory.document.id)).toBe(true);
    });

    // Switch to the second draft: the historical accumulators are reset, so the archived task
    // of draft 1 must disappear from the selector, and its category/person catalog must not
    // leak (the second draft has only the active task's own record).
    rendered.rerender(<ProjectEffortWorkspace api={changingApi} draft={draftTwo} locale="en" onNavigate={vi.fn()} projectId={projectId} />);
    await waitFor(() => expect(changingApi.projectWorkspace).toHaveBeenCalledWith("DRF-EFFORT-2", projectId));
    await waitFor(() => {
      const select = screen.getByLabelText("Task") as HTMLSelectElement;
      expect(Array.from(select.options).some((option) => option.value === archivedWithHistory.document.id)).toBe(false);
    });
  });
});
