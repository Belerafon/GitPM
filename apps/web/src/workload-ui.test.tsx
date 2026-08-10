// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitPmApi } from "./api.js";
import type { DraftStatus, EntityDocument, EntityResult } from "./types.js";
import { WorkloadWorkspace } from "./workload-ui.js";

const projectId = "P-26-111111";
const adaId = "U-26-222222";
const linusId = "U-26-333333";
const calendarId = "C-26-444444";
const draft: DraftStatus = { draft_id: "DRF-WORKLOAD", owner_gitlab_user_id: "42", branch: "gitpm/42/DRF-WORKLOAD", base_commit: "a".repeat(40), writer_mode: "ui", state: "open", fingerprint: "b".repeat(64), created_at: "2026-07-11T00:00:00.000Z", updated_at: "2026-07-11T00:00:00.000Z" };
const result = (document: EntityDocument): EntityResult => ({ document, path: `${document.id}.yaml`, blob_id: "c".repeat(40), draft_fingerprint: "d".repeat(64) });
const task = (suffix: string, title: string, extra: Record<string, unknown>) => result({ schema: "gitpm/task@2", id: `T-26-${suffix.repeat(6)}`, project: projectId, title, type: "task", status: "backlog", lifecycle: "active", ...extra });

const tracksConfig = () => ({ document: { schema: "gitpm/schedule-tracks@1", tracks: [{ slug: "plan", title: "Plan", kind: "manual", capabilities: ["dates", "effort", "dependencies"] }], defaults: { enabled_tracks: ["plan"], primary_track: "plan", workload_track: "plan", dashboard_tracks: ["plan"] } }, path: ".gitpm/schedule-tracks.yaml", blob_id: "a".repeat(40), draft_fingerprint: "b".repeat(64) });
const calendar = result({ schema: "gitpm/calendar@1", id: calendarId, name: "Engineering", working_weekdays: [1, 2, 3, 4, 5], holidays: ["2026-07-08"], lifecycle: "active" });
const ada = result({ schema: "gitpm/person@1", id: adaId, name: "Ada", weekly_capacity_hours: 40, calendar: calendarId, lifecycle: "active" });
const linus = result({ schema: "gitpm/person@1", id: linusId, name: "Linus", weekly_capacity_hours: 32, calendar: calendarId, lifecycle: "active" });
const shared = task("5", "Shared", { schedules: { plan: { effort_hours: 40, start: "2026-07-06", finish: "2026-07-10" } }, assignees: [adaId, linusId] });
const span = task("6", "Span", { schedules: { plan: { effort_hours: 30, start: "2026-07-09", finish: "2026-07-15" } }, assignees: [adaId] });
const spike = task("4", "Release spike", { schedules: { plan: { effort_hours: 8, start: "2026-07-06", finish: "2026-07-10" } }, assignees: [adaId] });
const undated = task("7", "Undated", { schedules: { plan: { effort_hours: 10 } }, assignees: [adaId] });
const archived = result({ ...task("8", "Archived", { schedules: { plan: { effort_hours: 10, start: "2026-07-06", finish: "2026-07-10" } }, assignees: [adaId] }).document, lifecycle: "archived" });
const project = result({ schema: "gitpm/project@2", id: projectId, name: "Platform", status: "backlog", lifecycle: "active" });
const archivedProjectId = "P-26-999999";
const archivedProject = result({ schema: "gitpm/project@2", id: archivedProjectId, name: "Legacy", status: "backlog", lifecycle: "archived" });
const archivedProjectTask = result({ ...shared.document, id: "T-26-999999", project: archivedProjectId, title: "Legacy active task" });
const reviewers = result({ schema: "gitpm/team@1", id: "G-26-555555", name: "Reviewers", members: [linusId], lifecycle: "active" });
const absence = result({ schema: "gitpm/availability-event@1", id: "A-26-555555", person: adaId, start: "2026-07-09", finish: "2026-07-09", kind: "vacation", availability_percent: 0, state: "planned", lifecycle: "active" });

afterEach(cleanup);
describe("Workload UI", () => {
  it("renders deterministic Person-week values and excludes archived and undated Tasks", async () => {
    const entities = [shared, span, spike, undated, archived, archivedProjectTask, ada, linus, calendar, absence, project, archivedProject, reviewers];
    const onNavigate = vi.fn();
    const api = { listEntities: vi.fn(async (_draftId: string, type: string) => entities.filter((item) => ({ tasks: "gitpm/task@2", people: "gitpm/person@1", calendars: "gitpm/calendar@1", "availability-events": "gitpm/availability-event@1", projects: "gitpm/project@2", teams: "gitpm/team@1" })[type] === item.document.schema)), getConfiguration: vi.fn(async (_draftId: string, kind: string) => kind === "schedule-tracks" ? tracksConfig() : { document: { schema: "gitpm/statuses@2", id: "statuses", lifecycle: "active", statuses: [] }, path: kind, blob_id: "a".repeat(40), draft_fingerprint: "b".repeat(64) }) } as unknown as GitPmApi;
    const { container } = render(<WorkloadWorkspace api={api} draft={draft} locale="en" onNavigate={onNavigate} />);
    await waitFor(() => expect(container.querySelectorAll(".workload-table tbody tr")).toHaveLength(2));
    expect(screen.getByText("Included Tasks").nextElementSibling?.textContent).toBe("3");
    expect(screen.getByText("Excluded Tasks").nextElementSibling?.textContent).toBe("3");
    expect(container.querySelector(`[data-person-id="${adaId}"][data-week="2026-07-06"]`)?.textContent).toContain("35.5h / 24h");
    expect(container.querySelector(`[data-person-id="${adaId}"][data-week="2026-07-13"]`)?.textContent).toContain("22.5h / 40h");
    expect(container.querySelector(`[data-person-id="${linusId}"][data-week="2026-07-06"]`)?.textContent).toContain("20h / 25.6h");
    expect(container.querySelector(`[data-person-id="${adaId}"][data-week="2026-07-06"]`)?.className).toContain("overloaded");
    expect(screen.getByText("Near capacity")).toBeTruthy();
    expect(screen.getByText("Missing or invalid date range").nextElementSibling?.textContent).toBe("1");
    expect(screen.getByText("Archived").nextElementSibling?.textContent).toBe("2");
    fireEvent.click(screen.getByRole("button", { name: "Show workload details for Ada, week of Jul 6, 2026" }));
    const breakdown = screen.getByRole("dialog", { name: /Ada · Week of/u });
    expect(within(breakdown).getByText("Overload").nextElementSibling?.textContent).toBe("11.5h");
    expect(within(breakdown).getByText("Personal unavailability").nextElementSibling?.textContent).toBe("8h unavailable of 32h base capacity");
    expect(within(breakdown).getByText("Contributing Tasks: 3")).toBeTruthy();
    expect(within(breakdown).getByText("Release spike")).toBeTruthy();
    expect(within(breakdown).getAllByText(/Week of Jul 13, 2026 · 17.5h available/u).length).toBeGreaterThan(0);
    fireEvent.click(within(breakdown).getAllByRole("link", { name: "Platform" })[0]!);
    expect(onNavigate).toHaveBeenCalledWith("projects", { projectId });
    fireEvent.click(screen.getByRole("button", { name: "Show workload details for Ada, week of Jul 6, 2026" }));
    const reopenedBreakdown = screen.getByRole("dialog", { name: /Ada · Week of/u });
    fireEvent.click(within(reopenedBreakdown).getByRole("button", { name: "Release spike" }));
    expect(onNavigate).toHaveBeenCalledWith("tasks", { projectId, taskId: spike.document.id });
    fireEvent.change(screen.getByLabelText("Team"), { target: { value: reviewers.document.id } });
    await waitFor(() => expect(screen.getByText("Included Tasks").nextElementSibling?.textContent).toBe("1"));
    fireEvent.click(screen.getByRole("button", { name: "Ada" }));
    expect(onNavigate).toHaveBeenCalledWith("people", { personId: adaId });
  });
});
