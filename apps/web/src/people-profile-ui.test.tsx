// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type GitPmApi } from "./api.js";
import { PeopleProfileWorkspace } from "./people-profile-ui.js";
import type { DraftStatus, EntityDocument, EntityResult } from "./types.js";

const draft: DraftStatus = { draft_id: "DRF-PEOPLE", owner_gitlab_user_id: "42", branch: "gitpm/42/DRF-PEOPLE", base_commit: "a".repeat(40), writer_mode: "ui", state: "open", fingerprint: "b".repeat(64), created_at: "2026-07-10T00:00:00.000Z", updated_at: "2026-07-10T00:00:00.000Z" };
const result = (document: EntityDocument): EntityResult => ({ document, path: `${document.id}.yaml`, blob_id: "a".repeat(40), draft_fingerprint: "b".repeat(64) });
const statusesConfig = (slugs: readonly { slug: string; title: string }[] = [
  { slug: "backlog", title: "Backlog" },
  { slug: "planned", title: "Planned" },
  { slug: "in-progress", title: "In Progress" },
  { slug: "review", title: "Review" },
  { slug: "blocked", title: "Blocked" },
  { slug: "done", title: "Done" },
]) => ({ document: { schema: "gitpm/statuses@2", id: "statuses", lifecycle: "active", statuses: slugs.map((status) => ({ ...status, active: true, color: "gray" })) }, path: ".gitpm/statuses.yaml", blob_id: "a".repeat(40), draft_fingerprint: "b".repeat(64) });
const tracksConfig = () => ({ document: { schema: "gitpm/schedule-tracks@1", tracks: [{ slug: "plan", title: "Plan", kind: "manual", capabilities: ["dates", "effort", "dependencies"] }], defaults: { enabled_tracks: ["plan"], primary_track: "plan", workload_track: "plan", dashboard_tracks: ["plan"] } }, path: ".gitpm/schedule-tracks.yaml", blob_id: "a".repeat(40), draft_fingerprint: "b".repeat(64) });

afterEach(() => { cleanup(); localStorage.clear(); });

describe("person profile", () => {
  it("shows a person's tasks, dated schedule, calendar, teams and projects with navigation", async () => {
    const personId = "U-26-ADA";
    const projectId = "P-26-ALPHA";
    const contributingProjectId = "P-26-BETA";
    const taskId = "T-26-FIRST";
    const entities = [
      result({ schema: "gitpm/person@1", id: personId, name: "Ada Lovelace", email: "ada@example.test", weekly_capacity_hours: 32, calendar: "C-26-DEFAULT", lifecycle: "active" }),
      result({ schema: "gitpm/calendar@1", id: "C-26-DEFAULT", name: "Default", working_weekdays: [1, 2, 3, 4, 5], holidays: ["2026-08-03"], lifecycle: "active" }),
      result({ schema: "gitpm/team@1", id: "TEAM-26-CORE", name: "Core", members: [personId], lifecycle: "active" }),
      result({ schema: "gitpm/project@2", id: projectId, name: "Alpha", owner: personId, status: "in-progress", lifecycle: "active" }),
      result({ schema: "gitpm/project@2", id: contributingProjectId, name: "Beta", owner: "U-26-GRACE", status: "planned", lifecycle: "active" }),
      result({ schema: "gitpm/task@2", id: taskId, project: projectId, title: "Ship profile", status: "in-progress", assignees: [personId], schedules: { plan: { start: "2026-07-20", finish: "2026-07-24" } }, lifecycle: "active" }),
      result({ schema: "gitpm/task@2", id: "T-26-SECOND", project: contributingProjectId, title: "Review calendar", status: "planned", assignees: [personId], schedules: { plan: { start: "2026-07-22", finish: "2026-07-23" } }, lifecycle: "active" }),
    ];
    const schemaByType: Record<string, string> = { people: "gitpm/person@1", calendars: "gitpm/calendar@1", teams: "gitpm/team@1", projects: "gitpm/project@2", tasks: "gitpm/task@2" };
    const api = { listEntities: vi.fn(async (_draftId: string, type: string) => entities.filter((item) => item.document.schema === schemaByType[type])), getConfiguration: vi.fn(async (_draftId: string, kind: string) => kind === "schedule-tracks" ? tracksConfig() : statusesConfig()) } as unknown as GitPmApi;
    const onNavigate = vi.fn();

    render(<PeopleProfileWorkspace api={api} draft={draft} locale="en" onNavigate={onNavigate} personId={personId} />);

    expect(await screen.findByRole("heading", { name: "Ada Lovelace" })).toBeTruthy();
    expect(screen.getByText("32 h/week")).toBeTruthy();
    expect(screen.getByText("Core")).toBeTruthy();
    expect(screen.getByText("Jul 20, 2026 — Jul 24, 2026")).toBeTruthy();
    expect(screen.getByLabelText("Working week preview").querySelectorAll(".working")).toHaveLength(5);
    const overlapDay = document.querySelector<HTMLElement>('[data-date="2026-07-22"]')!;
    expect(overlapDay.className).toContain("overlap");
    expect(within(overlapDay).getByText("Ship profile")).toBeTruthy();
    expect(within(overlapDay).getByText("Review calendar")).toBeTruthy();
    expect(document.querySelector<HTMLElement>('[data-date="2026-07-27"]')?.className).toContain("free");
    const tasks = screen.getByRole("heading", { name: "Tasks by project" }).closest("section")!;
    expect(within(tasks).getByRole("button", { name: /Alpha.*Project owner/u })).toBeTruthy();
    expect(within(tasks).getByRole("button", { name: /Beta.*Contributor/u })).toBeTruthy();
    fireEvent.click(within(tasks).getByRole("button", { name: /Ship profile/u }));
    expect(onNavigate).toHaveBeenCalledWith("tasks", { projectId, taskId });
    const projects = screen.getByRole("heading", { name: "Responsible for" }).closest("section")!;
    fireEvent.click(within(projects).getByRole("button", { name: /Alpha/u }));
    expect(onNavigate).toHaveBeenCalledWith("projects", { projectId });
    const participating = screen.getByRole("heading", { name: "Participates in" }).closest("section")!;
    expect(within(participating).getByRole("button", { name: /Alpha/u })).toBeTruthy();
    expect(within(participating).getByRole("button", { name: /Beta/u })).toBeTruthy();
  });

  it("hides done tasks by default, translates status titles, and keeps counts in sync", async () => {
    const personId = "U-26-ADA";
    const projectId = "P-26-ALPHA";
    const entities = [
      result({ schema: "gitpm/person@1", id: personId, name: "Ada Lovelace", weekly_capacity_hours: 32, lifecycle: "active" }),
      result({ schema: "gitpm/project@2", id: projectId, name: "Alpha", owner: personId, status: "in-progress", lifecycle: "active" }),
      result({ schema: "gitpm/task@2", id: "T-OPEN", project: projectId, title: "Open work", status: "in-progress", assignees: [personId], lifecycle: "active" }),
      result({ schema: "gitpm/task@2", id: "T-DONE", project: projectId, title: "Finished work", status: "done", assignees: [personId], lifecycle: "active" }),
    ];
    const schemaByType: Record<string, string> = { people: "gitpm/person@1", calendars: "gitpm/calendar@1", teams: "gitpm/team@1", projects: "gitpm/project@2", tasks: "gitpm/task@2" };
    const api = { listEntities: vi.fn(async (_draftId: string, type: string) => entities.filter((item) => item.document.schema === schemaByType[type])), getConfiguration: vi.fn(async (_draftId: string, kind: string) => kind === "schedule-tracks" ? tracksConfig() : statusesConfig()) } as unknown as GitPmApi;

    render(<PeopleProfileWorkspace api={api} draft={draft} locale="en" onNavigate={vi.fn()} personId={personId} />);

    const tasks = (await screen.findByRole("heading", { name: "Tasks by project" })).closest("section")!;
    expect(within(tasks).getByText("Shown: 1 of 2")).toBeTruthy();
    expect(within(tasks).getByRole("button", { name: /Open work/u })).toBeTruthy();
    expect(within(tasks).queryByRole("button", { name: /Finished work/u })).toBeNull();
    expect(within(tasks).queryByText(/^in-progress$/u)).toBeNull();
    expect(within(tasks).queryByText(/^done$/u)).toBeNull();
    expect(within(tasks).getAllByText("In Progress").length).toBeGreaterThan(0);
    const doneCheckbox = within(tasks).getByRole("checkbox", { name: "Done" }) as HTMLInputElement;
    const openCheckbox = within(tasks).getByRole("checkbox", { name: "In Progress" }) as HTMLInputElement;
    expect(doneCheckbox.checked).toBe(false);
    expect(openCheckbox.checked).toBe(true);
  });

  it("toggles status and project checkboxes, persists them per person, and restores on next mount", async () => {
    const personId = "U-26-ADA";
    const projectId = "P-26-ALPHA";
    const contributingProjectId = "P-26-BETA";
    const entities = [
      result({ schema: "gitpm/person@1", id: personId, name: "Ada Lovelace", weekly_capacity_hours: 32, lifecycle: "active" }),
      result({ schema: "gitpm/project@2", id: projectId, name: "Alpha", owner: personId, status: "in-progress", lifecycle: "active" }),
      result({ schema: "gitpm/project@2", id: contributingProjectId, name: "Beta", owner: "U-26-GRACE", status: "planned", lifecycle: "active" }),
      result({ schema: "gitpm/task@2", id: "T-ALPHA-OPEN", project: projectId, title: "Alpha open", status: "in-progress", assignees: [personId], lifecycle: "active" }),
      result({ schema: "gitpm/task@2", id: "T-ALPHA-DONE", project: projectId, title: "Alpha done", status: "done", assignees: [personId], lifecycle: "active" }),
      result({ schema: "gitpm/task@2", id: "T-BETA-PLANNED", project: contributingProjectId, title: "Beta planned", status: "planned", assignees: [personId], lifecycle: "active" }),
    ];
    const schemaByType: Record<string, string> = { people: "gitpm/person@1", calendars: "gitpm/calendar@1", teams: "gitpm/team@1", projects: "gitpm/project@2", tasks: "gitpm/task@2" };
    const buildApi = () => ({ listEntities: vi.fn(async (_draftId: string, type: string) => entities.filter((item) => item.document.schema === schemaByType[type])), getConfiguration: vi.fn(async (_draftId: string, kind: string) => kind === "schedule-tracks" ? tracksConfig() : statusesConfig()) } as unknown as GitPmApi);

    const { unmount } = render(<PeopleProfileWorkspace api={buildApi()} draft={draft} locale="en" onNavigate={vi.fn()} personId={personId} />);
    const tasks = (await screen.findByRole("heading", { name: "Tasks by project" })).closest("section")!;
    expect(within(tasks).getByText("Shown: 2 of 3")).toBeTruthy();

    fireEvent.click(within(tasks).getByRole("checkbox", { name: "Done" }));
    expect(await within(tasks).findByText("Shown: 3 of 3")).toBeTruthy();
    expect(within(tasks).getByRole("button", { name: /Alpha done/u })).toBeTruthy();

    fireEvent.click(within(tasks).getByRole("checkbox", { name: "Beta" }));
    expect(within(tasks).getByText("Shown: 2 of 3")).toBeTruthy();
    expect(within(tasks).queryByRole("button", { name: /Beta planned/u })).toBeNull();

    expect(JSON.parse(localStorage.getItem("gitpm.peopleProfile.taskFilters") ?? "{}")).toEqual({
      [personId]: { statuses: expect.arrayContaining(["backlog", "planned", "in-progress", "review", "blocked", "done"]), projects: [projectId] },
    });
    unmount();

    render(<PeopleProfileWorkspace api={buildApi()} draft={draft} locale="en" onNavigate={vi.fn()} personId={personId} />);
    const restoredTasks = (await screen.findByRole("heading", { name: "Tasks by project" })).closest("section")!;
    expect(within(restoredTasks).getByText("Shown: 2 of 3")).toBeTruthy();
    expect((within(restoredTasks).getByRole("checkbox", { name: "Done" }) as HTMLInputElement).checked).toBe(true);
    expect((within(restoredTasks).getByRole("checkbox", { name: "Beta" }) as HTMLInputElement).checked).toBe(false);
    expect(within(restoredTasks).queryByRole("button", { name: /Beta planned/u })).toBeNull();
  });

  it("resets filters back to the default hide-done state", async () => {
    const personId = "U-26-ADA";
    const projectId = "P-26-ALPHA";
    const entities = [
      result({ schema: "gitpm/person@1", id: personId, name: "Ada Lovelace", weekly_capacity_hours: 32, lifecycle: "active" }),
      result({ schema: "gitpm/project@2", id: projectId, name: "Alpha", owner: personId, status: "in-progress", lifecycle: "active" }),
      result({ schema: "gitpm/task@2", id: "T-1", project: projectId, title: "Open work", status: "in-progress", assignees: [personId], lifecycle: "active" }),
      result({ schema: "gitpm/task@2", id: "T-2", project: projectId, title: "Finished work", status: "done", assignees: [personId], lifecycle: "active" }),
    ];
    const schemaByType: Record<string, string> = { people: "gitpm/person@1", calendars: "gitpm/calendar@1", teams: "gitpm/team@1", projects: "gitpm/project@2", tasks: "gitpm/task@2" };
    const api = { listEntities: vi.fn(async (_draftId: string, type: string) => entities.filter((item) => item.document.schema === schemaByType[type])), getConfiguration: vi.fn(async (_draftId: string, kind: string) => kind === "schedule-tracks" ? tracksConfig() : statusesConfig()) } as unknown as GitPmApi;

    render(<PeopleProfileWorkspace api={api} draft={draft} locale="en" onNavigate={vi.fn()} personId={personId} />);
    const tasks = (await screen.findByRole("heading", { name: "Tasks by project" })).closest("section")!;
    fireEvent.click(within(tasks).getByRole("checkbox", { name: "In Progress" }));
    const emptyState = within(tasks).getByText(/No tasks match the active filters/u).closest("p")!;
    fireEvent.click(within(emptyState).getByRole("button", { name: "Reset filters" }));
    expect(await within(tasks).findByRole("button", { name: /Open work/u })).toBeTruthy();
    expect((within(tasks).getByRole("checkbox", { name: "In Progress" }) as HTMLInputElement).checked).toBe(true);
    expect((within(tasks).getByRole("checkbox", { name: "Done" }) as HTMLInputElement).checked).toBe(false);
  });

  it("edits a person only from the profile and keeps the latest draft fingerprint", async () => {
    const personId = "U-26-ADA";
    const calendar = result({ schema: "gitpm/calendar@1", id: "C-26-DEFAULT", name: "Default", working_weekdays: [1, 2, 3, 4, 5], holidays: [], lifecycle: "active" });
    let person = result({ schema: "gitpm/person@1", id: personId, name: "Ada", email: "ada@example.test", weekly_capacity_hours: 32, calendar: calendar.document.id, lifecycle: "active" });
    let revision = 0;
    const schemaByType: Record<string, string> = { people: "gitpm/person@1", calendars: "gitpm/calendar@1", teams: "gitpm/team@1", projects: "gitpm/project@2", tasks: "gitpm/task@2" };
    const updateEntity = vi.fn(async (_draftId: string, _type: string, _entity: EntityResult, _fingerprint: string, document: EntityDocument) => {
      revision += 1;
      person = { ...result(document), draft_fingerprint: (revision === 1 ? "c" : "d").repeat(64) };
      return person;
    });
    const api = {
      listEntities: vi.fn(async (_draftId: string, type: string) => [person, calendar].filter((item) => item.document.schema === schemaByType[type])),
      getConfiguration: vi.fn(async (_draftId: string, kind: string) => kind === "schedule-tracks" ? tracksConfig() : statusesConfig()),
      updateEntity,
    } as unknown as GitPmApi;
    const onChanged = vi.fn(async () => undefined);

    render(<PeopleProfileWorkspace api={api} draft={draft} locale="en" onChanged={onChanged} onNavigate={vi.fn()} personId={personId} role="Maintainer" />);

    fireEvent.click(await screen.findByRole("button", { name: "Edit person" }));
    const dialog = screen.getByRole("dialog", { name: "Edit person: Ada" });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Ada Byron" } });
    fireEvent.change(within(dialog).getByLabelText("Weekly capacity (hours)"), { target: { value: "36" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("heading", { name: "Ada Byron" })).toBeTruthy();
    expect(updateEntity).toHaveBeenCalledWith(draft.draft_id, "people", expect.objectContaining({ document: expect.objectContaining({ name: "Ada" }) }), "b".repeat(64), expect.objectContaining({ name: "Ada Byron", weekly_capacity_hours: 36 }));
    expect(onChanged).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Edit person" }));
    const updatedDialog = screen.getByRole("dialog", { name: "Edit person: Ada Byron" });
    fireEvent.change(within(updatedDialog).getByLabelText("Weekly capacity (hours)"), { target: { value: "38" } });
    fireEvent.click(within(updatedDialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateEntity).toHaveBeenCalledTimes(2));
    expect(updateEntity.mock.calls[1]?.[3]).toBe("c".repeat(64));
  });

  it("protects permanent deletion in the profile and redirects after confirmation", async () => {
    const personId = "U-26-ADA";
    const person = result({ schema: "gitpm/person@1", id: personId, name: "Ada", weekly_capacity_hours: 32, calendar: "C-26-DEFAULT", lifecycle: "active" });
    const calendar = result({ schema: "gitpm/calendar@1", id: "C-26-DEFAULT", name: "Default", working_weekdays: [1, 2, 3, 4, 5], holidays: [], lifecycle: "active" });
    const schemaByType: Record<string, string> = { people: "gitpm/person@1", calendars: "gitpm/calendar@1", teams: "gitpm/team@1", projects: "gitpm/project@2", tasks: "gitpm/task@2" };
    const deleteEntity = vi.fn(async () => undefined);
    const confirmAction = vi.fn(() => false);
    const onNavigate = vi.fn();
    const api = { listEntities: vi.fn(async (_draftId: string, type: string) => [person, calendar].filter((item) => item.document.schema === schemaByType[type])), getConfiguration: vi.fn(async (_draftId: string, kind: string) => kind === "schedule-tracks" ? tracksConfig() : statusesConfig()), deleteEntity } as unknown as GitPmApi;

    render(<PeopleProfileWorkspace api={api} confirmAction={confirmAction} draft={draft} locale="en" onNavigate={onNavigate} personId={personId} role="Maintainer" />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit person" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(confirmAction).toHaveBeenCalledWith("Delete Ada permanently? This action cannot be undone.");
    expect(deleteEntity).not.toHaveBeenCalled();

    confirmAction.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleteEntity).toHaveBeenCalledWith(draft.draft_id, "people", person, person.draft_fingerprint));
    expect(onNavigate).toHaveBeenCalledWith("people");
  });

  it("asks a second time with understandable references before unlinking and deleting", async () => {
    const personId = "U-26-ADA";
    const person = result({ schema: "gitpm/person@1", id: personId, name: "Ada", weekly_capacity_hours: 32, calendar: "C-26-DEFAULT", lifecycle: "active" });
    const calendar = result({ schema: "gitpm/calendar@1", id: "C-26-DEFAULT", name: "Default", working_weekdays: [1, 2, 3, 4, 5], holidays: [], lifecycle: "active" });
    const schemaByType: Record<string, string> = { people: "gitpm/person@1", calendars: "gitpm/calendar@1", teams: "gitpm/team@1", projects: "gitpm/project@2", tasks: "gitpm/task@2" };
    const deleteEntity = vi.fn()
      .mockRejectedValueOnce(new ApiError("DELETE_RESTRICTED", `${personId} is referenced`, [
        { path: "teams/G-26-CORE.yaml", label: "Core team" },
        { path: "projects/P-26-ALPHA/project.yaml", label: "Alpha" },
      ]))
      .mockResolvedValueOnce(undefined);
    const confirmAction = vi.fn(() => true);
    const onNavigate = vi.fn();
    const api = { listEntities: vi.fn(async (_draftId: string, type: string) => [person, calendar].filter((item) => item.document.schema === schemaByType[type])), getConfiguration: vi.fn(async (_draftId: string, kind: string) => kind === "schedule-tracks" ? tracksConfig() : statusesConfig()), deleteEntity } as unknown as GitPmApi;

    render(<PeopleProfileWorkspace api={api} confirmAction={confirmAction} draft={draft} locale="en" onNavigate={onNavigate} personId={personId} role="Maintainer" />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit person" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(deleteEntity).toHaveBeenCalledTimes(2));
    expect(confirmAction).toHaveBeenNthCalledWith(1, "Delete Ada permanently? This action cannot be undone.");
    expect(confirmAction).toHaveBeenNthCalledWith(2, "Ada is still used in 2 items:\n• Core team (teams/G-26-CORE.yaml)\n• Alpha (projects/P-26-ALPHA/project.yaml)\n\nRemove this person from those items and then delete the person permanently?");
    expect(deleteEntity).toHaveBeenNthCalledWith(2, draft.draft_id, "people", person, person.draft_fingerprint, true);
    expect(onNavigate).toHaveBeenCalledWith("people");
  });

  it("keeps the profile editor unavailable outside Maintainer UI drafts", async () => {
    const personId = "U-26-ADA";
    const person = result({ schema: "gitpm/person@1", id: personId, name: "Ada", weekly_capacity_hours: 32, calendar: "C-26-DEFAULT", lifecycle: "active" });
    const calendar = result({ schema: "gitpm/calendar@1", id: "C-26-DEFAULT", name: "Default", working_weekdays: [1, 2, 3, 4, 5], holidays: [], lifecycle: "active" });
    const schemaByType: Record<string, string> = { people: "gitpm/person@1", calendars: "gitpm/calendar@1", teams: "gitpm/team@1", projects: "gitpm/project@2", tasks: "gitpm/task@2" };
    const api = { listEntities: vi.fn(async (_draftId: string, type: string) => [person, calendar].filter((item) => item.document.schema === schemaByType[type])), getConfiguration: vi.fn(async (_draftId: string, kind: string) => kind === "schedule-tracks" ? tracksConfig() : statusesConfig()) } as unknown as GitPmApi;

    render(<PeopleProfileWorkspace api={api} draft={draft} locale="en" onNavigate={vi.fn()} personId={personId} role="Developer" />);

    expect(await screen.findByText("Administrative changes require Maintainer.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Edit person" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
