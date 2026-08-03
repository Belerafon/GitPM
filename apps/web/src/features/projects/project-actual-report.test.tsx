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

const projectEntity = (projectDoc: EntityDocument): EntityResult => ({ document: projectDoc, path: "project.yaml", blob_id: "a".repeat(40), draft_fingerprint: "f" });
const onNavigate = vi.fn();

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

afterEach(() => { cleanup(); onNavigate.mockClear(); });

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
    render(<ProjectActualReport api={api} comparisonFinish={comparisonFinish} draft={draft} locale="en" onNavigate={onNavigate} project={projectEntity(projectDoc)} projectId={String(projectDoc.id)} readModels={readModels} tasks={[task]} workloadTrack={workloadTrack} />);
    // "Actual hours" appears in both the activity summary and the plan/actual block; the
    // activity summary is the first one in DOM order.
    await waitFor(() => expect(screen.getAllByText("Actual hours")[0]?.parentElement?.textContent).toMatch(/203\.5/));
    expect(screen.getAllByText("Last activity")[0]?.parentElement?.textContent).toContain("Apr");
    expect(screen.getByText("Hours after 2026-02-28").parentElement?.textContent).toMatch(/203\.5/);
    expect(screen.getByText("Actual hours report")).toBeTruthy();
    expect(listProjectTimeEntries.mock.calls.map((call) => call[2]?.offset)).toEqual([0, 200]);
  });

  it("applies actual-only filters without relabeling the plan and shows the plan-not-filtered notice", async () => {
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
        (filters.person === undefined || item.document.person === filters.person)
        && (filters.category === undefined || item.document.category === filters.category)
        && (filters.state === undefined || item.document.state === filters.state)
        && (filters.performed_from === undefined || item.document.performed_on >= String(filters.performed_from))
        && (filters.performed_to === undefined || item.document.performed_on <= String(filters.performed_to)));
      return { total: filtered.length, offset: Number(filters.offset ?? 0), limit: Number(filters.limit ?? 200), items: filtered };
    });
    const api = { listProjectTimeEntries } as unknown as GitPmApi;
    const projectDoc = project({ plan: { start: "2026-09-01", finish: "2026-09-30" } }, { enabled_tracks: ["plan", "actual"], primary_track: "plan", workload_track: "plan", dashboard_tracks: ["plan", "actual"] });
    const { readModels, workloadTrack, comparisonFinish } = buildReportProps(projectDoc, [milestone], [taskOne, taskTwo], scheduling);
    render(<ProjectActualReport api={api} categories={[{ slug: "regular", title: "Regular work" }, { slug: "support", title: "Support" }]} comparisonFinish={comparisonFinish} draft={draft} locale="en" milestones={[milestone]} onNavigate={onNavigate} people={[person]} project={projectEntity(projectDoc)} projectId={String(projectDoc.id)} readModels={readModels} tasks={[taskOne, taskTwo]} workloadTrack={workloadTrack} />);

    fireEvent.change(screen.getByLabelText("Task"), { target: { value: taskOne.document.id } });
    fireEvent.change(screen.getByLabelText("Person"), { target: { value: person.document.id } });
    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "regular" } });
    fireEvent.change(screen.getByLabelText("State"), { target: { value: "active" } });
    fireEvent.change(screen.getByLabelText("Performed from"), { target: { value: "2026-09-01" } });
    fireEvent.change(screen.getByLabelText("Performed to"), { target: { value: "2026-09-30" } });
    fireEvent.change(screen.getByLabelText("Hours after date"), { target: { value: "2026-09-05" } });

    await waitFor(() => expect(listProjectTimeEntries).toHaveBeenLastCalledWith("DRF", "P-26-1", expect.objectContaining({ person: person.document.id, category: "regular", state: "active", performed_from: "2026-09-01", performed_to: "2026-09-30", offset: 0, limit: 200 })));
    expect(listProjectTimeEntries.mock.calls[listProjectTimeEntries.mock.calls.length - 1]![2]).not.toHaveProperty("task");
    expect(listProjectTimeEntries.mock.calls[listProjectTimeEntries.mock.calls.length - 1]![2]).not.toHaveProperty("milestone");

    await waitFor(() => expect(screen.getByText("Plan of selected scope").parentElement?.textContent).toMatch(/8 hours/u));
    expect(screen.getByText("Actual with filters").parentElement?.textContent).toMatch(/5 hours/u);
    // The plan line is NOT relabeled as filtered, and the comparable ratio is hidden.
    expect(screen.queryByText("Actual / plan")).toBeNull();
    expect(screen.getByText("Planned effort is not narrowed by person, category, state, or date filters.")).toBeTruthy();
    expect(screen.getByText("Hours after 2026-09-05").parentElement?.textContent).toContain("5 hours");
    expect(screen.getAllByText("Ada Report").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Regular work").length).toBeGreaterThan(0);
  });

  it("sources the plan from the workload track, not the primary track", async () => {
    // The task carries different effort_hours under `working` (primary, 10h) and `estimate` (workload, 25h).
    const task = { document: { schema: "gitpm/task@2", id: "T-26-WL", project: "P-26-1", title: "Workload task", type: "task", status: "done", lifecycle: "active", schedules: { working: { start: "2026-09-01", finish: "2026-09-30", effort_hours: 10 }, estimate: { start: "2026-09-01", finish: "2026-09-30", effort_hours: 25 } } }, path: "t.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const items = [
      { document: { schema: "gitpm/time-entry@1" as const, id: "E-26-WL", project: "P-26-1", task: task.document.id, person: "U-1", performed_on: "2026-09-10", hours: 4, category: "regular", created_at: "2026-09-10T00:00:00.000Z", state: "active" as const }, path: "e", blob_id: "a", draft_fingerprint: "f" },
    ];
    const listProjectTimeEntries = vi.fn(async () => ({ total: items.length, offset: 0, limit: 200, items }));
    const api = { listProjectTimeEntries } as unknown as GitPmApi;
    const projectDoc = project({ working: { finish: "2026-09-30" } }, { primary_track: "working", workload_track: "estimate", comparison_track: "forecast" });
    const { readModels, workloadTrack, comparisonFinish } = buildReportProps(projectDoc, [], [task], multiTrackScheduling);
    render(<ProjectActualReport api={api} comparisonFinish={comparisonFinish} draft={draft} locale="en" onNavigate={onNavigate} project={projectEntity(projectDoc)} projectId={String(projectDoc.id)} readModels={readModels} tasks={[task]} workloadTrack={workloadTrack} />);

    await waitFor(() => expect(screen.getByText("Plan of selected scope").parentElement?.textContent).toMatch(/25/u));
  });

  it("excludes voided time entries from the actual hour sum and the activity window", async () => {
    const task = { document: { schema: "gitpm/task@2", id: "T-26-VOID", project: "P-26-1", title: "Void task", type: "task", status: "done", lifecycle: "active" }, path: "t.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const items = [
      { document: { schema: "gitpm/time-entry@1" as const, id: "E-26-ACTIVE", project: "P-26-1", task: task.document.id, person: "U-1", performed_on: "2026-09-10", hours: 8, category: "regular", created_at: "2026-09-10T00:00:00.000Z", state: "active" as const }, path: "a", blob_id: "a", draft_fingerprint: "f" },
      { document: { schema: "gitpm/time-entry@1" as const, id: "E-26-VOID", project: "P-26-1", task: task.document.id, person: "U-1", performed_on: "2026-12-12", hours: 6, category: "regular", created_at: "2026-12-12T00:00:00.000Z", state: "voided" as const }, path: "v", blob_id: "a", draft_fingerprint: "f" },
    ];
    const listProjectTimeEntries = vi.fn(async () => ({ total: items.length, offset: 0, limit: 200, items }));
    const api = { listProjectTimeEntries } as unknown as GitPmApi;
    const projectDoc = project({ plan: { finish: "2026-09-30" }, target: { finish: "2026-09-15" } }, { primary_track: "plan", comparison_track: "target" });
    const { readModels, workloadTrack, comparisonFinish } = buildReportProps(projectDoc, [], [task], scheduling);
    render(<ProjectActualReport api={api} comparisonFinish={comparisonFinish} draft={draft} locale="en" onNavigate={onNavigate} project={projectEntity(projectDoc)} projectId={String(projectDoc.id)} readModels={readModels} tasks={[task]} workloadTrack={workloadTrack} />);

    await waitFor(() => expect(screen.getAllByText("Actual hours")[0]?.parentElement?.textContent).toMatch(/8 hours/u));
    expect(screen.getAllByText("Last activity")[0]?.parentElement?.textContent).toMatch(/Sep|10/);
    expect(screen.getAllByText("Last activity")[0]?.parentElement?.textContent).not.toMatch(/Dec/u);
    expect(screen.getAllByText("Active entries")[0]?.parentElement?.textContent).toMatch(/1/);
    expect(screen.getByText("Voided entries").parentElement?.textContent).toMatch(/1/);
  });

  it("§14.4: shows both an explicit project budget and the larger sum of top-level task estimates", async () => {
    // Workload track is `estimate`. The project declares an explicit 80h estimate; the two
    // root tasks together declare 708h. The report must surface BOTH, not pick one.
    const rootOne = { document: { schema: "gitpm/task@2", id: "T-26-R1", project: "P-26-1", title: "Root one", type: "task", status: "in-progress", lifecycle: "active", schedules: { estimate: { effort_hours: 400 } } }, path: "r1.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const rootTwo = { document: { schema: "gitpm/task@2", id: "T-26-R2", project: "P-26-1", title: "Root two", type: "task", status: "in-progress", lifecycle: "active", schedules: { estimate: { effort_hours: 308 } } }, path: "r2.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const listProjectTimeEntries = vi.fn(async () => ({ total: 0, offset: 0, limit: 200, items: [] }));
    const api = { listProjectTimeEntries } as unknown as GitPmApi;
    const projectDoc = project({ estimate: { effort_hours: 80 } }, { primary_track: "working", workload_track: "estimate", comparison_track: "forecast" });
    const { readModels, workloadTrack, comparisonFinish } = buildReportProps(projectDoc, [], [rootOne, rootTwo], multiTrackScheduling);
    render(<ProjectActualReport api={api} comparisonFinish={comparisonFinish} draft={draft} locale="en" onNavigate={onNavigate} project={projectEntity(projectDoc)} projectId={String(projectDoc.id)} readModels={readModels} tasks={[rootOne, rootTwo]} trackTitle={(slug) => multiTrackScheduling.trackTitle(slug)} workloadTrack={workloadTrack} />);

    await waitFor(() => expect(screen.getByText("Estimate of planned work").parentElement?.textContent).toMatch(/708 hours/u));
    expect(screen.getByText("Project budget").parentElement?.textContent).toMatch(/80 hours/u);
    expect(screen.getByText("Difference").parentElement?.textContent).toMatch(/628 hours/u);
    // The plan source mentions the explicit project budget AND the sum of top-level tasks.
    const sourceLine = screen.getByText("Planned estimate source:").parentElement?.textContent ?? "";
    expect(sourceLine).toContain("Explicit project estimate");
    expect(sourceLine).toContain("Sum of top-level tasks");
    // The track title appears in the explanation line (the raw slug is never interpolated).
    expect(sourceLine).toContain("Estimate");
  });

  it("§14.5: a parent with its own estimate keeps branch plan = own estimate (no double-count)", async () => {
    const parentTask = { document: { schema: "gitpm/task@2", id: "T-26-P", project: "P-26-1", title: "Parent", type: "task", status: "in-progress", lifecycle: "active", schedules: { estimate: { effort_hours: 80 } } }, path: "p.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const childOne = { document: { schema: "gitpm/task@2", id: "T-26-C1", project: "P-26-1", parent: "T-26-P", title: "Child one", type: "task", status: "in-progress", lifecycle: "active", schedules: { estimate: { effort_hours: 30 } } }, path: "c1.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const childTwo = { document: { schema: "gitpm/task@2", id: "T-26-C2", project: "P-26-1", parent: "T-26-P", title: "Child two", type: "task", status: "in-progress", lifecycle: "active", schedules: { estimate: { effort_hours: 50 } } }, path: "c2.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const listProjectTimeEntries = vi.fn(async () => ({ total: 0, offset: 0, limit: 200, items: [] }));
    const api = { listProjectTimeEntries } as unknown as GitPmApi;
    const projectDoc = project({}, { primary_track: "working", workload_track: "estimate", comparison_track: "forecast" });
    const { readModels, workloadTrack, comparisonFinish } = buildReportProps(projectDoc, [], [parentTask, childOne, childTwo], multiTrackScheduling);
    render(<ProjectActualReport api={api} comparisonFinish={comparisonFinish} draft={draft} locale="en" onNavigate={onNavigate} project={projectEntity(projectDoc)} projectId={String(projectDoc.id)} readModels={readModels} tasks={[parentTask, childOne, childTwo]} workloadTrack={workloadTrack} />);

    // Scope to the parent (with subtasks): branch plan must be 80, not 80+30+50=160.
    fireEvent.change(screen.getByLabelText("Task"), { target: { value: parentTask.document.id } });
    await waitFor(() => expect(screen.getByText("Plan of selected scope").parentElement?.textContent).toMatch(/80 hours/u));
    expect(screen.getByText("Plan of selected scope").parentElement?.textContent).not.toMatch(/160/u);

    // The table shows the parent's own estimate (80) and each child's own estimate (30, 50).
    const parentRow = document.querySelector<HTMLElement>(`tr[data-task-id="${parentTask.document.id}"]`)!;
    expect(parentRow.getAttribute("data-depth")).toBe("0");
    expect(parentRow.querySelector(".actual-report-task-link")?.textContent).toContain("Parent");
    const table = parentRow.closest("table")!;
    expect(within(table).getByText("Child one").closest("tr")?.getAttribute("data-depth")).toBe("1");
    expect(within(table).getByText("Child two").closest("tr")?.getAttribute("data-depth")).toBe("1");
    // Parent row plan cell (after the milestone column) holds 80, not 160.
    expect(parentRow.querySelectorAll("td")[1]?.textContent).toMatch(/80 hours/u);
    // Source label notes the explicit task estimate.
    expect(screen.getByText("Planned estimate source:").parentElement?.textContent).toContain("Explicit task estimate");
  });

  it("§14.6: a parent without its own estimate aggregates subtask estimates and labels the source accordingly", async () => {
    const parentTask = { document: { schema: "gitpm/task@2", id: "T-26-P", project: "P-26-1", title: "Parent", type: "task", status: "in-progress", lifecycle: "active" }, path: "p.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const childOne = { document: { schema: "gitpm/task@2", id: "T-26-C1", project: "P-26-1", parent: "T-26-P", title: "Child one", type: "task", status: "in-progress", lifecycle: "active", schedules: { estimate: { effort_hours: 30 } } }, path: "c1.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const childTwo = { document: { schema: "gitpm/task@2", id: "T-26-C2", project: "P-26-1", parent: "T-26-P", title: "Child two", type: "task", status: "in-progress", lifecycle: "active", schedules: { estimate: { effort_hours: 50 } } }, path: "c2.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const listProjectTimeEntries = vi.fn(async () => ({ total: 0, offset: 0, limit: 200, items: [] }));
    const api = { listProjectTimeEntries } as unknown as GitPmApi;
    const projectDoc = project({}, { primary_track: "working", workload_track: "estimate", comparison_track: "forecast" });
    const { readModels, workloadTrack, comparisonFinish } = buildReportProps(projectDoc, [], [parentTask, childOne, childTwo], multiTrackScheduling);
    render(<ProjectActualReport api={api} comparisonFinish={comparisonFinish} draft={draft} locale="en" onNavigate={onNavigate} project={projectEntity(projectDoc)} projectId={String(projectDoc.id)} readModels={readModels} tasks={[parentTask, childOne, childTwo]} workloadTrack={workloadTrack} />);

    fireEvent.change(screen.getByLabelText("Task"), { target: { value: parentTask.document.id } });
    await waitFor(() => expect(screen.getByText("Plan of selected scope").parentElement?.textContent).toMatch(/80 hours/u));
    expect(screen.getByText("Planned estimate source:").parentElement?.textContent).toContain("Sum of subtasks");
  });

  it("§14.7: branch actual rolls subtask records up while own actual stays direct, without doubling the project total", async () => {
    const parentTask = { document: { schema: "gitpm/task@2", id: "T-26-P", project: "P-26-1", title: "Parent", type: "task", status: "in-progress", lifecycle: "active" }, path: "p.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const childOne = { document: { schema: "gitpm/task@2", id: "T-26-C1", project: "P-26-1", parent: "T-26-P", title: "Child one", type: "task", status: "in-progress", lifecycle: "active" }, path: "c1.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const childTwo = { document: { schema: "gitpm/task@2", id: "T-26-C2", project: "P-26-1", parent: "T-26-P", title: "Child two", type: "task", status: "in-progress", lifecycle: "active" }, path: "c2.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const items = [
      { document: { schema: "gitpm/time-entry@1" as const, id: "E-1", project: "P-26-1", task: childOne.document.id, person: "U-1", performed_on: "2026-09-02", hours: 20, category: "regular", created_at: "2026-09-02T00:00:00.000Z", state: "active" as const }, path: "1", blob_id: "a", draft_fingerprint: "f" },
      { document: { schema: "gitpm/time-entry@1" as const, id: "E-2", project: "P-26-1", task: childTwo.document.id, person: "U-1", performed_on: "2026-09-03", hours: 30, category: "regular", created_at: "2026-09-03T00:00:00.000Z", state: "active" as const }, path: "2", blob_id: "a", draft_fingerprint: "f" },
    ];
    const listProjectTimeEntries = vi.fn(async () => ({ total: items.length, offset: 0, limit: 200, items }));
    const api = { listProjectTimeEntries } as unknown as GitPmApi;
    const projectDoc = project({}, { primary_track: "working", workload_track: "estimate", comparison_track: "forecast" });
    const { readModels, workloadTrack, comparisonFinish } = buildReportProps(projectDoc, [], [parentTask, childOne, childTwo], multiTrackScheduling);
    render(<ProjectActualReport api={api} comparisonFinish={comparisonFinish} draft={draft} locale="en" onNavigate={onNavigate} project={projectEntity(projectDoc)} projectId={String(projectDoc.id)} readModels={readModels} tasks={[parentTask, childOne, childTwo]} workloadTrack={workloadTrack} />);

    await waitFor(() => expect(screen.getAllByText("Actual hours")[0]?.parentElement?.textContent).toMatch(/50 hours/u));
    const parentRow = document.querySelector<HTMLElement>(`tr[data-task-id="${parentTask.document.id}"]`)!;
    // Columns: milestone, plan, actual(branch), own. Branch actual = 50; own = 0.
    expect(parentRow.querySelectorAll("td")[2]?.textContent).toMatch(/50 hours/u);
    expect(parentRow.querySelectorAll("td")[3]?.textContent).toMatch(/0 hours/u);
  });

  it("navigates to a task when a table row title is clicked", async () => {
    const task = { document: { schema: "gitpm/task@2", id: "T-26-NAV", project: "P-26-1", title: "Navigate me", type: "task", status: "in-progress", lifecycle: "active" }, path: "t.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const listProjectTimeEntries = vi.fn(async () => ({ total: 0, offset: 0, limit: 200, items: [] }));
    const api = { listProjectTimeEntries } as unknown as GitPmApi;
    const projectDoc = project({}, { primary_track: "plan", workload_track: "plan", comparison_track: "target" });
    const { readModels, workloadTrack, comparisonFinish } = buildReportProps(projectDoc, [], [task], scheduling);
    render(<ProjectActualReport api={api} comparisonFinish={comparisonFinish} draft={draft} locale="en" onNavigate={onNavigate} project={projectEntity(projectDoc)} projectId={String(projectDoc.id)} readModels={readModels} tasks={[task]} workloadTrack={workloadTrack} />);

    await waitFor(() => expect(screen.getByRole("button", { name: /Navigate me/u })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Navigate me/u }));
    expect(onNavigate).toHaveBeenCalledWith("tasks", { projectId: String(projectDoc.id), taskId: task.document.id });
  });

  it("renders the table in manual order with nesting rather than alphabetical order", async () => {
    // Manual order puts the parent (title "Zebra") before its child (title "Alpha"); an
    // alphabetical sort would reverse them. Both share the `estimate` workload track.
    const stage = { document: { schema: "gitpm/milestone@2", id: "M-26-ORDER", project: "P-26-1", name: "Ordering", lifecycle: "active", task_order: ["T-26-Z", "T-26-A"] }, path: "m.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const parentTask = { document: { schema: "gitpm/task@2", id: "T-26-Z", project: "P-26-1", milestone: "M-26-ORDER", title: "Zebra", type: "task", status: "in-progress", lifecycle: "active", schedules: { estimate: { effort_hours: 5 } } }, path: "z.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const childTask = { document: { schema: "gitpm/task@2", id: "T-26-A", project: "P-26-1", milestone: "M-26-ORDER", parent: "T-26-Z", title: "Alpha", type: "task", status: "in-progress", lifecycle: "active", schedules: { estimate: { effort_hours: 3 } } }, path: "a.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const listProjectTimeEntries = vi.fn(async () => ({ total: 0, offset: 0, limit: 200, items: [] }));
    const api = { listProjectTimeEntries } as unknown as GitPmApi;
    const projectDoc = project({}, { primary_track: "working", workload_track: "estimate", comparison_track: "forecast" });
    const { readModels, workloadTrack, comparisonFinish } = buildReportProps(projectDoc, [stage], [parentTask, childTask], multiTrackScheduling);
    render(<ProjectActualReport api={api} comparisonFinish={comparisonFinish} draft={draft} locale="en" milestones={[stage]} onNavigate={onNavigate} project={projectEntity(projectDoc)} projectId={String(projectDoc.id)} readModels={readModels} tasks={[parentTask, childTask]} workloadTrack={workloadTrack} />);

    await waitFor(() => expect(screen.getByText("Zebra")).toBeTruthy());
    const parentRow = document.querySelector<HTMLElement>(`tr[data-task-id="${parentTask.document.id}"]`)!;
    const childRow = document.querySelector<HTMLElement>(`tr[data-task-id="${childTask.document.id}"]`)!;
    expect(parentRow.getAttribute("data-depth")).toBe("0");
    expect(childRow.getAttribute("data-depth")).toBe("1");
    // Parent appears before child in DOM order (manual order, not alphabetical).
    expect(parentRow.compareDocumentPosition(childRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });
});
