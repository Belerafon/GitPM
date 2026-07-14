// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitPmApi } from "./api.js";
import type { DraftStatus, EntityResult, GitPmDocument } from "./types.js";
import { WorkloadWorkspace } from "./workload-ui.js";

const projectId = "P-26-111111";
const adaId = "U-26-222222";
const linusId = "U-26-333333";
const calendarId = "C-26-444444";
const draft: DraftStatus = { draft_id: "DRF-WORKLOAD", owner_gitlab_user_id: "42", branch: "gitpm/42/DRF-WORKLOAD", base_commit: "a".repeat(40), writer_mode: "ui", state: "open", fingerprint: "b".repeat(64), created_at: "2026-07-11T00:00:00.000Z", updated_at: "2026-07-11T00:00:00.000Z" };
const result = (document: GitPmDocument): EntityResult => ({ document, path: `${document.id}.yaml`, blob_id: "c".repeat(40), draft_fingerprint: "d".repeat(64) });
const task = (suffix: string, title: string, extra: Record<string, unknown>) => result({ schema: "gitpm/task@1", id: `T-26-${suffix.repeat(6)}`, project: projectId, title, type: "task", status: "backlog", lifecycle: "active", ...extra });

const calendar = result({ schema: "gitpm/calendar@1", id: calendarId, name: "Engineering", working_weekdays: [1, 2, 3, 4, 5], holidays: ["2026-07-08"], lifecycle: "active" });
const ada = result({ schema: "gitpm/person@1", id: adaId, name: "Ada", weekly_capacity_hours: 40, calendar: calendarId, lifecycle: "active" });
const linus = result({ schema: "gitpm/person@1", id: linusId, name: "Linus", weekly_capacity_hours: 32, calendar: calendarId, lifecycle: "active" });
const shared = task("5", "Shared", { estimate_hours: 40, start: "2026-07-06", due: "2026-07-10", assignees: [adaId, linusId] });
const span = task("6", "Span", { estimate_hours: 30, start: "2026-07-09", due: "2026-07-15", assignees: [adaId] });
const undated = task("7", "Undated", { estimate_hours: 10, assignees: [adaId] });
const archived = result({ ...task("8", "Archived", { estimate_hours: 10, start: "2026-07-06", due: "2026-07-10", assignees: [adaId] }).document, lifecycle: "archived" });

afterEach(cleanup);
describe("Workload UI", () => {
  it("renders deterministic Person-week values and excludes archived and undated Tasks", async () => {
    const entities = [shared, span, undated, archived, ada, linus, calendar];
    const onNavigate = vi.fn();
    const api = { listEntities: vi.fn(async (_draftId: string, type: string) => entities.filter((item) => ({ tasks: "gitpm/task@1", people: "gitpm/person@1", calendars: "gitpm/calendar@1" })[type] === item.document.schema)) } as unknown as GitPmApi;
    const { container } = render(<WorkloadWorkspace api={api} draft={draft} locale="en" onNavigate={onNavigate} />);
    await waitFor(() => expect(container.querySelectorAll(".workload-table tbody tr")).toHaveLength(2));
    expect(screen.getByText("Included Tasks").nextElementSibling?.textContent).toBe("2");
    expect(screen.getByText("Excluded Tasks").nextElementSibling?.textContent).toBe("2");
    expect(container.querySelector(`[data-person-id="${adaId}"][data-week="2026-07-06"]`)?.textContent).toContain("32h / 32h");
    expect(container.querySelector(`[data-person-id="${adaId}"][data-week="2026-07-13"]`)?.textContent).toContain("18h / 40h");
    expect(container.querySelector(`[data-person-id="${linusId}"][data-week="2026-07-06"]`)?.textContent).toContain("20h / 25.6h");
    expect(screen.getByText("Missing or invalid date range").nextElementSibling?.textContent).toBe("1");
    expect(screen.getByText("Archived").nextElementSibling?.textContent).toBe("1");
    fireEvent.click(screen.getByRole("button", { name: "Ada" }));
    expect(onNavigate).toHaveBeenCalledWith("people");
  });
});
