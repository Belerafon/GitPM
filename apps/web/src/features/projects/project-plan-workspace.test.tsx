// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type GitPmApi } from "../../api.js";
import type { ConfigurationDocument, ConfigurationResult, DraftStatus, EntityDocument, EntityResult } from "../../types.js";
import { ProjectPlanWorkspace } from "./project-plan-workspace.js";

const fingerprint = "b".repeat(64);
const draft: DraftStatus = { draft_id: "DRF-STAGES", owner_gitlab_user_id: "42", branch: "gitpm/42/DRF-STAGES", base_commit: "a".repeat(40), writer_mode: "ui", state: "open", fingerprint, created_at: "2026-07-10T00:00:00.000Z", updated_at: "2026-07-10T00:00:00.000Z" };
const result = (document: EntityDocument): EntityResult => ({ document, path: `${document.id}.yaml`, blob_id: "a".repeat(40), draft_fingerprint: fingerprint });
const configuration = (document: ConfigurationDocument): ConfigurationResult => ({ document, path: document.schema, blob_id: "a".repeat(40), draft_fingerprint: fingerprint });

const project = result({ schema: "gitpm/project@2", id: "P-26-111111", name: "Alpha", status: "backlog", lifecycle: "active" });
const archivedProject = result({ schema: "gitpm/project@2", id: "P-26-999999", name: "Archived", status: "backlog", lifecycle: "archived", group: "Research" });
const person = result({ schema: "gitpm/person@1", id: "U-26-888888", name: "Ada", weekly_capacity_hours: 40, calendar: "C-26-999999", lifecycle: "active" });
const stage = result({ schema: "gitpm/milestone@2", id: "M-26-222222", project: project.document.id, name: "Launch", lifecycle: "active", schedules: { plan: { finish: "2026-08-01" } } });
const laterStage = result({ schema: "gitpm/milestone@2", id: "M-26-777777", project: project.document.id, name: "Follow-up", lifecycle: "active", schedules: { plan: { finish: "2026-09-01" } } });
const linked = result({ schema: "gitpm/task@2", id: "T-26-333333", project: project.document.id, milestone: stage.document.id, title: "Linked task", type: "task", status: "done", lifecycle: "active", schedules: { plan: { effort_hours: 20 } }, assignees: [person.document.id] });
const other = result({ schema: "gitpm/task@2", id: "T-26-444444", project: project.document.id, title: "Without stage", type: "task", status: "backlog", lifecycle: "active" });
const urgent = result({ schema: "gitpm/task@2", id: "T-26-555555", project: project.document.id, milestone: stage.document.id, title: "Zebra task", type: "task", status: "backlog", lifecycle: "active", schedules: { plan: { finish: "2026-07-20", effort_hours: 2 } } });
const large = result({ schema: "gitpm/task@2", id: "T-26-666666", project: project.document.id, milestone: stage.document.id, title: "Alpha task", type: "task", status: "backlog", lifecycle: "active", schedules: { plan: { finish: "2026-09-01", effort_hours: 13 } } });
const summaryProject = result({ schema: "gitpm/project@2", id: "P-26-SUM", name: "Summary project", status: "backlog", lifecycle: "active" });
const summaryStage = result({ schema: "gitpm/milestone@2", id: "M-26-SUM", project: summaryProject.document.id, name: "Summary stage", lifecycle: "active" });

function api(
  initialTasks: readonly EntityResult[] = [linked, other, large, urgent],
  initialStages: readonly EntityResult[] = [stage, laterStage],
  initialProject: EntityResult = project,
) {
  let currentProject = initialProject;
  let currentStages = [...initialStages];
  let currentTasks = [...initialTasks];
  const createEntity = vi.fn(async (_draftId: string, _type: string, _fingerprint: string, document: EntityDocument) => result(document));
  const updateEntity = vi.fn(async (_draftId: string, type: string, _entity: EntityResult, _fingerprint: string, document: EntityDocument) => {
    const updated = result(document);
    if (type === "projects") currentProject = updated;
    if (type === "milestones") currentStages = currentStages.map((item) => item.document.id === document.id ? updated : item);
    if (type === "tasks") currentTasks = currentTasks.map((item) => item.document.id === document.id ? updated : item);
    return updated;
  });
  const deleteEntity = vi.fn(async () => undefined);
  return {
    projectWorkspace: vi.fn(async () => ({ project: currentProject, milestones: currentStages, tasks: currentTasks, draft_fingerprint: fingerprint })),
    getConfiguration: vi.fn(async (_draftId: string, kind: "statuses" | "issue-types" | "schedule-tracks") => configuration(kind === "statuses"
      ? { schema: "gitpm/statuses@2", statuses: [{ slug: "backlog", title: "Backlog", color: "gray", active: true, category: "backlog" }, { slug: "done", title: "Done", color: "green", active: true, category: "done" }] }
      : kind === "schedule-tracks"
      ? { schema: "gitpm/schedule-tracks@1", tracks: [{ slug: "plan", title: "Plan", kind: "manual", capabilities: ["dates", "effort", "dependencies"] }], defaults: { enabled_tracks: ["plan"], primary_track: "plan", workload_track: "plan", dashboard_tracks: ["plan"] } }
      : { schema: "gitpm/issue-types@1", issue_types: [{ slug: "task", title: "Task", active: true }] })),
    listEntities: vi.fn(async (_draftId: string, type: string) => type === "people" ? [person] : type === "projects" ? [currentProject, archivedProject] : []),
    createEntity,
    updateEntity,
    deleteEntity,
  } as unknown as GitPmApi & { createEntity: typeof createEntity; updateEntity: typeof updateEntity; deleteEntity: typeof deleteEntity };
}

afterEach(() => { cleanup(); localStorage.clear(); vi.useRealTimers(); });

const multitrackConfig: ConfigurationDocument = {
  schema: "gitpm/schedule-tracks@1",
  tracks: [
    { slug: "plan", title: "Plan", kind: "manual", capabilities: ["dates", "effort", "dependencies"] },
    { slug: "target", title: "Target", kind: "manual", capabilities: ["dates"] },
    { slug: "actual", title: "Actual activity", kind: "actual", source: "time_entries" },
  ],
  defaults: { enabled_tracks: ["plan", "target", "actual"], primary_track: "plan", workload_track: "plan", comparison_track: "target", dashboard_tracks: ["plan", "target", "actual"] },
};

const useMultitrackConfig = (client: GitPmApi, tracksConfig: ConfigurationDocument = multitrackConfig): void => {
  vi.spyOn(client, "getConfiguration").mockImplementation(async (_draftId: string, kind: "statuses" | "issue-types" | "work-categories" | "schedule-tracks") => configuration(kind === "statuses"
    ? { schema: "gitpm/statuses@2", statuses: [{ slug: "backlog", title: "Backlog", color: "gray", active: true, category: "backlog" }, { slug: "done", title: "Done", color: "green", active: true, category: "done" }] }
    : kind === "schedule-tracks"
    ? tracksConfig
    : { schema: "gitpm/issue-types@1", issue_types: [{ slug: "task", title: "Task", active: true }] }));
};

const useSummaryStatusConfig = (client: GitPmApi): void => {
  vi.spyOn(client, "getConfiguration").mockImplementation(async (_draftId: string, kind: "statuses" | "issue-types" | "work-categories" | "schedule-tracks") => configuration(kind === "statuses"
    ? { schema: "gitpm/statuses@2", statuses: [
      { slug: "backlog", title: "Backlog", color: "gray", active: true, category: "backlog" },
      { slug: "in-progress", title: "In progress", color: "blue", active: true, category: "active" },
      { slug: "done", title: "Done", color: "green", active: true, category: "done" },
    ] }
    : kind === "schedule-tracks"
    ? { schema: "gitpm/schedule-tracks@1", tracks: [{ slug: "plan", title: "Plan", kind: "manual", capabilities: ["dates", "effort", "dependencies"] }], defaults: { enabled_tracks: ["plan"], primary_track: "plan", workload_track: "plan", dashboard_tracks: ["plan"] } }
    : { schema: "gitpm/issue-types@1", issue_types: [{ slug: "task", title: "Task", active: true }] }));
};

const useBlockedStatusConfig = (client: GitPmApi): void => {
  vi.spyOn(client, "getConfiguration").mockImplementation(async (_draftId: string, kind: "statuses" | "issue-types" | "work-categories" | "schedule-tracks") => configuration(kind === "statuses"
    ? { schema: "gitpm/statuses@2", statuses: [
      { slug: "backlog", title: "Backlog", color: "gray", active: true, category: "backlog" },
      { slug: "in-progress", title: "In progress", color: "blue", active: true, category: "active" },
      { slug: "blocked", title: "Blocked", color: "red", active: true, category: "active" },
      { slug: "done", title: "Done", color: "green", active: true, category: "done" },
    ] }
    : kind === "schedule-tracks"
    ? { schema: "gitpm/schedule-tracks@1", tracks: [{ slug: "plan", title: "Plan", kind: "manual", capabilities: ["dates", "effort", "dependencies"] }], defaults: { enabled_tracks: ["plan"], primary_track: "plan", workload_track: "plan", dashboard_tracks: ["plan"] } }
    : { schema: "gitpm/issue-types@1", issue_types: [{ slug: "task", title: "Task", active: true }] }));
};

const summaryTasksFixture = (): readonly EntityResult[] => [
  result({ schema: "gitpm/task@2", id: "T-26-DONE", project: summaryProject.document.id, milestone: summaryStage.document.id, title: "Done task", type: "task", status: "done", lifecycle: "active", schedules: { plan: { finish: "2026-07-10" } } }),
  result({ schema: "gitpm/task@2", id: "T-26-ACT", project: summaryProject.document.id, milestone: summaryStage.document.id, title: "Active task", type: "task", status: "in-progress", lifecycle: "active", schedules: { plan: { finish: "2026-12-01" } } }),
  result({ schema: "gitpm/task@2", id: "T-26-OD", project: summaryProject.document.id, milestone: summaryStage.document.id, title: "Overdue task", type: "task", status: "backlog", lifecycle: "active", schedules: { plan: { finish: "2026-07-15" } } }),
];

describe("ProjectPlanWorkspace", () => {
  it("creates a Milestone from the live Project route with the simplified primary-track form", async () => {
    const client = api([], []);
    render(<ProjectPlanWorkspace api={client} draft={draft} locale="en" onChanged={vi.fn(async () => undefined)} onNavigate={vi.fn()} projectId={project.document.id} />);

    await screen.findByRole("heading", { name: "Alpha" });
    fireEvent.click(screen.getByRole("button", { name: /New milestone/u }));
    const dialog = screen.getByRole("dialog", { name: "New milestone" });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Created milestone" } });
    fireEvent.change(within(dialog).getByLabelText("Due date"), { target: { value: "2026-08-31" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(client.createEntity).toHaveBeenCalledWith(draft.draft_id, "milestones", fingerprint, expect.objectContaining({
      name: "Created milestone",
      schedules: { plan: { finish: "2026-08-31" } },
    })));
  });

  it("edits Project and Milestone schedule tracks in the live project workspaces without replacing neighboring windows", async () => {
    const multitrackProject = result({
      ...project.document,
      planning: { enabled_tracks: ["working", "target", "actual"], primary_track: "working", workload_track: "working", dashboard_tracks: ["working", "target", "actual"] },
      schedules: { working: { finish: "2026-08-20" }, target: { finish: "2026-08-30" } },
    });
    const multitrackStage = result({
      ...stage.document,
      schedules: { working: { finish: "2026-09-20" }, target: { finish: "2026-09-30" } },
    });
    const client = api([], [multitrackStage], multitrackProject);
    vi.spyOn(client, "getConfiguration").mockImplementation(async (_draftId: string, kind: "statuses" | "issue-types" | "work-categories" | "schedule-tracks") => configuration(kind === "statuses"
      ? { schema: "gitpm/statuses@2", statuses: [{ slug: "backlog", title: "Backlog", color: "gray", active: true, category: "backlog" }] }
      : kind === "schedule-tracks"
      ? { schema: "gitpm/schedule-tracks@1", tracks: [
          { slug: "working", title: "Working", kind: "manual", capabilities: ["dates", "effort", "dependencies"] },
          { slug: "target", title: "Target", kind: "manual", capabilities: ["dates"] },
          { slug: "actual", title: "Actual activity", kind: "actual", source: "time_entries" },
        ], defaults: { enabled_tracks: ["working"], primary_track: "working", workload_track: "working", dashboard_tracks: ["working"] } }
      : { schema: "gitpm/issue-types@1", issue_types: [{ slug: "task", title: "Task", active: true }] }));

    const rendered = render(<ProjectPlanWorkspace api={client} draft={draft} locale="en" onChanged={vi.fn(async () => undefined)} onNavigate={vi.fn()} projectId={multitrackProject.document.id} />);
    await screen.findByRole("heading", { name: "Alpha" });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    let dialog = screen.getByRole("dialog", { name: "Edit: Alpha" });
    expect(within(dialog).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Working · primary", "Target"]);
    expect(within(dialog).getByText(/Actual activity is recorded from time entries/u)).toBeTruthy();
    expect(within(dialog).queryByText("Dependencies")).toBeNull();

    const enabledTracks = within(dialog).getByText("Enabled tracks").closest<HTMLElement>(".planning-field")!;
    const targetToggle = within(enabledTracks).getByText("Target").closest("label")!.querySelector("input")!;
    fireEvent.click(targetToggle);
    expect(within(dialog).queryByRole("tab", { name: "Target" })).toBeNull();
    fireEvent.click(targetToggle);
    expect(within(dialog).getByRole("tab", { name: "Target" })).toBeTruthy();

    fireEvent.change(within(dialog).getByLabelText("Due date"), { target: { value: "2026-08-25" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(client.updateEntity.mock.calls.at(-1)?.[4]).toMatchObject({
      schedules: { working: { finish: "2026-08-25" }, target: { finish: "2026-08-30" } },
    }));

    rendered.unmount();
    render(<ProjectPlanWorkspace api={client} draft={draft} locale="en" onChanged={vi.fn(async () => undefined)} onNavigate={vi.fn()} projectId={multitrackProject.document.id} selectedStageId={multitrackStage.document.id} />);
    const inspector = await screen.findByRole("complementary", { name: "Milestone" });
    fireEvent.click(within(inspector).getByRole("button", { name: "Edit" }));
    dialog = screen.getByRole("dialog", { name: "Edit milestone" });
    fireEvent.click(within(dialog).getByRole("tab", { name: "Target" }));
    expect(within(dialog).queryByText("Dependencies")).toBeNull();
    fireEvent.change(within(dialog).getByLabelText("Due date"), { target: { value: "2026-10-05" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(client.updateEntity.mock.calls.at(-1)?.[4]).toMatchObject({
      schedules: { working: { finish: "2026-09-20" }, target: { finish: "2026-10-05" } },
    }));
  });

  it.each(["Project", "Milestone", "Task"] as const)("prevents disabling a track used only by a %s schedule", async (entityType) => {
    const planning = { enabled_tracks: ["plan", "target", "actual"], primary_track: "plan", workload_track: "plan", comparison_track: "target", dashboard_tracks: ["plan", "target", "actual"] };
    const scheduledProject = result({ ...project.document, planning, ...(entityType === "Project" ? { schedules: { target: { finish: "2026-08-30" } } } : {}) });
    const scheduledStage = result({ ...stage.document, schedules: entityType === "Milestone" ? { target: { finish: "2026-08-30" } } : undefined });
    const scheduledTask = result({ ...linked.document, schedules: entityType === "Task" ? { target: { finish: "2026-08-30" } } : undefined });
    const client = api([scheduledTask], [scheduledStage], scheduledProject);
    useMultitrackConfig(client);

    render(<ProjectPlanWorkspace api={client} draft={draft} locale="en" onChanged={vi.fn(async () => undefined)} onNavigate={vi.fn()} projectId={project.document.id} />);
    await screen.findByRole("heading", { name: "Alpha" });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog", { name: "Edit: Alpha" });
    const target = within(dialog).getByText("Target", { selector: ".planning-checkboxes span" }).closest("label")!;

    expect((target.querySelector("input") as HTMLInputElement).disabled).toBe(true);
    expect(target.textContent).toContain("Clear this track's schedule data before disabling it.");
  });

  it("allows disabling a project track immediately after its last draft window is cleared", async () => {
    const scheduledProject = result({
      ...project.document,
      planning: { enabled_tracks: ["plan", "target", "actual"], primary_track: "plan", workload_track: "plan", comparison_track: "target", dashboard_tracks: ["plan", "target", "actual"] },
      schedules: { target: { finish: "2026-08-30" } },
    });
    const client = api([], [], scheduledProject);
    useMultitrackConfig(client);

    render(<ProjectPlanWorkspace api={client} draft={draft} locale="en" onChanged={vi.fn(async () => undefined)} onNavigate={vi.fn()} projectId={project.document.id} />);
    await screen.findByRole("heading", { name: "Alpha" });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog", { name: "Edit: Alpha" });
    const target = within(dialog).getByText("Target", { selector: ".planning-checkboxes span" }).closest("label")!;
    const checkbox = target.querySelector("input") as HTMLInputElement;
    expect(checkbox.disabled).toBe(true);

    fireEvent.click(within(dialog).getByRole("tab", { name: "Target" }));
    fireEvent.change(within(dialog).getByLabelText("Due date"), { target: { value: "" } });

    expect(checkbox.disabled).toBe(false);
    expect(target.textContent).not.toContain("Clear this track's schedule data before disabling it.");
  });

  it("allows disabling an unused track", async () => {
    const configuredProject = result({ ...project.document, planning: { enabled_tracks: ["plan", "target", "actual"], primary_track: "plan", workload_track: "plan", comparison_track: "target", dashboard_tracks: ["plan", "target", "actual"] } });
    const client = api([], [], configuredProject);
    useMultitrackConfig(client);

    render(<ProjectPlanWorkspace api={client} draft={draft} locale="en" onChanged={vi.fn(async () => undefined)} onNavigate={vi.fn()} projectId={project.document.id} />);
    await screen.findByRole("heading", { name: "Alpha" });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog", { name: "Edit: Alpha" });
    const checkbox = within(dialog).getByText("Target", { selector: ".planning-checkboxes span" }).closest("label")!.querySelector("input") as HTMLInputElement;

    expect(checkbox.disabled).toBe(false);
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(false);
  });

  it("blocks disabling the last workload-capable track without calling updateEntity", async () => {
    const configuredProject = result({ ...project.document, planning: { enabled_tracks: ["plan", "target", "actual"], primary_track: "plan", workload_track: "plan", comparison_track: "target", dashboard_tracks: ["plan", "target", "actual"] } });
    const client = api([], [], configuredProject);
    useMultitrackConfig(client);

    render(<ProjectPlanWorkspace api={client} draft={draft} locale="en" onChanged={vi.fn(async () => undefined)} onNavigate={vi.fn()} projectId={project.document.id} />);
    await screen.findByRole("heading", { name: "Alpha" });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog", { name: "Edit: Alpha" });
    const checkbox = within(dialog).getByText("Plan", { selector: ".planning-checkboxes span" }).closest("label")!.querySelector("input") as HTMLInputElement;

    expect(checkbox.disabled).toBe(true);
    fireEvent.click(checkbox);
    expect(client.updateEntity).not.toHaveBeenCalled();
  });

  it("switches workload to the remaining capable track and saves complete valid planning", async () => {
    const alternativeConfig: ConfigurationDocument = {
      schema: "gitpm/schedule-tracks@1",
      tracks: [
        { slug: "plan", title: "Plan", kind: "manual", capabilities: ["dates", "effort"] },
        { slug: "forecast", title: "Forecast", kind: "manual", capabilities: ["dates", "effort"] },
        { slug: "actual", title: "Actual activity", kind: "actual", source: "time_entries" },
      ],
      defaults: { enabled_tracks: ["plan", "forecast", "actual"], primary_track: "plan", workload_track: "plan", comparison_track: "forecast", dashboard_tracks: ["plan", "forecast", "actual"] },
    };
    const configuredProject = result({ ...project.document, planning: alternativeConfig.defaults });
    const client = api([], [], configuredProject);
    useMultitrackConfig(client, alternativeConfig);

    render(<ProjectPlanWorkspace api={client} draft={draft} locale="en" onChanged={vi.fn(async () => undefined)} onNavigate={vi.fn()} projectId={project.document.id} />);
    await screen.findByRole("heading", { name: "Alpha" });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog", { name: "Edit: Alpha" });
    const checkbox = within(dialog).getByText("Plan", { selector: ".planning-checkboxes span" }).closest("label")!.querySelector("input") as HTMLInputElement;

    expect(checkbox.disabled).toBe(false);
    fireEvent.click(checkbox);
    expect((within(dialog).getByLabelText("Workload track") as HTMLSelectElement).value).toBe("forecast");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(client.updateEntity).toHaveBeenCalled());
    expect(client.updateEntity.mock.calls.at(-1)?.[4]).toMatchObject({
      planning: { enabled_tracks: ["forecast", "actual"], primary_track: "forecast", workload_track: "forecast", comparison_track: "forecast", dashboard_tracks: ["forecast", "actual"] },
    });
  });

  it("rejects invalid effective planning before calling updateEntity", async () => {
    const invalidConfig: ConfigurationDocument = {
      schema: "gitpm/schedule-tracks@1",
      tracks: [
        { slug: "plan", title: "Plan", kind: "manual", capabilities: ["dates", "effort"] },
        { slug: "actual", title: "Actual activity", kind: "actual", source: "time_entries" },
      ],
      defaults: { enabled_tracks: ["plan", "actual"], primary_track: "actual", workload_track: "plan", dashboard_tracks: ["plan", "actual"] },
    };
    const client = api([], [], project);
    useMultitrackConfig(client, invalidConfig);

    render(<ProjectPlanWorkspace api={client} draft={draft} locale="en" onChanged={vi.fn(async () => undefined)} onNavigate={vi.fn()} projectId={project.document.id} />);
    await screen.findByRole("heading", { name: "Alpha" });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog", { name: "Edit: Alpha" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(client.updateEntity).not.toHaveBeenCalled();
    expect(await screen.findByText("primary_track actual must be a manual track")).toBeTruthy();
  });

  it("allows disabling the actual track even when the project has TimeEntry data", async () => {
    const configuredProject = result({
      ...project.document,
      planning: { enabled_tracks: ["plan", "target", "actual"], primary_track: "plan", workload_track: "plan", comparison_track: "target", dashboard_tracks: ["plan", "target", "actual"] },
      schedules: { plan: { finish: "2026-08-20" }, target: { finish: "2026-08-30" } },
    });
    const client = api([], [], configuredProject);
    useMultitrackConfig(client);

    render(<ProjectPlanWorkspace api={client} draft={draft} locale="en" onChanged={vi.fn(async () => undefined)} onNavigate={vi.fn()} projectId={project.document.id} />);
    await screen.findByRole("heading", { name: "Alpha" });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog", { name: "Edit: Alpha" });
    const checkbox = within(dialog).getByText("Actual activity", { selector: ".planning-checkboxes span" }).closest("label")!.querySelector("input") as HTMLInputElement;

    expect(checkbox.disabled).toBe(false);
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(false);
  });

  it("does not materialize repository planning defaults when only the project name changes", async () => {
    const client = api([], [], project);
    useMultitrackConfig(client);

    render(<ProjectPlanWorkspace api={client} draft={draft} locale="en" onChanged={vi.fn(async () => undefined)} onNavigate={vi.fn()} projectId={project.document.id} />);
    await screen.findByRole("heading", { name: "Alpha" });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog", { name: "Edit: Alpha" });
    expect((within(dialog).getByLabelText("Primary track") as HTMLSelectElement).value).toBe("plan");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Renamed" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(client.updateEntity).toHaveBeenCalled());
    expect(client.updateEntity.mock.calls.at(-1)?.[4]).not.toHaveProperty("planning");
  });

  it("materializes a complete planning override after an explicit primary-track change", async () => {
    const client = api([], [], project);
    useMultitrackConfig(client);

    render(<ProjectPlanWorkspace api={client} draft={draft} locale="en" onChanged={vi.fn(async () => undefined)} onNavigate={vi.fn()} projectId={project.document.id} />);
    await screen.findByRole("heading", { name: "Alpha" });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog", { name: "Edit: Alpha" });
    fireEvent.change(within(dialog).getByLabelText("Primary track"), { target: { value: "target" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(client.updateEntity).toHaveBeenCalled());
    expect(client.updateEntity.mock.calls.at(-1)?.[4]).toMatchObject({
      planning: { enabled_tracks: ["plan", "target", "actual"], primary_track: "target", workload_track: "plan", comparison_track: "target", dashboard_tracks: ["plan", "target", "actual"] },
    });
  });

  it("shows resolved hierarchy overflow dates in the milestone inspector", async () => {
    const overflowingStage = result({ ...stage.document, schedules: { plan: { start: "2026-08-05", finish: "2026-08-10" } } });
    const parent = result({ ...urgent.document, title: "Rollup parent", schedules: undefined });
    const child = result({ ...large.document, parent: parent.document.id, title: "Rollup child", schedules: { plan: { start: "2026-08-01", finish: "2026-08-15", effort_hours: 7 } } });
    const client = api([parent, child], [overflowingStage]);

    render(<ProjectPlanWorkspace api={client} draft={draft} locale="en" onChanged={vi.fn(async () => undefined)} onNavigate={vi.fn()} projectId={project.document.id} selectedStageId={overflowingStage.document.id} />);

    const inspector = await screen.findByRole("complementary", { name: "Milestone" });
    expect(within(inspector).getByText("Schedule overflow")).toBeTruthy();
    expect(inspector.textContent).toContain("Plan");
    expect(inspector.textContent).toContain("set to Aug 5, 2026");
    expect(inspector.textContent).toContain("child items reach Aug 1, 2026");
    expect(inspector.textContent).toContain("set to Aug 10, 2026");
    expect(inspector.textContent).toContain("child items reach Aug 15, 2026");
  });

  it("edits and removes the Project group from the active project route", async () => {
    const client = api();
    render(<ProjectPlanWorkspace api={client} draft={draft} locale="en" onChanged={vi.fn(async () => undefined)} onNavigate={vi.fn()} projectId={project.document.id} />);

    await screen.findByRole("heading", { name: "Alpha" });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    let dialog = screen.getByRole("dialog", { name: "Edit: Alpha" });
    expect(within(dialog).getByRole("option", { name: "Research" })).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("Group"), { target: { value: "__new__" } });
    fireEvent.change(within(dialog).getByLabelText("New group name"), { target: { value: "  Operations  " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(client.updateEntity).toHaveBeenCalledWith(
      draft.draft_id,
      "projects",
      project,
      fingerprint,
      expect.objectContaining({ group: "Operations" }),
    ));
    expect(await screen.findByText("Operations")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    dialog = screen.getByRole("dialog", { name: "Edit: Alpha" });
    fireEvent.change(within(dialog).getByLabelText("Group"), { target: { value: "" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(client.updateEntity.mock.calls.at(-1)?.[4]).not.toHaveProperty("group"));
  });

  it("shows structured repository diagnostics when a Project group update fails validation", async () => {
    const client = api();
    client.updateEntity.mockRejectedValueOnce(new ApiError(
      "VALIDATION_FAILED",
      "Repository validation failed with 1 error",
      [{
        code: "REPOSITORY_TOP_LEVEL",
        path: "legacy-exports",
        message: 'Unknown top-level directory "legacy-exports"; add it to allowed_top_level_directories in .gitpm/repository.yaml if it belongs in the repository',
      }],
    ));
    render(<ProjectPlanWorkspace api={client} draft={draft} locale="en" onChanged={vi.fn(async () => undefined)} onNavigate={vi.fn()} projectId={project.document.id} />);

    await screen.findByRole("heading", { name: "Alpha" });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog", { name: "Edit: Alpha" });
    fireEvent.change(within(dialog).getByLabelText("Group"), { target: { value: "__new__" } });
    fireEvent.change(within(dialog).getByLabelText("New group name"), { target: { value: "Operations" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      const diagnostic = document.querySelector(".alert.error")?.textContent ?? "";
      expect(diagnostic).toContain("[VALIDATION_FAILED]");
      expect(diagnostic).toContain("[REPOSITORY_TOP_LEVEL] legacy-exports");
      expect(diagnostic).toContain("allowed_top_level_directories");
    });
    expect(screen.getByRole("dialog", { name: "Edit: Alpha" })).toBeTruthy();
  });

  it("lists every project reference and requires a second confirmation before cascading deletion", async () => {
    const client = api();
    const confirmAction = vi.fn(() => true);
    const onChanged = vi.fn(async () => undefined);
    const onNavigate = vi.fn();
    client.deleteEntity
      .mockRejectedValueOnce(new ApiError("DELETE_RESTRICTED", `${project.document.id} is referenced`, [
        { path: "projects/P-26-111111/milestones/M-26-222222.yaml", label: "Launch" },
        { path: "projects/P-26-111111/tasks/T-26-333333.yaml", label: "Linked task" },
      ]))
      .mockResolvedValueOnce(undefined);
    render(<ProjectPlanWorkspace api={client} confirmAction={confirmAction} draft={draft} locale="en" onChanged={onChanged} onNavigate={onNavigate} projectId={project.document.id} />);

    await screen.findByRole("heading", { name: "Alpha" });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog", { name: "Edit: Alpha" });
    fireEvent.click(within(dialog).getByText("More actions"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(client.deleteEntity).toHaveBeenCalledTimes(2));
    expect(confirmAction).toHaveBeenNthCalledWith(1, "Delete Alpha permanently? This action cannot be undone.");
    expect(confirmAction).toHaveBeenNthCalledWith(2, "Alpha still contains or is referenced by 2 items:\n• Launch (projects/P-26-111111/milestones/M-26-222222.yaml)\n• Linked task (projects/P-26-111111/tasks/T-26-333333.yaml)\n\nDelete all listed items and then delete the project permanently?");
    expect(client.deleteEntity).toHaveBeenNthCalledWith(1, draft.draft_id, "projects", project, fingerprint);
    expect(client.deleteEntity).toHaveBeenNthCalledWith(2, draft.draft_id, "projects", project, fingerprint, false, true);
    expect(onChanged).toHaveBeenCalledOnce();
    expect(onNavigate).toHaveBeenCalledWith("projects");
  });

  it("keeps the project unchanged when the reference cascade confirmation is denied", async () => {
    const client = api();
    const confirmAction = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    const onNavigate = vi.fn();
    client.deleteEntity.mockRejectedValueOnce(new ApiError("DELETE_RESTRICTED", `${project.document.id} is referenced`, [
      { path: "projects/P-26-111111/tasks/T-26-333333.yaml", label: "Linked task" },
    ]));
    render(<ProjectPlanWorkspace api={client} confirmAction={confirmAction} draft={draft} locale="en" onChanged={vi.fn(async () => undefined)} onNavigate={onNavigate} projectId={project.document.id} />);

    await screen.findByRole("heading", { name: "Alpha" });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog", { name: "Edit: Alpha" });
    fireEvent.click(within(dialog).getByText("More actions"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(confirmAction).toHaveBeenCalledTimes(2));
    expect(client.deleteEntity).toHaveBeenCalledOnce();
    expect(onNavigate).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Edit: Alpha" })).toBeTruthy();
  });

  it("§15.1: does not render the actual-hours report on the main project page (effort is a separate route)", async () => {
    // The refactor extracted the actual-hours report into the dedicated effort route.
    // The main project page must not surface it, so the two scopes stay separable.
    const client = api();
    render(<ProjectPlanWorkspace api={client} draft={draft} locale="en" onChanged={vi.fn(async () => undefined)} onNavigate={vi.fn()} projectId={project.document.id} />);
    await screen.findByRole("heading", { name: "Alpha" });
    expect(screen.queryByRole("heading", { name: "Actual hours report" })).toBeNull();
    expect(screen.queryByText("Actual hours report")).toBeNull();
  });

  it("shows every task inside the project plan and opens a stage as a first-class route", async () => {
    const client = api(); const onNavigate = vi.fn();
    render(<ProjectPlanWorkspace api={client} draft={draft} locale="en" onChanged={vi.fn(async () => undefined)} onNavigate={onNavigate} projectId={project.document.id} />);

    const stageHeading = await screen.findByRole("heading", { name: "Launch" });
    const stageCard = stageHeading.closest<HTMLElement>("article")!;
    expect(document.querySelector(".project-plan-project-kind")?.textContent).toBe(`Project ${project.document.id}`);
    expect(screen.getByText("Linked task")).toBeTruthy();
    expect(screen.getByText("Without stage")).toBeTruthy();
    expect(stageCard.querySelector(".project-plan-stage-assignees")?.textContent).toContain("Ada");
    expect(screen.getByText("Linked task").closest(".project-plan-task-row")?.querySelector(".task-assignees")?.textContent).toBe("Ada");
    fireEvent.click(screen.getByText("Customize task fields"));
    fireEvent.click(screen.getByRole("checkbox", { name: "Assignees" }));
    expect(stageCard.querySelector(".project-plan-stage-assignees")).toBeNull();
    expect(screen.getByText("Linked task").closest(".project-plan-task-row")?.querySelector(".task-assignees")).toBeNull();
    fireEvent.click(within(stageCard).getByRole("button", { name: /Milestone: Launch/u }));
    expect(onNavigate).toHaveBeenCalledWith("stages", { projectId: project.document.id, stageId: stage.document.id });

    fireEvent.click(within(stageCard).getByRole("button", { name: /Linked task/u }));
    expect(onNavigate).toHaveBeenLastCalledWith("tasks", { projectId: project.document.id, taskId: linked.document.id });

    const inlineStatus = screen.getByRole<HTMLSelectElement>("combobox", { name: "Status: Without stage" });
    fireEvent.change(inlineStatus, { target: { value: "done" } });
    expect(inlineStatus.value).toBe("done");
    expect(screen.getByText("Without stage").closest(".project-plan-task-row")?.classList.contains("is-saving")).toBe(true);
    await waitFor(() => expect(client.updateEntity).toHaveBeenCalledWith(draft.draft_id, "tasks", other, fingerprint, expect.objectContaining({ status: "done" })));

    fireEvent.click(within(stageCard).getByRole("button", { name: /New task/u }));
    const dialog = screen.getByRole("dialog", { name: "New task" });
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Created from plan" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /Add assignee/u }));
    fireEvent.change(within(dialog).getByLabelText("Search people"), { target: { value: "Ada" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Ada" }));
    fireEvent.change(within(dialog).getByLabelText("Start date"), { target: { value: "2026-07-20" } });
    fireEvent.change(within(dialog).getByLabelText("Due date"), { target: { value: "2026-07-24" } });
    fireEvent.change(within(dialog).getByLabelText("Estimate (hours)"), { target: { value: "20" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(client.createEntity).toHaveBeenCalled());
    expect(client.createEntity.mock.calls[0]?.[3]).toMatchObject({ project: project.document.id, milestone: stage.document.id, title: "Created from plan", assignees: [person.document.id], schedules: { plan: { start: "2026-07-20", finish: "2026-07-24", effort_hours: 20 } } });
  });

  it("renders a resizable task inspector and persists the chosen width", async () => {
    const client = api();
    render(<ProjectPlanWorkspace api={client} draft={draft} locale="en" onChanged={vi.fn(async () => undefined)} onNavigate={vi.fn()} projectId={project.document.id} selectedTaskId={linked.document.id} />);

    const resizer = await screen.findByRole("separator", { name: "Resize detail panel" });
    expect(resizer.getAttribute("aria-valuemin")).toBe("340");
    expect(resizer.getAttribute("aria-valuemax")).toBe("760");
    expect(resizer.getAttribute("aria-valuenow")).toBe("410");
    expect(document.querySelector(".project-plan-inspector.task-inspector")).toBeTruthy();

    fireEvent.keyDown(resizer, { key: "ArrowLeft" });
    await waitFor(() => expect(resizer.getAttribute("aria-valuenow")).toBe("426"));
    expect(localStorage.getItem("gitpm.projectPlan.inspectorWidth")).toBe("426");

    fireEvent.keyDown(resizer, { key: "ArrowRight", shiftKey: true });
    await waitFor(() => expect(resizer.getAttribute("aria-valuenow")).toBe("386"));
    expect(localStorage.getItem("gitpm.projectPlan.inspectorWidth")).toBe("386");

    fireEvent.keyDown(resizer, { key: "Enter" });
    await waitFor(() => expect(resizer.getAttribute("aria-valuenow")).toBe("410"));
  });

  it("does not render the inspector resizer when no task or milestone is selected", async () => {
    const client = api();
    render(<ProjectPlanWorkspace api={client} draft={draft} locale="en" onChanged={vi.fn(async () => undefined)} onNavigate={vi.fn()} projectId={project.document.id} />);
    await screen.findByRole("heading", { name: "Alpha" });
    expect(screen.queryByRole("separator", { name: "Resize detail panel" })).toBeNull();
  });

  it("numbers milestones and tasks and persists their manual order", async () => {
    const orderedStage = result({ ...stage.document, task_order: [urgent.document.id, large.document.id, linked.document.id] });
    const client = api([linked, other, large, urgent], [orderedStage, laterStage]); const onNavigate = vi.fn();
    render(<ProjectPlanWorkspace api={client} draft={draft} locale="en" onChanged={vi.fn(async () => undefined)} onNavigate={onNavigate} projectId={project.document.id} />);

    const stageHeading = await screen.findByRole("heading", { name: "Launch" });
    const stageCard = stageHeading.closest<HTMLElement>("article")!;
    const titles = () => Array.from(stageCard.querySelectorAll(".project-plan-task-row strong"), (element) => element.textContent);
    expect(titles()).toEqual(["Zebra task", "Alpha task", "Linked task"]);
    expect(stageCard.querySelector(".project-plan-stage-kind")?.textContent).toBe(`Milestone 1. ${stage.document.id}.`);
    expect(stageCard.querySelector(".project-plan-task-kind")?.textContent).toBe(`Task 1.1. ${urgent.document.id}.`);

    fireEvent.click(within(stageCard).getByRole("button", { name: "Move task 1.2 up" }));
    expect(titles()).toEqual(["Alpha task", "Zebra task", "Linked task"]);
    expect(screen.getByText("Alpha task").closest(".project-plan-task-row")?.classList.contains("is-saving")).toBe(true);
    expect(screen.getByText("Zebra task").closest(".project-plan-task-row")?.classList.contains("is-saving")).toBe(true);
    expect(document.querySelector(".workspace-loading")).toBeNull();
    await waitFor(() => expect(screen.getByText("Alpha task").closest(".project-plan-task-row")?.classList.contains("recently-changed")).toBe(true));
    expect(screen.getByText("Zebra task").closest(".project-plan-task-row")?.classList.contains("recently-changed")).toBe(true);
    await waitFor(() => expect(titles()).toEqual(["Alpha task", "Zebra task", "Linked task"]));
    expect(client.updateEntity.mock.calls[0]?.[1]).toBe("milestones");
    expect(client.updateEntity.mock.calls[0]?.[4]).toMatchObject({ task_order: [large.document.id, urgent.document.id, linked.document.id] });

    const moveMilestoneDown = screen.getByRole<HTMLButtonElement>("button", { name: "Move milestone 1 down" });
    await waitFor(() => expect(moveMilestoneDown.disabled).toBe(false));
    fireEvent.click(moveMilestoneDown);
    expect(stageCard.classList.contains("is-saving")).toBe(true);
    expect(screen.getByRole("heading", { name: "Follow-up" }).closest(".project-plan-stage")?.classList.contains("is-saving")).toBe(true);
    await waitFor(() => expect(stageCard.classList.contains("recently-changed")).toBe(true));
    expect(screen.getByRole("heading", { name: "Follow-up" }).closest(".project-plan-stage")?.classList.contains("recently-changed")).toBe(true);
    await waitFor(() => expect(stageCard.querySelector(".project-plan-stage-kind")?.textContent).toBe(`Milestone 2. ${stage.document.id}.`));
    expect(stageCard.querySelector(".project-plan-task-kind")?.textContent).toBe(`Task 2.1. ${large.document.id}.`);
    expect(client.updateEntity.mock.calls[1]?.[1]).toBe("projects");
    expect(client.updateEntity.mock.calls[1]?.[4]).toMatchObject({ milestone_order: [laterStage.document.id, stage.document.id] });
  });

  it("renders milestone task_order directly even when tasks from other milestones interleave by due date", async () => {
    const orderedTasks = [
      result({ schema: "gitpm/task@2", id: "T-26-AAAAAA", project: project.document.id, milestone: stage.document.id, title: "Ordered A", type: "task", status: "backlog", lifecycle: "active", due: "2026-08-01" }),
      result({ schema: "gitpm/task@2", id: "T-26-BBBBBB", project: project.document.id, milestone: stage.document.id, title: "Ordered B", type: "task", status: "backlog", lifecycle: "active", due: "2026-08-04" }),
      result({ schema: "gitpm/task@2", id: "T-26-CCCCCC", project: project.document.id, milestone: stage.document.id, title: "Ordered C", type: "task", status: "backlog", lifecycle: "active", due: "2026-08-02" }),
      result({ schema: "gitpm/task@2", id: "T-26-DDDDDD", project: project.document.id, milestone: stage.document.id, title: "Ordered D", type: "task", status: "backlog", lifecycle: "active", due: "2026-08-03" }),
    ];
    const distractors = [
      result({ schema: "gitpm/task@2", id: "T-26-XXXXXX", project: project.document.id, milestone: laterStage.document.id, title: "Distractor 0", type: "task", status: "backlog", lifecycle: "active", due: "2026-08-01" }),
      result({ schema: "gitpm/task@2", id: "T-26-YYYYYY", project: project.document.id, milestone: laterStage.document.id, title: "Distractor 1", type: "task", status: "backlog", lifecycle: "active", due: "2026-08-02" }),
      result({ schema: "gitpm/task@2", id: "T-26-ZZZZZZ", project: project.document.id, milestone: laterStage.document.id, title: "Distractor 2", type: "task", status: "backlog", lifecycle: "active", due: "2026-08-03" }),
      result({ schema: "gitpm/task@2", id: "T-26-WWWWWW", project: project.document.id, milestone: laterStage.document.id, title: "Distractor 3", type: "task", status: "backlog", lifecycle: "active", due: "2026-08-05" }),
    ];
    const orderedStage = result({ ...stage.document, task_order: orderedTasks.map((task) => task.document.id) });
    const client = api(
      [distractors[2]!, ...orderedTasks, distractors[0]!, distractors[1]!, distractors[3]!],
      [orderedStage, laterStage],
    );
    render(<ProjectPlanWorkspace api={client} draft={draft} locale="en" onChanged={vi.fn(async () => undefined)} onNavigate={vi.fn()} projectId={project.document.id} />);

    const stageCard = (await screen.findByRole("heading", { name: "Launch" })).closest<HTMLElement>("article")!;
    expect(Array.from(stageCard.querySelectorAll(".project-plan-task-row strong"), (element) => element.textContent))
      .toEqual(["Ordered A", "Ordered B", "Ordered C", "Ordered D"]);
  });

  it("renders arbitrary-depth subtasks, preserves ancestor context and creates a child in the same milestone", async () => {
    const root = result({ ...urgent.document, title: "Root task" });
    const child = result({ ...large.document, parent: root.document.id, title: "Child task" });
    const grandchild = result({ ...linked.document, parent: child.document.id, title: "Grandchild task" });
    const siblingChild = result({ ...other.document, milestone: stage.document.id, parent: root.document.id, status: "done", title: "Sibling child" });
    const client = api([root, child, grandchild, siblingChild]);
    render(<ProjectPlanWorkspace api={client} draft={draft} initialStatusFilter="done" locale="en" onChanged={vi.fn(async () => undefined)} onNavigate={vi.fn()} projectId={project.document.id} />);

    const stageCard = (await screen.findByRole("heading", { name: "Launch" })).closest<HTMLElement>("article")!;
    expect(screen.getByText("Root task").closest(".project-plan-task-row")?.getAttribute("data-depth")).toBe("0");
    expect(screen.getByText("Child task").closest(".project-plan-task-row")?.getAttribute("data-depth")).toBe("1");
    expect(screen.getByText("Grandchild task").closest(".project-plan-task-row")?.getAttribute("data-depth")).toBe("2");
    expect(screen.getByText("Root task").closest(".project-plan-task-row")?.querySelector(".project-plan-task-kind")?.textContent).toBe(`Task 1.1. ${root.document.id}.`);
    expect(screen.getByText("Child task").closest(".project-plan-task-row")?.querySelector(".project-plan-task-kind")?.textContent).toBe(`Task 1.1.1. ${child.document.id}.`);
    expect(screen.getByText("Grandchild task").closest(".project-plan-task-row")?.querySelector(".project-plan-task-kind")?.textContent).toBe(`Task 1.1.1.1. ${grandchild.document.id}.`);
    expect(screen.getByText("Root task").closest(".project-plan-task-row")?.classList.contains("filter-context")).toBe(true);
    expect(screen.getByText("Child task").closest(".project-plan-task-row")?.classList.contains("filter-context")).toBe(true);
    expect(screen.getByText("Grandchild task").closest(".project-plan-task-row")?.querySelector(".project-plan-task-tree-control")?.textContent).toBe("");
    expect(screen.getByText("Grandchild task").closest(".project-plan-task-row")?.querySelector(".project-plan-task-tree-control button")).toBeNull();
    expect(screen.getByText("Root task").closest(".project-plan-task-row")?.querySelector(".project-plan-task-tree")?.classList.contains("has-visible-children")).toBe(true);
    expect(screen.getByText("Child task").closest(".project-plan-task-row")?.querySelector(".project-plan-task-branch")?.classList.contains("last")).toBe(false);
    expect(screen.getByText("Grandchild task").closest(".project-plan-task-row")?.querySelectorAll(".project-plan-task-ancestor-rail")).toHaveLength(1);
    expect(screen.getByText("Grandchild task").closest(".project-plan-task-row")?.querySelector(".project-plan-task-branch")?.classList.contains("last")).toBe(true);
    expect(screen.getByText("Sibling child").closest(".project-plan-task-row")?.querySelector(".project-plan-task-branch")?.classList.contains("last")).toBe(true);

    const collapseRoot = within(stageCard).getByRole("button", { name: "Collapse subtasks of Root task" });
    expect(collapseRoot.getAttribute("aria-expanded")).toBe("true");
    expect(collapseRoot.querySelector("svg path")?.getAttribute("d")).toBe("m2.5 4 3.5 4 3.5-4");
    fireEvent.click(collapseRoot);
    expect(screen.queryByText("Child task")).toBeNull();
    expect(screen.getByText("Root task").closest(".project-plan-task-row")?.querySelector(".project-plan-task-tree")?.classList.contains("has-visible-children")).toBe(false);
    const expandRoot = within(stageCard).getByRole("button", { name: "Expand subtasks of Root task" });
    expect(expandRoot.getAttribute("aria-expanded")).toBe("false");
    expect(expandRoot.querySelector("svg path")?.getAttribute("d")).toBe("M4 2.5 8 6 4 9.5");
    fireEvent.click(expandRoot);
    const childRow = screen.getByText("Child task").closest(".project-plan-task-row") as HTMLElement;
    const childHandle = childRow.nextElementSibling as HTMLElement;
    fireEvent.click(within(childHandle).getByRole("button", { name: "Insert task" }));
    fireEvent.click(within(childHandle).getByRole("menuitem", { name: /Subtask of .*Child task/u }));
    const dialog = screen.getByRole("dialog", { name: "New subtask" });
    expect(within(dialog).getByText("Child task")).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Nested child" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create task" }));

    await waitFor(() => expect(client.createEntity).toHaveBeenCalled());
    expect(client.createEntity.mock.calls[0]?.[3]).toMatchObject({
      project: project.document.id,
      milestone: stage.document.id,
      parent: child.document.id,
      title: "Nested child",
    });
  });

  it("inserts a new task between two siblings and rewrites the milestone task_order", async () => {
    const taskA = result({ schema: "gitpm/task@2", id: "T-26-AAAAAA", project: project.document.id, milestone: stage.document.id, title: "Task A", type: "task", status: "backlog", lifecycle: "active" });
    const taskB = result({ schema: "gitpm/task@2", id: "T-26-BBBBBB", project: project.document.id, milestone: stage.document.id, title: "Task B", type: "task", status: "backlog", lifecycle: "active" });
    const taskC = result({ schema: "gitpm/task@2", id: "T-26-CCCCCC", project: project.document.id, milestone: stage.document.id, title: "Task C", type: "task", status: "backlog", lifecycle: "active" });
    const orderedStage = result({ ...stage.document, task_order: [taskA.document.id, taskB.document.id, taskC.document.id] });
    const client = api([taskA, taskB, taskC], [orderedStage, laterStage]);
    render(<ProjectPlanWorkspace api={client} draft={draft} locale="en" onChanged={vi.fn(async () => undefined)} onNavigate={vi.fn()} projectId={project.document.id} />);

    await screen.findByRole("heading", { name: "Launch" });
    expect(Array.from(document.querySelectorAll(".project-plan-task-row strong"), (element) => element.textContent)).toEqual(["Task A", "Task B", "Task C"]);

    const aRow = screen.getByText("Task A").closest(".project-plan-task-row") as HTMLElement;
    const aHandle = aRow.nextElementSibling as HTMLElement;
    fireEvent.click(within(aHandle).getByRole("button", { name: "Insert task" }));
    fireEvent.click(within(aHandle).getByRole("menuitem", { name: /Task between .*Task A.* and .*Task B/u }));

    const dialog = screen.getByRole("dialog", { name: "New task" });
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Inserted task" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create task" }));

    await waitFor(() => expect(client.createEntity).toHaveBeenCalled());
    const createdId = client.createEntity.mock.calls[0]?.[3].id as string;
    expect(client.createEntity.mock.calls[0]?.[3]).toMatchObject({ project: project.document.id, milestone: stage.document.id, title: "Inserted task" });
    expect(client.createEntity.mock.calls[0]?.[3]).not.toHaveProperty("parent");

    await waitFor(() => expect(client.updateEntity).toHaveBeenCalled());
    const milestoneUpdate = client.updateEntity.mock.calls.find((call) => call[1] === "milestones");
    expect(milestoneUpdate?.[4]).toMatchObject({ id: stage.document.id, task_order: [taskA.document.id, createdId, taskB.document.id, taskC.document.id] });
  });

  it("creates a task in the selected milestone context through the project workspace", async () => {
    const client = api();
    render(<ProjectPlanWorkspace api={client} draft={draft} locale="en" onChanged={vi.fn(async () => undefined)} onNavigate={vi.fn()} projectId={project.document.id} selectedStageId={stage.document.id} />);

    const inspector = await screen.findByRole("complementary", { name: "Milestone" });
    expect(inspector.textContent).toContain("Launch");
    expect(document.querySelector(".project-plan-stage-assignees")?.textContent).toContain("Ada");
    expect(screen.getByText("Linked task").closest(".project-plan-task-row")?.textContent).toContain("Ada");

    fireEvent.click(within(inspector).getByRole("button", { name: /New task/u }));
    const dialog = screen.getByRole("dialog", { name: "New task" });
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Created here" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(client.createEntity).toHaveBeenCalled());
    expect(client.createEntity.mock.calls[0]?.[3]).toMatchObject({ project: project.document.id, milestone: stage.document.id, title: "Created here" });
  });

  it("renders interactive summary metrics with counts from status categories", async () => {
    vi.useFakeTimers({ now: new Date("2026-07-20T12:00:00Z"), toFake: ["Date"] });
    const client = api(summaryTasksFixture(), [summaryStage], summaryProject);
    useSummaryStatusConfig(client);
    render(<ProjectPlanWorkspace api={client} draft={draft} locale="en" onChanged={vi.fn(async () => undefined)} onNavigate={vi.fn()} projectId={summaryProject.document.id} />);

    await screen.findByRole("heading", { name: "Summary project" });
    expect(screen.getByRole("button", { name: "Total tasks: 3" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Completed: 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "In progress: 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Blocked: 0" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Overdue: 1" })).toBeTruthy();
  });

  it("orders the summary metrics Total, In progress, Blocked, Overdue, Completed", async () => {
    const client = api(summaryTasksFixture(), [summaryStage], summaryProject);
    useSummaryStatusConfig(client);
    render(<ProjectPlanWorkspace api={client} draft={draft} locale="en" onChanged={vi.fn(async () => undefined)} onNavigate={vi.fn()} projectId={summaryProject.document.id} />);

    await screen.findByRole("heading", { name: "Summary project" });
    const group = screen.getByRole("group", { name: "Summary and quick task filters" });
    const labels = Array.from(group.querySelectorAll("button.project-plan-summary-metric > span"), (element) => element.textContent);
    expect(labels).toEqual(["Total tasks", "In progress", "Blocked", "Overdue", "Completed"]);
  });

  it("hides milestones without matching tasks under a summary filter and restores them on toggle", async () => {
    vi.useFakeTimers({ now: new Date("2026-07-20T12:00:00Z"), toFake: ["Date"] });
    const stageA = result({ schema: "gitpm/milestone@2", id: "M-26-A", project: summaryProject.document.id, name: "Stage A", lifecycle: "active" });
    const stageB = result({ schema: "gitpm/milestone@2", id: "M-26-B", project: summaryProject.document.id, name: "Stage B", lifecycle: "active" });
    const tasks = [
      result({ schema: "gitpm/task@2", id: "T-A-DONE", project: summaryProject.document.id, milestone: stageA.document.id, title: "A done", type: "task", status: "done", lifecycle: "active" }),
      result({ schema: "gitpm/task@2", id: "T-B-ACT", project: summaryProject.document.id, milestone: stageB.document.id, title: "B active", type: "task", status: "in-progress", lifecycle: "active", schedules: { plan: { finish: "2026-12-01" } } }),
    ];
    const client = api(tasks, [stageA, stageB], summaryProject);
    useSummaryStatusConfig(client);
    render(<ProjectPlanWorkspace api={client} draft={draft} locale="en" onChanged={vi.fn(async () => undefined)} onNavigate={vi.fn()} projectId={summaryProject.document.id} />);

    await screen.findByRole("heading", { name: "Summary project" });
    expect(screen.getByRole("heading", { name: "Stage A" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Stage B" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "In progress: 1" }));
    expect(screen.queryByRole("heading", { name: "Stage A" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Stage B" })).toBeTruthy();
    expect(screen.getByText("B active")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "In progress: 1" }));
    expect(screen.getByRole("heading", { name: "Stage A" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Stage B" })).toBeTruthy();
  });

  it("shows an empty state when the active summary filter matches no tasks", async () => {
    vi.useFakeTimers({ now: new Date("2026-07-20T12:00:00Z"), toFake: ["Date"] });
    const stageA = result({ schema: "gitpm/milestone@2", id: "M-26-A", project: summaryProject.document.id, name: "Stage A", lifecycle: "active" });
    const tasks = [
      result({ schema: "gitpm/task@2", id: "T-A-DONE", project: summaryProject.document.id, milestone: stageA.document.id, title: "A done", type: "task", status: "done", lifecycle: "active" }),
    ];
    const client = api(tasks, [stageA], summaryProject);
    useSummaryStatusConfig(client);
    render(<ProjectPlanWorkspace api={client} draft={draft} locale="en" onChanged={vi.fn(async () => undefined)} onNavigate={vi.fn()} projectId={summaryProject.document.id} />);

    await screen.findByRole("heading", { name: "Summary project" });
    fireEvent.click(screen.getByRole("button", { name: "In progress: 0" }));
    expect(screen.getByText("No tasks match the active filters.")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Stage A" })).toBeNull();
  });

  it("scopes summary counts to the selected milestone and keeps them independent of the status filter", async () => {
    vi.useFakeTimers({ now: new Date("2026-07-20T12:00:00Z"), toFake: ["Date"] });
    const stageA = result({ schema: "gitpm/milestone@2", id: "M-26-A", project: summaryProject.document.id, name: "Stage A", lifecycle: "active" });
    const stageB = result({ schema: "gitpm/milestone@2", id: "M-26-B", project: summaryProject.document.id, name: "Stage B", lifecycle: "active" });
    const tasks = [
      result({ schema: "gitpm/task@2", id: "T-A-DONE", project: summaryProject.document.id, milestone: stageA.document.id, title: "A done", type: "task", status: "done", lifecycle: "active" }),
      result({ schema: "gitpm/task@2", id: "T-A-ACT", project: summaryProject.document.id, milestone: stageA.document.id, title: "A active", type: "task", status: "in-progress", lifecycle: "active" }),
      result({ schema: "gitpm/task@2", id: "T-B-DONE", project: summaryProject.document.id, milestone: stageB.document.id, title: "B done", type: "task", status: "done", lifecycle: "active" }),
    ];
    const client = api(tasks, [stageA, stageB], summaryProject);
    useSummaryStatusConfig(client);
    render(<ProjectPlanWorkspace api={client} draft={draft} locale="en" onChanged={vi.fn(async () => undefined)} onNavigate={vi.fn()} projectId={summaryProject.document.id} />);

    await screen.findByRole("heading", { name: "Summary project" });
    expect(screen.getByRole("button", { name: "Total tasks: 3" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Completed: 2" })).toBeTruthy();
    // Narrowing to Stage A keeps 2 tasks (1 done, 1 active); the quick metrics must follow.
    fireEvent.change(screen.getByRole("combobox", { name: "Milestone" }), { target: { value: stageA.document.id } });
    expect(screen.getByRole("button", { name: "Total tasks: 2" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Completed: 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "In progress: 1" })).toBeTruthy();
    // Selecting a concrete status does NOT change the quick metric numbers.
    fireEvent.change(screen.getByRole("combobox", { name: "Filter tasks" }), { target: { value: "done" } });
    expect(screen.getByRole("button", { name: "Completed: 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Total tasks: 2" })).toBeTruthy();
  });

  it("treats the legacy in-progress summary query value as active", async () => {
    const client = api(summaryTasksFixture(), [summaryStage], summaryProject);
    useSummaryStatusConfig(client);
    render(<ProjectPlanWorkspace api={client} draft={draft} initialSummaryFilter="in-progress" locale="en" onChanged={vi.fn(async () => undefined)} onNavigate={vi.fn()} projectId={summaryProject.document.id} />);

    await screen.findByRole("heading", { name: "Summary project" });
    expect(screen.getByRole("button", { name: "In progress: 1" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("bases overdue on the effective finish roll-up and excludes done and undated tasks", async () => {
    vi.useFakeTimers({ now: new Date("2026-07-20T12:00:00Z"), toFake: ["Date"] });
    const rollupParent = result({ schema: "gitpm/task@2", id: "T-26-PAR", project: summaryProject.document.id, milestone: summaryStage.document.id, title: "Rollup parent", type: "task", status: "backlog", lifecycle: "active" });
    const rollupChild = result({ schema: "gitpm/task@2", id: "T-26-CHL", project: summaryProject.document.id, milestone: summaryStage.document.id, parent: rollupParent.document.id, title: "Rollup child", type: "task", status: "done", lifecycle: "active", schedules: { plan: { finish: "2026-07-10" } } });
    const donePast = result({ schema: "gitpm/task@2", id: "T-26-DP", project: summaryProject.document.id, milestone: summaryStage.document.id, title: "Done past", type: "task", status: "done", lifecycle: "active", schedules: { plan: { finish: "2026-07-05" } } });
    const undated = result({ schema: "gitpm/task@2", id: "T-26-UN", project: summaryProject.document.id, milestone: summaryStage.document.id, title: "Undated task", type: "task", status: "backlog", lifecycle: "active" });
    const client = api([rollupParent, rollupChild, donePast, undated], [summaryStage], summaryProject);
    useSummaryStatusConfig(client);
    render(<ProjectPlanWorkspace api={client} draft={draft} locale="en" onChanged={vi.fn(async () => undefined)} onNavigate={vi.fn()} projectId={summaryProject.document.id} />);

    await screen.findByRole("heading", { name: "Summary project" });
    expect(screen.getByRole("button", { name: "Overdue: 1" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Overdue: 1" }));
    expect(screen.getByText("Rollup parent")).toBeTruthy();
    expect(screen.queryByText("Done past")).toBeNull();
    expect(screen.queryByText("Undated task")).toBeNull();
    expect(screen.queryByText("Rollup child")).toBeNull();
  });

  it("clicking the Completed metric narrows the list and toggling back restores it", async () => {
    const client = api(summaryTasksFixture(), [summaryStage], summaryProject);
    useSummaryStatusConfig(client);
    render(<ProjectPlanWorkspace api={client} draft={draft} locale="en" onChanged={vi.fn(async () => undefined)} onNavigate={vi.fn()} projectId={summaryProject.document.id} />);

    await screen.findByRole("heading", { name: "Summary project" });
    expect(screen.getByText("Done task")).toBeTruthy();
    expect(screen.getByText("Active task")).toBeTruthy();
    expect(screen.getByText("Overdue task")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Completed: 1" }));
    expect(screen.getByText("Done task")).toBeTruthy();
    expect(screen.queryByText("Active task")).toBeNull();
    expect(screen.queryByText("Overdue task")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Completed: 1" }));
    expect(screen.getByText("Active task")).toBeTruthy();
    expect(screen.getByText("Overdue task")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Completed: 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Total tasks: 3" }));
    expect(screen.getByText("Active task")).toBeTruthy();
    expect(screen.getByText("Overdue task")).toBeTruthy();
  });

  it("renders the task estimate meta through the localized hours formatter", async () => {
    const client = api();
    render(<ProjectPlanWorkspace api={client} draft={draft} locale="en" onChanged={vi.fn(async () => undefined)} onNavigate={vi.fn()} projectId={project.document.id} />);
    await screen.findByRole("heading", { name: "Alpha" });
    const alphaRow = screen.getByText("Alpha task").closest(".project-plan-task-row") as HTMLElement;
    expect(alphaRow.textContent).toContain("13 hours");
    expect(alphaRow.textContent).not.toMatch(/\d+h/u);
  });

  it("counts blocked tasks separately from in-progress tasks and the quick filter narrows to them", async () => {
    const stageM = result({ schema: "gitpm/milestone@2", id: "M-26-BLK", project: summaryProject.document.id, name: "Blocked stage", lifecycle: "active" });
    const tasks = [
      result({ schema: "gitpm/task@2", id: "T-ACT", project: summaryProject.document.id, milestone: stageM.document.id, title: "Active task", type: "task", status: "in-progress", lifecycle: "active", schedules: { plan: { finish: "2026-12-01" } } }),
      result({ schema: "gitpm/task@2", id: "T-BLK", project: summaryProject.document.id, milestone: stageM.document.id, title: "Blocked task", type: "task", status: "blocked", lifecycle: "active", schedules: { plan: { finish: "2026-12-01" } } }),
    ];
    const client = api(tasks, [stageM], summaryProject);
    useBlockedStatusConfig(client);
    render(<ProjectPlanWorkspace api={client} draft={draft} locale="en" onChanged={vi.fn(async () => undefined)} onNavigate={vi.fn()} projectId={summaryProject.document.id} />);

    await screen.findByRole("heading", { name: "Summary project" });
    expect(screen.getByRole("button", { name: "In progress: 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Blocked: 1" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Blocked: 1" }));
    expect(screen.getByText("Blocked task")).toBeTruthy();
    expect(screen.queryByText("Active task")).toBeNull();
  });

  it("orders unordered plan tasks by the shared canonical tie-break (title, then id)", async () => {
    const stageNoOrder = result({ schema: "gitpm/milestone@2", id: "M-26-NOORDER", project: project.document.id, name: "Unordered", lifecycle: "active" });
    const apple = result({ schema: "gitpm/task@2", id: "T-26-APPLE", project: project.document.id, milestone: stageNoOrder.document.id, title: "Apple task", type: "task", status: "backlog", lifecycle: "active", schedules: { plan: { finish: "2026-07-01" } } });
    const cherry = result({ schema: "gitpm/task@2", id: "T-26-CHERRY", project: project.document.id, milestone: stageNoOrder.document.id, title: "Cherry task", type: "task", status: "backlog", lifecycle: "active", schedules: { plan: { finish: "2026-08-01" } } });
    const banana = result({ schema: "gitpm/task@2", id: "T-26-BANANA", project: project.document.id, milestone: stageNoOrder.document.id, title: "Banana task", type: "task", status: "done", lifecycle: "active", schedules: { plan: { finish: "2026-09-01" } } });
    const client = api([cherry, banana, apple], [stageNoOrder, laterStage]);
    render(<ProjectPlanWorkspace api={client} draft={draft} locale="en" onChanged={vi.fn(async () => undefined)} onNavigate={vi.fn()} projectId={project.document.id} />);
    const card = (await screen.findByRole("heading", { name: "Unordered" })).closest<HTMLElement>("article")!;
    expect(Array.from(card.querySelectorAll(".project-plan-task-row strong"), (element) => element.textContent))
      .toEqual(["Apple task", "Banana task", "Cherry task"]);
  });

  it("groups every task without an active milestone into one system group whose count matches the list", async () => {
    const archivedStage = result({ schema: "gitpm/milestone@2", id: "M-26-ARCH", project: project.document.id, name: "Archived stage", lifecycle: "archived" });
    const noField = result({ schema: "gitpm/task@2", id: "T-26-NOFIELD", project: project.document.id, title: "No milestone field", type: "task", status: "backlog", lifecycle: "active" });
    const empty = result({ schema: "gitpm/task@2", id: "T-26-EMPTY", project: project.document.id, milestone: "", title: "Empty milestone", type: "task", status: "backlog", lifecycle: "active" });
    const unknown = result({ schema: "gitpm/task@2", id: "T-26-UNKNOWN", project: project.document.id, milestone: "M-26-MISSING", title: "Unknown milestone", type: "task", status: "backlog", lifecycle: "active" });
    const archivedMilestoneTask = result({ schema: "gitpm/task@2", id: "T-26-ARCHTASK", project: project.document.id, milestone: archivedStage.document.id, title: "Archived milestone task", type: "task", status: "backlog", lifecycle: "active" });
    const activeMilestoneTask = result({ schema: "gitpm/task@2", id: "T-26-ACTIVE", project: project.document.id, milestone: stage.document.id, title: "Active milestone task", type: "task", status: "backlog", lifecycle: "active" });
    const client = api([noField, empty, unknown, archivedMilestoneTask, activeMilestoneTask], [stage, archivedStage, laterStage]);
    render(<ProjectPlanWorkspace api={client} draft={draft} locale="en" onChanged={vi.fn(async () => undefined)} onNavigate={vi.fn()} projectId={project.document.id} />);

    await screen.findByRole("heading", { name: "Alpha" });
    expect(screen.getByRole("button", { name: /Outside active milestones: 4/u })).toBeTruthy();
    const orphanSection = document.querySelector(".project-plan-unassigned") as HTMLElement;
    expect(orphanSection).not.toBeNull();
    const orphanTitles = Array.from(orphanSection.querySelectorAll(".project-plan-task-row strong"), (element) => element?.textContent ?? "");
    expect(orphanTitles).toEqual(["Archived milestone task", "Empty milestone", "No milestone field", "Unknown milestone"]);
    expect(orphanTitles).not.toContain("Active milestone task");
    expect(screen.getByText("Active milestone task").closest(".project-plan-stage")?.classList.contains("project-plan-unassigned")).toBe(false);
  });

  it("does not list archived tasks in the current plan", async () => {
    const ghost = result({ schema: "gitpm/task@2", id: "T-26-GHOST", project: project.document.id, milestone: stage.document.id, title: "Ghost task", type: "task", status: "backlog", lifecycle: "archived" });
    const client = api([ghost, linked], [stage, laterStage]);
    render(<ProjectPlanWorkspace api={client} draft={draft} locale="en" onChanged={vi.fn(async () => undefined)} onNavigate={vi.fn()} projectId={project.document.id} />);
    await screen.findByRole("heading", { name: "Alpha" });
    expect(screen.queryByText("Ghost task")).toBeNull();
    expect(screen.getByText("Linked task")).toBeTruthy();
  });

  it("selecting a specific status resets the summary filter to all", async () => {
    const client = api(summaryTasksFixture(), [summaryStage], summaryProject);
    useSummaryStatusConfig(client);
    render(<ProjectPlanWorkspace api={client} draft={draft} locale="en" onChanged={vi.fn(async () => undefined)} onNavigate={vi.fn()} projectId={summaryProject.document.id} />);

    await screen.findByRole("heading", { name: "Summary project" });
    fireEvent.click(screen.getByRole("button", { name: "Completed: 1" }));
    expect(screen.getByRole("button", { name: "Completed: 1" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.change(screen.getByRole("combobox", { name: "Filter tasks" }), { target: { value: "done" } });
    expect(screen.getByRole("button", { name: "Completed: 1" }).getAttribute("aria-pressed")).toBe("false");
    // Total is only pressed when no quick filter AND no specific status are active.
    expect(screen.getByRole("button", { name: "Total tasks: 3" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("renders removable chips for each active filter and Reset clears them all", async () => {
    const client = api(summaryTasksFixture(), [summaryStage], summaryProject);
    useSummaryStatusConfig(client);
    render(<ProjectPlanWorkspace api={client} draft={draft} locale="en" onChanged={vi.fn(async () => undefined)} onNavigate={vi.fn()} projectId={summaryProject.document.id} />);

    await screen.findByRole("heading", { name: "Summary project" });
    expect(screen.queryByText("All tasks")).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "Milestone" }), { target: { value: summaryStage.document.id } });
    fireEvent.change(screen.getByRole("combobox", { name: "Filter tasks" }), { target: { value: "done" } });
    const statusChip = screen.getByRole("button", { name: "Remove filter: Done" });
    const milestoneChip = screen.getByRole("button", { name: "Remove filter: Summary stage" });
    expect(statusChip).toBeTruthy();
    expect(milestoneChip).toBeTruthy();
    fireEvent.click(statusChip);
    expect(screen.queryByRole("button", { name: "Remove filter: Done" })).toBeNull();
    expect(screen.getByRole("button", { name: "Remove filter: Summary stage" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(screen.queryByRole("button", { name: "Remove filter: Summary stage" })).toBeNull();
    expect(screen.queryByText("All tasks")).toBeNull();
  });

  it("syncs the summary filter into the navigation query", async () => {
    const client = api();
    const onNavigate = vi.fn();
    render(<ProjectPlanWorkspace api={client} draft={draft} locale="en" onChanged={vi.fn(async () => undefined)} onNavigate={onNavigate} projectId={project.document.id} />);

    await screen.findByRole("heading", { name: "Alpha" });
    fireEvent.click(screen.getByRole("button", { name: "Completed: 1" }));
    expect(onNavigate).toHaveBeenLastCalledWith("projects", { projectId: project.document.id, query: { summary: ["completed"] } });
    fireEvent.click(screen.getByRole("button", { name: "Completed: 1" }));
    expect(onNavigate).toHaveBeenLastCalledWith("projects", { projectId: project.document.id });
  });
});
