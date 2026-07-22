// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitPmApi } from "./api.js";
import { PeopleProfileWorkspace } from "./people-profile-ui.js";
import type { DraftStatus, EntityResult, GitPmDocument } from "./types.js";

const draft: DraftStatus = { draft_id: "DRF-PEOPLE", owner_gitlab_user_id: "42", branch: "gitpm/42/DRF-PEOPLE", base_commit: "a".repeat(40), writer_mode: "ui", state: "open", fingerprint: "b".repeat(64), created_at: "2026-07-10T00:00:00.000Z", updated_at: "2026-07-10T00:00:00.000Z" };
const result = (document: GitPmDocument): EntityResult => ({ document, path: `${document.id}.yaml`, blob_id: "a".repeat(40), draft_fingerprint: "b".repeat(64) });

afterEach(cleanup);

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
      result({ schema: "gitpm/project@1", id: projectId, name: "Alpha", owner: personId, status: "in-progress", lifecycle: "active" }),
      result({ schema: "gitpm/project@1", id: contributingProjectId, name: "Beta", owner: "U-26-GRACE", status: "planned", lifecycle: "active" }),
      result({ schema: "gitpm/task@1", id: taskId, project: projectId, title: "Ship profile", status: "in-progress", assignees: [personId], start: "2026-07-20", due: "2026-07-24", lifecycle: "active" }),
      result({ schema: "gitpm/task@1", id: "T-26-SECOND", project: contributingProjectId, title: "Review calendar", status: "planned", assignees: [personId], start: "2026-07-22", due: "2026-07-23", lifecycle: "active" }),
    ];
    const schemaByType: Record<string, string> = { people: "gitpm/person@1", calendars: "gitpm/calendar@1", teams: "gitpm/team@1", projects: "gitpm/project@1", tasks: "gitpm/task@1" };
    const api = { listEntities: vi.fn(async (_draftId: string, type: string) => entities.filter((item) => item.document.schema === schemaByType[type])) } as unknown as GitPmApi;
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
    expect(screen.getByRole("heading", { name: "Participates in" })).toBeTruthy();
  });

  it("edits a person only from the profile and keeps the latest draft fingerprint", async () => {
    const personId = "U-26-ADA";
    const calendar = result({ schema: "gitpm/calendar@1", id: "C-26-DEFAULT", name: "Default", working_weekdays: [1, 2, 3, 4, 5], holidays: [], lifecycle: "active" });
    let person = result({ schema: "gitpm/person@1", id: personId, name: "Ada", email: "ada@example.test", weekly_capacity_hours: 32, calendar: calendar.document.id, lifecycle: "active" });
    let revision = 0;
    const schemaByType: Record<string, string> = { people: "gitpm/person@1", calendars: "gitpm/calendar@1", teams: "gitpm/team@1", projects: "gitpm/project@1", tasks: "gitpm/task@1" };
    const updateEntity = vi.fn(async (_draftId: string, _type: string, _entity: EntityResult, _fingerprint: string, document: GitPmDocument) => {
      revision += 1;
      person = { ...result(document), draft_fingerprint: (revision === 1 ? "c" : "d").repeat(64) };
      return person;
    });
    const api = {
      listEntities: vi.fn(async (_draftId: string, type: string) => [person, calendar].filter((item) => item.document.schema === schemaByType[type])),
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
    const schemaByType: Record<string, string> = { people: "gitpm/person@1", calendars: "gitpm/calendar@1", teams: "gitpm/team@1", projects: "gitpm/project@1", tasks: "gitpm/task@1" };
    const deleteEntity = vi.fn(async () => undefined);
    const confirmAction = vi.fn(() => false);
    const onNavigate = vi.fn();
    const api = { listEntities: vi.fn(async (_draftId: string, type: string) => [person, calendar].filter((item) => item.document.schema === schemaByType[type])), deleteEntity } as unknown as GitPmApi;

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

  it("keeps the profile editor unavailable outside Maintainer UI drafts", async () => {
    const personId = "U-26-ADA";
    const person = result({ schema: "gitpm/person@1", id: personId, name: "Ada", weekly_capacity_hours: 32, calendar: "C-26-DEFAULT", lifecycle: "active" });
    const calendar = result({ schema: "gitpm/calendar@1", id: "C-26-DEFAULT", name: "Default", working_weekdays: [1, 2, 3, 4, 5], holidays: [], lifecycle: "active" });
    const schemaByType: Record<string, string> = { people: "gitpm/person@1", calendars: "gitpm/calendar@1", teams: "gitpm/team@1", projects: "gitpm/project@1", tasks: "gitpm/task@1" };
    const api = { listEntities: vi.fn(async (_draftId: string, type: string) => [person, calendar].filter((item) => item.document.schema === schemaByType[type])) } as unknown as GitPmApi;

    render(<PeopleProfileWorkspace api={api} draft={draft} locale="en" onNavigate={vi.fn()} personId={personId} role="Developer" />);

    expect(await screen.findByText("Administrative changes require Maintainer.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Edit person" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
