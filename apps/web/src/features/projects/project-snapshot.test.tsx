// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectSnapshot } from "./project-snapshot.js";
import { ScheduleResolver, scheduleTracksConfig } from "../../schedules.js";
import type { GitPmApi } from "../../api.js";
import type { DraftStatus, EntityDocument, EntityResult } from "../../types.js";

const configDocument = { schema: "gitpm/schedule-tracks@1", tracks: [{ slug: "plan", title: "Plan", kind: "manual", capabilities: ["dates", "effort", "dependencies"] }, { slug: "target", title: "Target", kind: "manual", capabilities: ["dates"] }, { slug: "actual", title: "Actual", kind: "actual", source: "time_entries" }], defaults: { enabled_tracks: ["plan", "target", "actual"], primary_track: "plan", workload_track: "plan", comparison_track: "target", dashboard_tracks: ["plan", "target", "actual"] } };
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

  it("renders project overflow warnings from resolved milestone task roots", () => {
    const milestone = { document: { schema: "gitpm/milestone@2", id: "M-1", project: "P-26-1", name: "Release", lifecycle: "active" }, path: "m.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const parent = { document: { schema: "gitpm/task@2", id: "T-parent", project: "P-26-1", milestone: "M-1", title: "Parent", type: "task", status: "backlog", lifecycle: "active" }, path: "parent.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const child = { document: { schema: "gitpm/task@2", id: "T-child", project: "P-26-1", milestone: "M-1", parent: "T-parent", title: "Child", type: "task", status: "backlog", lifecycle: "active", schedules: { plan: { start: "2026-09-01", finish: "2026-09-15" } } }, path: "child.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;

    render(<ProjectSnapshot project={project({ plan: { start: "2026-09-05", finish: "2026-09-10" } })} locale="en" milestones={[milestone]} scheduling={scheduling} tasks={[parent, child]} />);

    const warning = screen.getByText("Schedule overflow").parentElement!;
    expect(warning.textContent).toContain("Plan");
    expect(warning.textContent).toContain("declared Sep 5, 2026");
    expect(warning.textContent).toContain("rolled Sep 1, 2026");
    expect(warning.textContent).toContain("declared Sep 10, 2026");
    expect(warning.textContent).toContain("rolled Sep 15, 2026");
  });

  it("aggregates actual hours, last activity, and hours-after across more than one page", async () => {
    const items = Array.from({ length: 201 }, (_, index) => ({ document: { schema: "gitpm/time-entry@1" as const, id: `E-${index}`, project: "P-26-1", task: "T-1", person: "U-1", performed_on: index === 200 ? "2026-04-01" : "2026-03-01", hours: index === 200 ? 3.5 : 1, category: "warranty", created_at: "2026-04-01T00:00:00.000Z", state: "active" as const }, path: `p-${index}`, blob_id: "a", draft_fingerprint: "f" }));
    const listProjectTimeEntries = vi.fn(async (_draftId: string, _projectId: string, filters?: { readonly offset?: number; readonly limit?: number }) => {
      const offset = filters?.offset ?? 0; const limit = filters?.limit ?? 200;
      return { total: items.length, offset, limit, items: items.slice(offset, offset + limit) };
    });
    const api = { listProjectTimeEntries, listTimeEntries: vi.fn() } as unknown as GitPmApi;
    const task = { document: { schema: "gitpm/task@2", id: "T-1", project: "P-26-1", title: "T", type: "task", status: "done", lifecycle: "active" }, path: "t.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    render(<ProjectSnapshot project={project({ plan: { finish: "2026-03-20" }, target: { finish: "2026-02-28" } }, { primary_track: "plan", comparison_track: "target" })} locale="en" scheduling={scheduling} api={api} draft={draft} tasks={[task]} />);
    await waitFor(() => expect(screen.getByText("Actual hours").parentElement?.textContent).toMatch(/203\.5/));
    expect(screen.getByText("Last activity").parentElement?.textContent).toContain("Apr");
    expect(screen.getByText(/Hours after/).parentElement?.textContent).toMatch(/203\.5/);
    expect(screen.getByText("Actual hours report")).toBeTruthy();
    expect(listProjectTimeEntries.mock.calls.map((call) => call[2]?.offset)).toEqual([0, 200]);
  });

  it("does not request or render actual data when the effective Project Planning disables the actual track", async () => {
    const listProjectTimeEntries = vi.fn();
    const api = { listProjectTimeEntries } as unknown as GitPmApi;
    render(<ProjectSnapshot project={project({ plan: { finish: "2026-03-20" }, target: { finish: "2026-02-28" } }, { enabled_tracks: ["plan", "target"], primary_track: "plan", workload_track: "plan", comparison_track: "target", dashboard_tracks: ["plan", "target"] })} locale="en" scheduling={scheduling} api={api} draft={draft} />);

    expect(await screen.findByText("Primary finish")).toBeTruthy();
    expect(listProjectTimeEntries).not.toHaveBeenCalled();
    expect(screen.queryByText("Actual hours")).toBeNull();
    expect(screen.queryByText("Last activity")).toBeNull();
    expect(screen.queryByText("Actual hours report")).toBeNull();
    expect(screen.queryByText(/Hours after/u)).toBeNull();
  });
});
