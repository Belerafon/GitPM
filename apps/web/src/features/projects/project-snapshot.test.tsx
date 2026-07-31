// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectSnapshot } from "./project-snapshot.js";
import { ScheduleResolver, scheduleTracksConfig } from "../../schedules.js";
import type { GitPmApi } from "../../api.js";
import type { DraftStatus, EntityDocument, EntityResult } from "../../types.js";

const configDocument = { schema: "gitpm/schedule-tracks@1", tracks: [{ slug: "plan", title: "Plan", kind: "manual", capabilities: ["dates", "effort", "dependencies"] }, { slug: "target", title: "Target", kind: "manual", capabilities: ["dates"] }], defaults: { enabled_tracks: ["plan", "target"], primary_track: "plan", workload_track: "plan", comparison_track: "target", dashboard_tracks: ["plan", "target"] } };
const scheduling = new ScheduleResolver(scheduleTracksConfig(configDocument));

const project = (schedules: Record<string, unknown>, planning?: Record<string, unknown>): EntityDocument =>
  ({ schema: "gitpm/project@2", id: "P-26-1", name: "Demo", status: "in-progress", lifecycle: "active", ...(planning === undefined ? {} : { planning }), schedules } as EntityDocument);

const draft: DraftStatus = { draft_id: "DRF", owner_gitlab_user_id: "1", branch: "b", base_commit: "a".repeat(40), writer_mode: "ui", state: "open", fingerprint: "b".repeat(64), created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" };

afterEach(cleanup);

describe("ProjectSnapshot", () => {
  it("renders nothing without schedule finishes", () => {
    const { container } = render(<ProjectSnapshot project={project({})} locale="en" scheduling={scheduling} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows primary and comparison finish with the signed variance", () => {
    render(<ProjectSnapshot project={project({ plan: { finish: "2026-03-20" }, target: { finish: "2026-02-28" } }, { primary_track: "plan", comparison_track: "target" })} locale="en" scheduling={scheduling} />);
    expect(screen.getByText("Primary finish").parentElement?.textContent).toContain("Mar");
    expect(screen.getByText("Comparison finish")).toBeTruthy();
    expect(screen.getByText("Variance").parentElement?.textContent).toMatch(/\+20 d/);
  });

  it("aggregates actual hours and hours-after the comparison finish", async () => {
    const listProjectTimeEntries = vi.fn(async () => ({ total: 1, offset: 0, limit: 100, items: [{ document: { schema: "gitpm/time-entry@1", id: "E-1", project: "P-26-1", task: "T-1", person: "U-1", performed_on: "2026-04-01", hours: 3.5, category: "warranty", created_at: "2026-04-01T00:00:00.000Z", state: "active" }, path: "p", blob_id: "a", draft_fingerprint: "f" }] }));
    const api = { listProjectTimeEntries, listTimeEntries: vi.fn() } as unknown as GitPmApi;
    const task = { document: { schema: "gitpm/task@2", id: "T-1", project: "P-26-1", title: "T", type: "task", status: "done", lifecycle: "active" }, path: "t.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    render(<ProjectSnapshot project={project({ plan: { finish: "2026-03-20" }, target: { finish: "2026-02-28" } }, { primary_track: "plan", comparison_track: "target" })} locale="en" scheduling={scheduling} api={api} draft={draft} tasks={[task]} />);
    await waitFor(() => expect(screen.getByText("Actual hours").parentElement?.textContent).toMatch(/3\.5/));
    expect(screen.getByText(/Hours after/).parentElement?.textContent).toMatch(/3\.5/);
    expect(screen.getByText("Actual hours report")).toBeTruthy();
    expect(listProjectTimeEntries).toHaveBeenCalledTimes(1);
  });
});
