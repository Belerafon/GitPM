// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitPmApi } from "../../api.js";
import type { ConfigurationDocument, ConfigurationResult, DraftStatus, EntityDocument, EntityResult, ProjectWorkspaceResult } from "../../types.js";
import { ProjectEffortWorkspace } from "./project-effort-workspace.js";

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

function api(): GitPmApi & { listProjectTimeEntries: ReturnType<typeof vi.fn>; getConfiguration: ReturnType<typeof vi.fn>; listEntities: ReturnType<typeof vi.fn>; projectWorkspace: ReturnType<typeof vi.fn> } {
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
  } as unknown as ReturnType<typeof api>;
}

afterEach(() => { cleanup(); localStorage.clear(); });

describe("ProjectEffortWorkspace", () => {
  it("renders the actual effort report header, summed actual hours and the workload Planned value", async () => {
    const client = api();
    render(<ProjectEffortWorkspace api={client} draft={draft} locale="en" onNavigate={vi.fn()} projectId={projectId} />);

    await screen.findByRole("heading", { name: "Effort project" });
    expect(screen.getByText(projectId).tagName).toBe("CODE");
    await screen.findByRole("heading", { name: "Actual hours report" });

    await waitFor(() => expect(screen.getByText("Actual hours").parentElement?.textContent).toMatch(/4 hours/u));
    const planActual = screen.getByText("Plan vs actual").closest<HTMLElement>(".plan-actual-report")!;
    const summary = planActual.querySelector<HTMLElement>(".plan-actual-heading dl")!;
    expect(within(summary).getByText("Planned").parentElement?.textContent).toMatch(/25 hours/u);
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
});
