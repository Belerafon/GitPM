// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSchedulingHierarchy, type SchedulingHierarchyTask } from "@gitpm/scheduling";
import { ProjectActualReport } from "./project-actual-report.js";
import { ScheduleResolver, scheduleTracksConfig } from "../../schedules.js";
import type { GitPmApi } from "../../api.js";
import type { DraftStatus, EntityDocument, EntityResult } from "../../types.js";

const configDocument = { schema: "gitpm/schedule-tracks@1", tracks: [{ slug: "plan", title: "Plan", kind: "manual", capabilities: ["dates", "effort", "dependencies"] }, { slug: "target", title: "Target", kind: "manual", capabilities: ["dates"] }, { slug: "actual", title: "Actual", kind: "actual", source: "time_entries" }], defaults: { enabled_tracks: ["plan", "target", "actual"], primary_track: "plan", workload_track: "plan", comparison_track: "target", dashboard_tracks: ["plan", "target", "actual"] } };
const scheduling = new ScheduleResolver(scheduleTracksConfig(configDocument));

// A track-agnostic configuration where the primary, workload, and comparison roles
// are bound to three distinct made-up slugs (`working`, `estimate`, `forecast`).
const multiTrackDocument = { schema: "gitpm/schedule-tracks@1", tracks: [{ slug: "working", title: "Working", kind: "manual", capabilities: ["dates", "effort"] }, { slug: "forecast", title: "Forecast", kind: "manual", capabilities: ["dates"] }, { slug: "estimate", title: "Estimate", kind: "manual", capabilities: ["dates", "effort"] }, { slug: "actual", title: "Actual", kind: "actual", source: "time_entries" }], defaults: { enabled_tracks: ["working", "forecast", "estimate", "actual"], primary_track: "working", workload_track: "estimate", comparison_track: "forecast", dashboard_tracks: ["working", "forecast", "estimate", "actual"] } };
const multiTrackScheduling = new ScheduleResolver(scheduleTracksConfig(multiTrackDocument));

const project = (schedules: Record<string, unknown>, planning?: Record<string, unknown>): EntityDocument =>
  ({ schema: "gitpm/project@2", id: "P-26-1", name: "Demo", status: "in-progress", lifecycle: "active", ...(planning === undefined ? {} : { planning }), schedules } as EntityDocument);

const draft: DraftStatus = { draft_id: "DRF", owner_gitlab_user_id: "1", branch: "b", base_commit: "a".repeat(40), writer_mode: "ui", state: "open", fingerprint: "b".repeat(64), created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" };

// Mirrors the read-model assembly that ProjectSnapshot used to perform for the actual report.
const buildReportProps = (projectDoc: EntityDocument, milestones: readonly EntityResult[], tasks: readonly EntityResult[], resolver: ScheduleResolver) => {
  const primaryTrack = resolver.primaryTrack(projectDoc.planning);
  const workloadTrack = resolver.workloadTrack(projectDoc.planning);
  const comparison = resolver.comparisonTrack(projectDoc.planning);
  const tracks = [...new Set([primaryTrack, workloadTrack, comparison].filter((track): track is string => track !== undefined && track !== ""))];
  const hierarchy = resolveSchedulingHierarchy({
    project: projectDoc,
    milestones: milestones.map((milestone) => milestone.document),
    tasks: tasks.map((task): SchedulingHierarchyTask => ({
      ...task.document,
      parent: typeof task.document.parent === "string" && task.document.parent !== "" ? task.document.parent : undefined,
      milestone: typeof task.document.milestone === "string" && task.document.milestone !== "" ? task.document.milestone : undefined,
    })),
    tracks,
  });
  const readModel = hierarchy.readModels.get(projectDoc.id)!;
  const comparisonFinish = comparison === undefined ? undefined : readModel.tracks.find((track) => track.track === comparison)?.effective?.finish;
  return { readModels: hierarchy.readModels, workloadTrack, comparisonFinish };
};

afterEach(cleanup);

describe("ProjectActualReport", () => {
  it("aggregates actual hours, last activity, and hours-after across more than one page", async () => {
    const items = Array.from({ length: 201 }, (_, index) => ({ document: { schema: "gitpm/time-entry@1" as const, id: `E-${index}`, project: "P-26-1", task: "T-1", person: "U-1", performed_on: index === 200 ? "2026-04-01" : "2026-03-01", hours: index === 200 ? 3.5 : 1, category: "warranty", created_at: "2026-04-01T00:00:00.000Z", state: "active" as const }, path: `p-${index}`, blob_id: "a", draft_fingerprint: "f" }));
    const listProjectTimeEntries = vi.fn(async (_draftId: string, _projectId: string, filters?: { readonly offset?: number; readonly limit?: number }) => {
      const offset = filters?.offset ?? 0; const limit = filters?.limit ?? 200;
      return { total: items.length, offset, limit, items: items.slice(offset, offset + limit) };
    });
    const api = { listProjectTimeEntries, listTimeEntries: vi.fn() } as unknown as GitPmApi;
    const task = { document: { schema: "gitpm/task@2", id: "T-1", project: "P-26-1", title: "T", type: "task", status: "done", lifecycle: "active" }, path: "t.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const projectDoc = project({ plan: { finish: "2026-03-20" }, target: { finish: "2026-02-28" } }, { primary_track: "plan", comparison_track: "target" });
    const { readModels, workloadTrack, comparisonFinish } = buildReportProps(projectDoc, [], [task], scheduling);
    render(<ProjectActualReport api={api} comparisonFinish={comparisonFinish} draft={draft} locale="en" projectId={String(projectDoc.id)} readModels={readModels} tasks={[task]} workloadTrack={workloadTrack} />);
    await waitFor(() => expect(screen.getByText("Actual hours").parentElement?.textContent).toMatch(/203\.5/));
    expect(screen.getByText("Last activity").parentElement?.textContent).toContain("Apr");
    expect(screen.getByText("Hours after 2026-02-28").parentElement?.textContent).toMatch(/203\.5/);
    expect(screen.getByText("Actual hours report")).toBeTruthy();
    expect(listProjectTimeEntries.mock.calls.map((call) => call[2]?.offset)).toEqual([0, 200]);
  });

  it("applies every project actual filter and compares the selected workload scope with actual hours", async () => {
    const milestone = { document: { schema: "gitpm/milestone@2", id: "M-26-REPORT", project: "P-26-1", name: "Delivery", lifecycle: "active" }, path: "m.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const taskOne = { document: { schema: "gitpm/task@2", id: "T-26-REPORT", project: "P-26-1", milestone: milestone.document.id, title: "Report task", type: "task", status: "done", lifecycle: "active", schedules: { plan: { start: "2026-09-01", finish: "2026-09-30", effort_hours: 8 } } }, path: "one.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const taskTwo = { document: { schema: "gitpm/task@2", id: "T-26-OTHER0", project: "P-26-1", title: "Other task", type: "task", status: "done", lifecycle: "active", schedules: { plan: { start: "2026-09-01", finish: "2026-09-30", effort_hours: 4 } } }, path: "two.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const person = { document: { schema: "gitpm/person@1", id: "U-26-REPORT", name: "Ada Report", weekly_capacity_hours: 40, calendar: "C-26-REPORT", lifecycle: "active" }, path: "u.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const items = [
      { document: { schema: "gitpm/time-entry@1" as const, id: "E-26-REPORT", project: "P-26-1", task: taskOne.document.id, person: person.document.id, performed_on: "2026-09-10", hours: 5, category: "regular", created_at: "2026-09-10T00:00:00.000Z", state: "active" as const }, path: "one", blob_id: "a", draft_fingerprint: "f" },
      { document: { schema: "gitpm/time-entry@1" as const, id: "E-26-OTHER0", project: "P-26-1", task: taskTwo.document.id, person: "U-26-OTHER0", performed_on: "2026-08-10", hours: 2.5, category: "support", created_at: "2026-08-10T00:00:00.000Z", state: "active" as const }, path: "two", blob_id: "a", draft_fingerprint: "f" },
    ];
    const listProjectTimeEntries = vi.fn(async (_draftId: string, _projectId: string, filters: Record<string, unknown> = {}) => {
      const filtered = items.filter((item) =>
        (filters.task === undefined || item.document.task === filters.task)
        && (filters.milestone === undefined || item.document.task === taskOne.document.id)
        && (filters.person === undefined || item.document.person === filters.person)
        && (filters.category === undefined || item.document.category === filters.category)
        && (filters.state === undefined || item.document.state === filters.state)
        && (filters.performed_from === undefined || item.document.performed_on >= String(filters.performed_from))
        && (filters.performed_to === undefined || item.document.performed_on <= String(filters.performed_to)));
      return { total: filtered.length, offset: Number(filters.offset ?? 0), limit: Number(filters.limit ?? 200), items: filtered };
    });
    const api = { listProjectTimeEntries } as unknown as GitPmApi;
    const projectDoc = project({ plan: { start: "2026-09-01", finish: "2026-09-30" } }, { enabled_tracks: ["plan", "actual"], primary_track: "plan", workload_track: "plan", dashboard_tracks: ["plan", "actual"] });
    const { readModels, workloadTrack, comparisonFinish } = buildReportProps(projectDoc, [milestone], [taskOne, taskTwo], scheduling);
    render(<ProjectActualReport api={api} categories={[{ slug: "regular", title: "Regular work" }, { slug: "support", title: "Support" }]} comparisonFinish={comparisonFinish} draft={draft} locale="en" milestones={[milestone]} people={[person]} projectId={String(projectDoc.id)} readModels={readModels} tasks={[taskOne, taskTwo]} workloadTrack={workloadTrack} />);

    await waitFor(() => expect(screen.getByText("Actual hours").parentElement?.textContent).toContain("7.5 hours"));
    const initialSummary = screen.getByText("Plan vs actual").closest<HTMLElement>(".plan-actual-report")!.querySelector<HTMLElement>(".plan-actual-heading dl")!;
    expect(within(initialSummary).getByText("Planned").parentElement?.textContent).toContain("12 hours");
    fireEvent.change(screen.getByLabelText("Task"), { target: { value: taskOne.document.id } });
    fireEvent.change(screen.getByLabelText("Milestone"), { target: { value: milestone.document.id } });
    fireEvent.change(screen.getByLabelText("Person"), { target: { value: person.document.id } });
    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "regular" } });
    fireEvent.change(screen.getByLabelText("State"), { target: { value: "active" } });
    fireEvent.change(screen.getByLabelText("Performed from"), { target: { value: "2026-09-01" } });
    fireEvent.change(screen.getByLabelText("Performed to"), { target: { value: "2026-09-30" } });
    fireEvent.change(screen.getByLabelText("Hours after date"), { target: { value: "2026-09-05" } });

    await waitFor(() => expect(listProjectTimeEntries).toHaveBeenLastCalledWith("DRF", "P-26-1", expect.objectContaining({ task: taskOne.document.id, milestone: milestone.document.id, person: person.document.id, category: "regular", state: "active", performed_from: "2026-09-01", performed_to: "2026-09-30", offset: 0, limit: 200 })));
    const comparison = screen.getByText("Plan vs actual").closest<HTMLElement>(".plan-actual-report")!;
    const comparisonSummary = comparison.querySelector<HTMLElement>(".plan-actual-heading dl")!;
    await waitFor(() => expect(within(comparisonSummary).getByText("Planned").parentElement?.textContent).toContain("8 hours"));
    expect(within(comparisonSummary).getByText("Actual").parentElement?.textContent).toContain("5 hours");
    expect(within(comparisonSummary).getByText("Variance").parentElement?.textContent).toContain("-3 hours");
    expect(screen.getByText("Hours after 2026-09-05").parentElement?.textContent).toContain("5 hours");
    expect(screen.getAllByText("Ada Report").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Regular work").length).toBeGreaterThan(0);
  });

  it("sources the Planned effort in the actual report from the workload track, not the primary track", async () => {
    // The task carries different effort_hours under `working` (primary, 10h) and `estimate` (workload, 25h).
    // Pins current behavior: the Planned value reflects the WORKLOAD track (estimate).
    const task = { document: { schema: "gitpm/task@2", id: "T-26-WL", project: "P-26-1", title: "Workload task", type: "task", status: "done", lifecycle: "active", schedules: { working: { start: "2026-09-01", finish: "2026-09-30", effort_hours: 10 }, estimate: { start: "2026-09-01", finish: "2026-09-30", effort_hours: 25 } } }, path: "t.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const items = [
      { document: { schema: "gitpm/time-entry@1" as const, id: "E-26-WL", project: "P-26-1", task: task.document.id, person: "U-1", performed_on: "2026-09-10", hours: 4, category: "regular", created_at: "2026-09-10T00:00:00.000Z", state: "active" as const }, path: "e", blob_id: "a", draft_fingerprint: "f" },
    ];
    const listProjectTimeEntries = vi.fn(async () => ({ total: items.length, offset: 0, limit: 200, items }));
    const api = { listProjectTimeEntries } as unknown as GitPmApi;
    const projectDoc = project({ working: { finish: "2026-09-30" } }, { primary_track: "working", workload_track: "estimate", comparison_track: "forecast" });
    const { readModels, workloadTrack, comparisonFinish } = buildReportProps(projectDoc, [], [task], multiTrackScheduling);
    render(<ProjectActualReport api={api} comparisonFinish={comparisonFinish} draft={draft} locale="en" projectId={String(projectDoc.id)} readModels={readModels} tasks={[task]} workloadTrack={workloadTrack} />);

    await waitFor(() => {
      const summary = screen.getByText("Plan vs actual").closest<HTMLElement>(".plan-actual-report")!.querySelector<HTMLElement>(".plan-actual-heading dl")!;
      expect(within(summary).getByText("Planned").parentElement?.textContent).toMatch(/25/);
    });
  });

  it("excludes voided time entries from the actual hour sum and the activity window", async () => {
    const task = { document: { schema: "gitpm/task@2", id: "T-26-VOID", project: "P-26-1", title: "Void task", type: "task", status: "done", lifecycle: "active" }, path: "t.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const items = [
      { document: { schema: "gitpm/time-entry@1" as const, id: "E-26-ACTIVE", project: "P-26-1", task: task.document.id, person: "U-1", performed_on: "2026-09-10", hours: 3, category: "regular", created_at: "2026-09-10T00:00:00.000Z", state: "active" as const }, path: "a", blob_id: "a", draft_fingerprint: "f" },
      { document: { schema: "gitpm/time-entry@1" as const, id: "E-26-VOID", project: "P-26-1", task: task.document.id, person: "U-1", performed_on: "2026-12-12", hours: 5, category: "regular", created_at: "2026-12-12T00:00:00.000Z", state: "voided" as const }, path: "v", blob_id: "a", draft_fingerprint: "f" },
    ];
    const listProjectTimeEntries = vi.fn(async () => ({ total: items.length, offset: 0, limit: 200, items }));
    const api = { listProjectTimeEntries } as unknown as GitPmApi;
    const projectDoc = project({ plan: { finish: "2026-09-30" }, target: { finish: "2026-09-15" } }, { primary_track: "plan", comparison_track: "target" });
    const { readModels, workloadTrack, comparisonFinish } = buildReportProps(projectDoc, [], [task], scheduling);
    render(<ProjectActualReport api={api} comparisonFinish={comparisonFinish} draft={draft} locale="en" projectId={String(projectDoc.id)} readModels={readModels} tasks={[task]} workloadTrack={workloadTrack} />);

    await waitFor(() => expect(screen.getByText("Actual hours").parentElement?.textContent).toMatch(/3 hours/));
    expect(screen.getByText("Last activity").parentElement?.textContent).toMatch(/Sep|10/);
    expect(screen.getByText("Last activity").parentElement?.textContent).not.toMatch(/Dec/u);
    expect(screen.getByText("Active entries").parentElement?.textContent).toMatch(/1/);
    expect(screen.getByText("Voided entries").parentElement?.textContent).toMatch(/1/);
  });
});
