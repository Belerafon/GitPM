// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
});
