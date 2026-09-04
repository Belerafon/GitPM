// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSchedulingHierarchy, type SchedulingHierarchyTask } from "@gitpm/scheduling";
import { ProjectActualReport } from "./project-actual-report.js";
import { ScheduleResolver, scheduleTracksConfig } from "../../schedules.js";
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
  return { readModels: hierarchy.readModels, workloadTrack };
};

afterEach(() => { cleanup(); onNavigate.mockClear(); });

describe("ProjectActualReport", () => {
  it("aggregates actual hours, last activity, and hours-after across more than one page", async () => {
    const items = Array.from({ length: 201 }, (_, index) => ({ document: { schema: "gitpm/time-entry@1" as const, id: `E-${index}`, project: "P-26-1", task: "T-1", person: "U-1", performed_on: index === 200 ? "2026-04-01" : "2026-03-01", hours: index === 200 ? 3.5 : 1, category: "warranty", created_at: "2026-04-01T00:00:00.000Z", state: "active" as const }, path: `p-${index}`, blob_id: "a", draft_fingerprint: "f" }));
    const listProjectTimeEntries = vi.fn(async (_draftId: string, _projectId: string, filters?: { readonly offset?: number; readonly limit?: number }) => {
      const offset = filters?.offset ?? 0; const limit = filters?.limit ?? 200;
      return { total: items.length, offset, limit, items: items.slice(offset, offset + limit) };
    });
    const api = { listProjectTimeEntries, listTimeEntries: vi.fn() };
    const task = { document: { schema: "gitpm/task@2", id: "T-1", project: "P-26-1", title: "T", type: "task", status: "done", lifecycle: "active" }, path: "t.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const projectDoc = project({ plan: { finish: "2026-03-20" }, target: { finish: "2026-02-28" } }, { primary_track: "plan", comparison_track: "target" });
    const { readModels, workloadTrack } = buildReportProps(projectDoc, [], [task], scheduling);
    render(<ProjectActualReport api={api} draft={draft} locale="en" onNavigate={onNavigate} project={projectEntity(projectDoc)} projectId={String(projectDoc.id)} readModels={readModels} tasks={[task]} workloadTrack={workloadTrack} />);
    // "Actual hours" appears in both the activity summary and the plan/actual block; the
    // activity summary is the first one in DOM order.
    await waitFor(() => expect(screen.getAllByText("Actual hours")[0]?.parentElement?.textContent).toMatch(/203\.5/));
    expect(screen.getAllByText("Last activity")[0]?.parentElement?.textContent).toContain("Apr");
    fireEvent.change(screen.getByLabelText("Hours after date"), { target: { value: "2026-02-28" } });
    expect(screen.getByText("Hours after 2026-02-28").parentElement?.textContent).toMatch(/203\.5/);
    expect(screen.getByText("Actual hours report")).toBeTruthy();
    // Two independent paginated requests fire on mount: the full historical index (Request A)
    // and the filtered display records (Request B). Both paginate past the 200-item first page.
    expect(listProjectTimeEntries.mock.calls.map((call) => call[2]?.offset)).toEqual([0, 0, 200, 200]);
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
    const api = { listProjectTimeEntries };
    const projectDoc = project({ plan: { start: "2026-09-01", finish: "2026-09-30" } }, { enabled_tracks: ["plan", "actual"], primary_track: "plan", workload_track: "plan", dashboard_tracks: ["plan", "actual"] });
    const { readModels, workloadTrack } = buildReportProps(projectDoc, [milestone], [taskOne, taskTwo], scheduling);
    render(<ProjectActualReport api={api} categories={[{ slug: "regular", title: "Regular work" }, { slug: "support", title: "Support" }]} draft={draft} locale="en" milestones={[milestone]} onNavigate={onNavigate} people={[person]} project={projectEntity(projectDoc)} projectId={String(projectDoc.id)} readModels={readModels} tasks={[taskOne, taskTwo]} workloadTrack={workloadTrack} />);

    fireEvent.change(screen.getByLabelText("Task"), { target: { value: taskOne.document.id } });
    fireEvent.change(screen.getByLabelText("Person"), { target: { value: person.document.id } });
    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "regular" } });
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
    const api = { listProjectTimeEntries };
    const projectDoc = project({ working: { finish: "2026-09-30" } }, { primary_track: "working", workload_track: "estimate", comparison_track: "forecast" });
    const { readModels, workloadTrack } = buildReportProps(projectDoc, [], [task], multiTrackScheduling);
    render(<ProjectActualReport api={api} draft={draft} locale="en" onNavigate={onNavigate} project={projectEntity(projectDoc)} projectId={String(projectDoc.id)} readModels={readModels} tasks={[task]} workloadTrack={workloadTrack} />);

    await waitFor(() => expect(screen.getByText("Plan of selected scope").parentElement?.textContent).toMatch(/25/u));
  });

  it("defaults to active records: requests state=active and hides the voided count from the main summary", async () => {
    const task = { document: { schema: "gitpm/task@2", id: "T-26-ACTIVE-DEFAULT", project: "P-26-1", title: "Default task", type: "task", status: "done", lifecycle: "active" }, path: "t.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const items = [
      { document: { schema: "gitpm/time-entry@1" as const, id: "E-26-ACTIVE-DEFAULT", project: "P-26-1", task: task.document.id, person: "U-1", performed_on: "2026-09-10", hours: 8, category: "regular", created_at: "2026-09-10T00:00:00.000Z", state: "active" as const }, path: "a", blob_id: "a", draft_fingerprint: "f" },
      { document: { schema: "gitpm/time-entry@1" as const, id: "E-26-VOID-DEFAULT", project: "P-26-1", task: task.document.id, person: "U-1", performed_on: "2026-12-12", hours: 6, category: "regular", created_at: "2026-12-12T00:00:00.000Z", state: "voided" as const }, path: "v", blob_id: "a", draft_fingerprint: "f" },
    ];
    const listProjectTimeEntries = vi.fn(async (_draftId: string, _projectId: string, filters: Record<string, unknown> = {}) => {
      const filtered = items.filter((item) => item.document.state === String(filters.state ?? item.document.state));
      return { total: filtered.length, offset: Number(filters.offset ?? 0), limit: Number(filters.limit ?? 200), items: filtered };
    });
    const api = { listProjectTimeEntries };
    const projectDoc = project({ plan: { finish: "2026-09-30" } }, { primary_track: "plan", workload_track: "plan", comparison_track: "target" });
    const { readModels, workloadTrack } = buildReportProps(projectDoc, [], [task], scheduling);
    render(<ProjectActualReport api={api} draft={draft} locale="en" onNavigate={onNavigate} project={projectEntity(projectDoc)} projectId={String(projectDoc.id)} readModels={readModels} tasks={[task]} workloadTrack={workloadTrack} />);

    // Default request narrows to active records only.
    await waitFor(() => expect(listProjectTimeEntries).toHaveBeenLastCalledWith("DRF", "P-26-1", expect.objectContaining({ state: "active", offset: 0, limit: 200 })));
    // Main summary reflects active-only data: actual hours = 8, active entries = 1.
    await waitFor(() => expect(screen.getAllByText("Actual hours")[0]?.parentElement?.textContent).toMatch(/8 hours/u));
    expect(screen.getAllByText("Active entries")[0]?.parentElement?.textContent).toMatch(/1/u);
    // The voided-count label is not part of the main summary.
    const summary = document.querySelector<HTMLElement>(".actual-report-summary")!;
    expect(summary.textContent ?? "").not.toMatch(/Cancelled time entries/u);
    // With no voided records fetched, the correction-history count block is absent.
    expect(screen.queryByText("Correction history")).toBeNull();
    expect(screen.queryByText("Cancelled time entries")).toBeNull();
  });

  it("§11.5: toggling 'Show cancelled entries' fetches all states and surfaces the voided count in a separate correction-history area", async () => {
    const task = { document: { schema: "gitpm/task@2", id: "T-26-VOID", project: "P-26-1", title: "Void task", type: "task", status: "done", lifecycle: "active" }, path: "t.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const items = [
      { document: { schema: "gitpm/time-entry@1" as const, id: "E-26-ACTIVE", project: "P-26-1", task: task.document.id, person: "U-1", performed_on: "2026-09-10", hours: 8, category: "regular", created_at: "2026-09-10T00:00:00.000Z", state: "active" as const }, path: "a", blob_id: "a", draft_fingerprint: "f" },
      { document: { schema: "gitpm/time-entry@1" as const, id: "E-26-VOID", project: "P-26-1", task: task.document.id, person: "U-1", performed_on: "2026-12-12", hours: 6, category: "regular", created_at: "2026-12-12T00:00:00.000Z", state: "voided" as const }, path: "v", blob_id: "a", draft_fingerprint: "f" },
    ];
    const listProjectTimeEntries = vi.fn(async (_draftId: string, _projectId: string, filters: Record<string, unknown> = {}) => {
      const filtered = items.filter((item) => item.document.state === String(filters.state ?? item.document.state));
      return { total: filtered.length, offset: Number(filters.offset ?? 0), limit: Number(filters.limit ?? 200), items: filtered };
    });
    const api = { listProjectTimeEntries };
    const projectDoc = project({ plan: { finish: "2026-09-30" }, target: { finish: "2026-09-15" } }, { primary_track: "plan", comparison_track: "target" });
    const { readModels, workloadTrack } = buildReportProps(projectDoc, [], [task], scheduling);
    render(<ProjectActualReport api={api} draft={draft} locale="en" onNavigate={onNavigate} project={projectEntity(projectDoc)} projectId={String(projectDoc.id)} readModels={readModels} tasks={[task]} workloadTrack={workloadTrack} />);

    // By default only the active record is fetched; main summary "Actual hours" = 8 (not 14).
    await waitFor(() => expect(screen.getAllByText("Actual hours")[0]?.parentElement?.textContent).toMatch(/8 hours/u));
    expect(screen.getAllByText("Active entries")[0]?.parentElement?.textContent).toMatch(/1/u);
    expect(screen.queryByText("Correction history")).toBeNull();

    // Toggle the always-visible "Show cancelled entries" control.
    fireEvent.click(screen.getByRole("checkbox", { name: /Show cancelled entries/u }));
    // The next request must NOT constrain state (fetches all states).
    await waitFor(() => expect(listProjectTimeEntries).toHaveBeenLastCalledWith("DRF", "P-26-1", expect.objectContaining({ offset: 0, limit: 200 })));
    expect(listProjectTimeEntries.mock.calls[listProjectTimeEntries.mock.calls.length - 1]![2]).not.toHaveProperty("state");

    // The correction-history area now surfaces the voided entry details (not just a count).
    await waitFor(() => expect(screen.getByText("Correction history")).toBeTruthy());
    const history = screen.getByText("Correction history").closest("section")!;
    expect(history.textContent).toContain("Kept in history, but its hours are excluded from totals.");
    expect(history.textContent).toContain("Void task");
    expect(history.textContent).toMatch(/6 hours/u);
    fireEvent.click(within(history).getByRole("button", { name: "Void task" }));
    expect(onNavigate).toHaveBeenCalledWith("tasks", { projectId: "P-26-1", taskId: task.document.id });
    fireEvent.click(within(history).getByRole("button", { name: /U-1/u }));
    expect(onNavigate).toHaveBeenCalledWith("people", { personId: "U-1" });
    // The main summary still excludes the voided count.
    expect(document.querySelector(".actual-report-summary")!.textContent ?? "").not.toMatch(/Cancelled time entries/u);
    // sumHours still ignores voided: actual hours stay at 8.
    expect(screen.getAllByText("Actual hours")[0]?.parentElement?.textContent).toMatch(/8 hours/u);
  });

  it("§11.4: uses reworded 'Отменённ*' copy in Russian and never renders 'Аннулирован'", async () => {
    const task = { document: { schema: "gitpm/task@2", id: "T-26-RU", project: "P-26-1", title: "Russian copy task", type: "task", status: "done", lifecycle: "active" }, path: "t.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const items = [
      { document: { schema: "gitpm/time-entry@1" as const, id: "E-26-RU-ACTIVE", project: "P-26-1", task: task.document.id, person: "U-1", performed_on: "2026-09-10", hours: 5, category: "regular", created_at: "2026-09-10T00:00:00.000Z", state: "active" as const }, path: "a", blob_id: "a", draft_fingerprint: "f" },
      { document: { schema: "gitpm/time-entry@1" as const, id: "E-26-RU-VOID", project: "P-26-1", task: task.document.id, person: "U-1", performed_on: "2026-12-12", hours: 4, category: "regular", created_at: "2026-12-12T00:00:00.000Z", state: "voided" as const }, path: "v", blob_id: "a", draft_fingerprint: "f" },
    ];
    const listProjectTimeEntries = vi.fn(async (_draftId: string, _projectId: string, filters: Record<string, unknown> = {}) => {
      const filtered = items.filter((item) => item.document.state === String(filters.state ?? item.document.state));
      return { total: filtered.length, offset: Number(filters.offset ?? 0), limit: Number(filters.limit ?? 200), items: filtered };
    });
    const api = { listProjectTimeEntries };
    const projectDoc = project({ plan: { finish: "2026-09-30" } }, { primary_track: "plan", workload_track: "plan", comparison_track: "target" });
    const { readModels, workloadTrack } = buildReportProps(projectDoc, [], [task], scheduling);
    const { container } = render(<ProjectActualReport api={api} draft={draft} locale="ru" onNavigate={onNavigate} project={projectEntity(projectDoc)} projectId={String(projectDoc.id)} readModels={readModels} tasks={[task]} workloadTrack={workloadTrack} />);

    // Toggle so the voided record loads and the correction-history area renders.
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /Показывать отменённые записи/u })).toBeTruthy());
    fireEvent.click(screen.getByRole("checkbox", { name: /Показывать отменённые записи/u }));
    await waitFor(() => expect(screen.getByText("История исправлений")).toBeTruthy());

    // The old "Аннулирован*" wording must not appear anywhere in the rendered DOM.
    expect(container.textContent ?? "").not.toMatch(/Аннулирован/u);
    // The new "Отменённ*" wording is present (here in the show-voided control and history).
    expect(container.textContent ?? "").toMatch(/отменённ/iu);
  });

  it("§14.4: shows both an explicit project budget and the larger sum of top-level task estimates", async () => {
    // Workload track is `estimate`. The project declares an explicit 80h estimate; the two
    // root tasks together declare 708h. The report must surface BOTH, not pick one.
    const rootOne = { document: { schema: "gitpm/task@2", id: "T-26-R1", project: "P-26-1", title: "Root one", type: "task", status: "in-progress", lifecycle: "active", schedules: { estimate: { effort_hours: 400 } } }, path: "r1.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const rootTwo = { document: { schema: "gitpm/task@2", id: "T-26-R2", project: "P-26-1", title: "Root two", type: "task", status: "in-progress", lifecycle: "active", schedules: { estimate: { effort_hours: 308 } } }, path: "r2.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const listProjectTimeEntries = vi.fn(async () => ({ total: 0, offset: 0, limit: 200, items: [] }));
    const api = { listProjectTimeEntries };
    const projectDoc = project({ estimate: { effort_hours: 80 } }, { primary_track: "working", workload_track: "estimate", comparison_track: "forecast" });
    const { readModels, workloadTrack } = buildReportProps(projectDoc, [], [rootOne, rootTwo], multiTrackScheduling);
    render(<ProjectActualReport api={api} draft={draft} locale="en" onNavigate={onNavigate} project={projectEntity(projectDoc)} projectId={String(projectDoc.id)} readModels={readModels} tasks={[rootOne, rootTwo]} trackTitle={(slug) => multiTrackScheduling.trackTitle(slug)} workloadTrack={workloadTrack} />);

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
    const api = { listProjectTimeEntries };
    const projectDoc = project({}, { primary_track: "working", workload_track: "estimate", comparison_track: "forecast" });
    const { readModels, workloadTrack } = buildReportProps(projectDoc, [], [parentTask, childOne, childTwo], multiTrackScheduling);
    render(<ProjectActualReport api={api} draft={draft} locale="en" onNavigate={onNavigate} project={projectEntity(projectDoc)} projectId={String(projectDoc.id)} readModels={readModels} tasks={[parentTask, childOne, childTwo]} workloadTrack={workloadTrack} />);

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
    // Parent row plan cell (the milestone column is gone, so plan is the first td).
    expect(parentRow.querySelectorAll("td")[0]?.textContent).toMatch(/80 hours/u);
    // Source label notes the explicit task estimate.
    expect(screen.getByText("Planned estimate source:").parentElement?.textContent).toContain("Explicit task estimate");
  });

  it("§14.6: a parent without its own estimate aggregates subtask estimates and labels the source accordingly", async () => {
    const parentTask = { document: { schema: "gitpm/task@2", id: "T-26-P", project: "P-26-1", title: "Parent", type: "task", status: "in-progress", lifecycle: "active" }, path: "p.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const childOne = { document: { schema: "gitpm/task@2", id: "T-26-C1", project: "P-26-1", parent: "T-26-P", title: "Child one", type: "task", status: "in-progress", lifecycle: "active", schedules: { estimate: { effort_hours: 30 } } }, path: "c1.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const childTwo = { document: { schema: "gitpm/task@2", id: "T-26-C2", project: "P-26-1", parent: "T-26-P", title: "Child two", type: "task", status: "in-progress", lifecycle: "active", schedules: { estimate: { effort_hours: 50 } } }, path: "c2.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const listProjectTimeEntries = vi.fn(async () => ({ total: 0, offset: 0, limit: 200, items: [] }));
    const api = { listProjectTimeEntries };
    const projectDoc = project({}, { primary_track: "working", workload_track: "estimate", comparison_track: "forecast" });
    const { readModels, workloadTrack } = buildReportProps(projectDoc, [], [parentTask, childOne, childTwo], multiTrackScheduling);
    render(<ProjectActualReport api={api} draft={draft} locale="en" onNavigate={onNavigate} project={projectEntity(projectDoc)} projectId={String(projectDoc.id)} readModels={readModels} tasks={[parentTask, childOne, childTwo]} workloadTrack={workloadTrack} />);

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
    const api = { listProjectTimeEntries };
    const projectDoc = project({}, { primary_track: "working", workload_track: "estimate", comparison_track: "forecast" });
    const { readModels, workloadTrack } = buildReportProps(projectDoc, [], [parentTask, childOne, childTwo], multiTrackScheduling);
    render(<ProjectActualReport api={api} draft={draft} locale="en" onNavigate={onNavigate} project={projectEntity(projectDoc)} projectId={String(projectDoc.id)} readModels={readModels} tasks={[parentTask, childOne, childTwo]} workloadTrack={workloadTrack} />);

    await waitFor(() => expect(screen.getAllByText("Actual hours")[0]?.parentElement?.textContent).toMatch(/50 hours/u));
    const parentRow = document.querySelector<HTMLElement>(`tr[data-task-id="${parentTask.document.id}"]`)!;
    // Columns (milestone column removed): plan, actual(branch), own. Branch actual = 50; own = 0.
    expect(parentRow.querySelectorAll("td")[1]?.textContent).toMatch(/50 hours/u);
    expect(parentRow.querySelectorAll("td")[2]?.textContent).toMatch(/0 hours/u);
  });

  it("navigates to a task when a table row title is clicked", async () => {
    const task = { document: { schema: "gitpm/task@2", id: "T-26-NAV", project: "P-26-1", title: "Navigate me", type: "task", status: "in-progress", lifecycle: "active", schedules: { plan: { effort_hours: 5 } } }, path: "t.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const listProjectTimeEntries = vi.fn(async () => ({ total: 0, offset: 0, limit: 200, items: [] }));
    const api = { listProjectTimeEntries };
    const projectDoc = project({}, { primary_track: "plan", workload_track: "plan", comparison_track: "target" });
    const { readModels, workloadTrack } = buildReportProps(projectDoc, [], [task], scheduling);
    render(<ProjectActualReport api={api} draft={draft} locale="en" onNavigate={onNavigate} project={projectEntity(projectDoc)} projectId={String(projectDoc.id)} readModels={readModels} tasks={[task]} workloadTrack={workloadTrack} />);

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
    const api = { listProjectTimeEntries };
    const projectDoc = project({}, { primary_track: "working", workload_track: "estimate", comparison_track: "forecast" });
    const { readModels, workloadTrack } = buildReportProps(projectDoc, [stage], [parentTask, childTask], multiTrackScheduling);
    render(<ProjectActualReport api={api} draft={draft} locale="en" milestones={[stage]} onNavigate={onNavigate} project={projectEntity(projectDoc)} projectId={String(projectDoc.id)} readModels={readModels} tasks={[parentTask, childTask]} workloadTrack={workloadTrack} />);

    await waitFor(() => expect(document.querySelector(`tr[data-task-id="${parentTask.document.id}"]`)).not.toBeNull());
    const parentRow = document.querySelector<HTMLElement>(`tr[data-task-id="${parentTask.document.id}"]`)!;
    const childRow = document.querySelector<HTMLElement>(`tr[data-task-id="${childTask.document.id}"]`)!;
    expect(parentRow.getAttribute("data-depth")).toBe("0");
    expect(childRow.getAttribute("data-depth")).toBe("1");
    // Parent appears before child in DOM order (manual order, not alphabetical).
    expect(parentRow.compareDocumentPosition(childRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("keeps the selected task when switching back to All milestones", async () => {
    const milestone = { document: { schema: "gitpm/milestone@2", id: "M-26-KEEP", project: "P-26-1", name: "Keep", lifecycle: "active" }, path: "m.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const taskOne = { document: { schema: "gitpm/task@2", id: "T-26-KEEP", project: "P-26-1", milestone: milestone.document.id, title: "Keep task", type: "task", status: "done", lifecycle: "active", schedules: { plan: { effort_hours: 5 } } }, path: "t.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const listProjectTimeEntries = vi.fn(async () => ({ total: 0, offset: 0, limit: 200, items: [] }));
    const api = { listProjectTimeEntries };
    const projectDoc = project({}, { primary_track: "plan", workload_track: "plan", comparison_track: "target" });
    const { readModels, workloadTrack } = buildReportProps(projectDoc, [milestone], [taskOne], scheduling);
    render(<ProjectActualReport api={api} draft={draft} locale="en" milestones={[milestone]} onNavigate={onNavigate} project={projectEntity(projectDoc)} projectId={String(projectDoc.id)} readModels={readModels} tasks={[taskOne]} workloadTrack={workloadTrack} />);

    const taskSelect = await screen.findByLabelText("Task") as HTMLSelectElement;
    fireEvent.change(taskSelect, { target: { value: taskOne.document.id } });
    expect(taskSelect.value).toBe(taskOne.document.id);
    // Switching the milestone filter back to "All milestones" must NOT discard the task.
    fireEvent.change(screen.getByLabelText("Milestone"), { target: { value: "" } });
    expect((screen.getByLabelText("Task") as HTMLSelectElement).value).toBe(taskOne.document.id);
  });

  it("auto-selects a task's milestone when the task is chosen from the list", async () => {
    const milestoneA = { document: { schema: "gitpm/milestone@2", id: "M-26-A", project: "P-26-1", name: "Stage A", lifecycle: "active" }, path: "a.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const taskInA = { document: { schema: "gitpm/task@2", id: "T-26-INA", project: "P-26-1", milestone: milestoneA.document.id, title: "In A", type: "task", status: "in-progress", lifecycle: "active", schedules: { plan: { effort_hours: 5 } } }, path: "ina.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const orphan = { document: { schema: "gitpm/task@2", id: "T-26-ORPHAN", project: "P-26-1", title: "Orphan", type: "task", status: "in-progress", lifecycle: "active", schedules: { plan: { effort_hours: 2 } } }, path: "orphan.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const listProjectTimeEntries = vi.fn(async () => ({ total: 0, offset: 0, limit: 200, items: [] }));
    const api = { listProjectTimeEntries };
    const projectDoc = project({}, { primary_track: "plan", workload_track: "plan", comparison_track: "target" });
    const { readModels, workloadTrack } = buildReportProps(projectDoc, [milestoneA], [taskInA, orphan], scheduling);
    render(<ProjectActualReport api={api} draft={draft} locale="en" milestones={[milestoneA]} onNavigate={onNavigate} project={projectEntity(projectDoc)} projectId={String(projectDoc.id)} readModels={readModels} tasks={[taskInA, orphan]} workloadTrack={workloadTrack} />);

    await screen.findByLabelText("Task");
    // From the default "All milestones" view both tasks are listed; selecting the orphan
    // routes the milestone filter to the dedicated outside-active-milestones group.
    fireEvent.change(screen.getByLabelText("Task"), { target: { value: orphan.document.id } });
    expect((screen.getByLabelText("Milestone") as HTMLSelectElement).value).toBe("none");
    // Re-expanding to "All milestones" keeps the selected task and re-lists every task...
    fireEvent.change(screen.getByLabelText("Milestone"), { target: { value: "" } });
    expect((screen.getByLabelText("Task") as HTMLSelectElement).value).toBe(orphan.document.id);
    // ...so a task inside an active milestone can be picked, which auto-selects that milestone.
    fireEvent.change(screen.getByLabelText("Task"), { target: { value: taskInA.document.id } });
    expect((screen.getByLabelText("Milestone") as HTMLSelectElement).value).toBe(milestoneA.document.id);
  });

  it("narrows the task dropdown to the selected milestone and resets an incompatible task", async () => {
    const milestoneA = { document: { schema: "gitpm/milestone@2", id: "M-26-A", project: "P-26-1", name: "Stage A", lifecycle: "active" }, path: "a.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const milestoneB = { document: { schema: "gitpm/milestone@2", id: "M-26-B", project: "P-26-1", name: "Stage B", lifecycle: "active" }, path: "b.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const taskInA = { document: { schema: "gitpm/task@2", id: "T-26-INA", project: "P-26-1", milestone: milestoneA.document.id, title: "In A", type: "task", status: "in-progress", lifecycle: "active", schedules: { plan: { effort_hours: 5 } } }, path: "ina.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const taskInB = { document: { schema: "gitpm/task@2", id: "T-26-INB", project: "P-26-1", milestone: milestoneB.document.id, title: "In B", type: "task", status: "in-progress", lifecycle: "active", schedules: { plan: { effort_hours: 5 } } }, path: "inb.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const orphan = { document: { schema: "gitpm/task@2", id: "T-26-ORPHAN", project: "P-26-1", title: "Orphan", type: "task", status: "in-progress", lifecycle: "active", schedules: { plan: { effort_hours: 2 } } }, path: "orphan.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const listProjectTimeEntries = vi.fn(async () => ({ total: 0, offset: 0, limit: 200, items: [] }));
    const api = { listProjectTimeEntries };
    const projectDoc = project({}, { primary_track: "plan", workload_track: "plan", comparison_track: "target" });
    const { readModels, workloadTrack } = buildReportProps(projectDoc, [milestoneA, milestoneB], [taskInA, taskInB, orphan], scheduling);
    render(<ProjectActualReport api={api} draft={draft} locale="en" milestones={[milestoneA, milestoneB]} onNavigate={onNavigate} project={projectEntity(projectDoc)} projectId={String(projectDoc.id)} readModels={readModels} tasks={[taskInA, taskInB, orphan]} workloadTrack={workloadTrack} />);

    const taskSelect = await screen.findByLabelText("Task") as HTMLSelectElement;
    // By default every task is offered, grouped by stage with the orphans in their own group.
    expect(Array.from(taskSelect.options).some((option) => option.value === taskInA.document.id)).toBe(true);
    expect(Array.from(taskSelect.options).some((option) => option.value === taskInB.document.id)).toBe(true);
    expect(Array.from(taskSelect.options).some((option) => option.value === orphan.document.id)).toBe(true);
    expect(Array.from(taskSelect.querySelectorAll("optgroup")).map((group) => group.getAttribute("label"))).toEqual(["Stage A", "Stage B", "Without active milestone"]);

    // Selecting task A narrows the milestone and the dropdown to Stage A only.
    fireEvent.change(taskSelect, { target: { value: taskInA.document.id } });
    const narrowed = screen.getByLabelText("Task") as HTMLSelectElement;
    expect(Array.from(narrowed.options).some((option) => option.value === taskInA.document.id)).toBe(true);
    expect(Array.from(narrowed.options).some((option) => option.value === taskInB.document.id)).toBe(false);
    expect(Array.from(narrowed.options).some((option) => option.value === orphan.document.id)).toBe(false);

    // Switching the milestone to Stage B resets the now-incompatible task and shows only Stage B tasks.
    fireEvent.change(screen.getByLabelText("Milestone"), { target: { value: milestoneB.document.id } });
    const stageB = screen.getByLabelText("Task") as HTMLSelectElement;
    expect(stageB.value).toBe("");
    expect(Array.from(stageB.options).some((option) => option.value === taskInB.document.id)).toBe(true);
    expect(Array.from(stageB.options).some((option) => option.value === taskInA.document.id)).toBe(false);

    // The "outside active milestones" milestone option narrows the dropdown to orphans only.
    fireEvent.change(screen.getByLabelText("Milestone"), { target: { value: "none" } });
    const orphanScope = screen.getByLabelText("Task") as HTMLSelectElement;
    expect(Array.from(orphanScope.options).some((option) => option.value === orphan.document.id)).toBe(true);
    expect(Array.from(orphanScope.options).some((option) => option.value === taskInA.document.id)).toBe(false);
    expect(Array.from(orphanScope.options).some((option) => option.value === taskInB.document.id)).toBe(false);
  });

  it("reset clears filters, scope mode, cutoff and the show-cancelled toggle", async () => {
    const taskOne = { document: { schema: "gitpm/task@2", id: "T-26-RST", project: "P-26-1", title: "Reset task", type: "task", status: "done", lifecycle: "active", schedules: { plan: { effort_hours: 5 } } }, path: "t.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const items = [
      { document: { schema: "gitpm/time-entry@1" as const, id: "E-26-RST-V", project: "P-26-1", task: taskOne.document.id, person: "U-1", performed_on: "2026-09-10", hours: 4, category: "regular", created_at: "2026-09-10T00:00:00.000Z", state: "voided" as const }, path: "v", blob_id: "a", draft_fingerprint: "f" },
    ];
    const listProjectTimeEntries = vi.fn(async (_d: string, _p: string, filters: Record<string, unknown> = {}) => {
      const all = [{ document: { schema: "gitpm/time-entry@1" as const, id: "E-26-RST-A", project: "P-26-1", task: taskOne.document.id, person: "U-1", performed_on: "2026-09-09", hours: 3, category: "regular", created_at: "2026-09-09T00:00:00.000Z", state: "active" as const }, path: "a", blob_id: "a", draft_fingerprint: "f" }, ...items];
      const filtered = all.filter((entry) => entry.document.state === String(filters.state ?? entry.document.state));
      return { total: filtered.length, offset: 0, limit: 200, items: filtered };
    });
    const api = { listProjectTimeEntries };
    const projectDoc = project({}, { primary_track: "plan", workload_track: "plan", comparison_track: "target" });
    const { readModels, workloadTrack } = buildReportProps(projectDoc, [], [taskOne], scheduling);
    render(<ProjectActualReport api={api} draft={draft} locale="en" onNavigate={onNavigate} project={projectEntity(projectDoc)} projectId={String(projectDoc.id)} readModels={readModels} tasks={[taskOne]} workloadTrack={workloadTrack} />);

    const voidedCheckbox = await screen.findByRole("checkbox", { name: /Show cancelled entries/u });
    fireEvent.click(voidedCheckbox);
    await waitFor(() => expect(screen.getByText("Correction history")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    await waitFor(() => expect((screen.getByRole("checkbox", { name: /Show cancelled entries/u }) as HTMLInputElement).checked).toBe(false));
    expect(screen.queryByText("Correction history")).toBeNull();
  });

  it("labels archived tasks and archived people with their names instead of technical ids", async () => {
    const archivedPerson = { document: { schema: "gitpm/person@1", id: "U-ARCH", name: "Ivan Petrov", lifecycle: "archived" } } as EntityResult;
    const archivedTask = { document: { schema: "gitpm/task@2", id: "T-ARCH", project: "P-26-1", title: "Legacy task", type: "task", status: "done", lifecycle: "archived" } } as EntityResult;
    const items = [{ document: { schema: "gitpm/time-entry@1" as const, id: "E-1", project: "P-26-1", task: "T-ARCH", person: "U-ARCH", performed_on: "2026-05-01", hours: 5, category: "regular", created_at: "2026-05-01T00:00:00.000Z", state: "active" as const }, path: "1", blob_id: "a", draft_fingerprint: "f" }];
    const listProjectTimeEntries = vi.fn(async () => ({ total: items.length, offset: 0, limit: 200, items }));
    const api = { listProjectTimeEntries, listTimeEntries: vi.fn() };
    const projectDoc = project({}, { primary_track: "working", workload_track: "estimate" });
    const { readModels, workloadTrack } = buildReportProps(projectDoc, [], [archivedTask], multiTrackScheduling);
    render(<ProjectActualReport api={api} draft={draft} locale="en" onNavigate={onNavigate} people={[archivedPerson]} project={projectEntity(projectDoc)} projectId={String(projectDoc.id)} readModels={readModels} tasks={[archivedTask]} workloadTrack={workloadTrack} />);

    await waitFor(() => expect(document.querySelector('tr[data-task-id="T-ARCH"]')).not.toBeNull());
    const archivedRow = document.querySelector('tr[data-task-id="T-ARCH"]') as HTMLElement;
    expect(archivedRow.textContent).toContain("Archived task");
    expect(archivedRow.textContent).toContain("T-ARCH");
    expect(screen.getAllByText("Ivan Petrov (archived)").length).toBeGreaterThan(0);
    expect(screen.queryByText("U-ARCH")).toBeNull();
  });

  it("hides archived tasks that have no historical time records so they cannot inflate the current estimate", async () => {
    const archivedTask = { document: { schema: "gitpm/task@2", id: "T-ARCH-EMPTY", project: "P-26-1", title: "Ghost legacy", type: "task", status: "done", lifecycle: "archived", schedules: { estimate: { effort_hours: 99 } } }, path: "g.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const listProjectTimeEntries = vi.fn(async () => ({ total: 0, offset: 0, limit: 200, items: [] }));
    const api = { listProjectTimeEntries };
    const projectDoc = project({}, { primary_track: "working", workload_track: "estimate" });
    const { readModels, workloadTrack } = buildReportProps(projectDoc, [], [archivedTask], multiTrackScheduling);
    render(<ProjectActualReport api={api} draft={draft} locale="en" onNavigate={onNavigate} project={projectEntity(projectDoc)} projectId={String(projectDoc.id)} readModels={readModels} tasks={[archivedTask]} workloadTrack={workloadTrack} />);

    await waitFor(() => expect(listProjectTimeEntries).toHaveBeenCalled());
    // The archived task carries a 99h estimate but no actuals, so it must not appear in the
    // current effort table regardless of its planned estimate, nor in the task selector.
    await waitFor(() => expect(document.querySelector('tr[data-task-id="T-ARCH-EMPTY"]')).toBeNull());
    expect(document.querySelector(".plan-actual-report table tbody")?.textContent ?? "").not.toContain("99");
  });

  // Builds read models the way the real Effort workspace does: only ACTIVE tasks and ACTIVE
  // milestones feed the current plan, and a milestone outside the active set is normalized to
  // undefined. Archived tasks stay out of the read models even though they remain in the `tasks`
  // prop so the historical table can still surface their time records.
  const buildActiveReportProps = (projectDoc: EntityDocument, milestones: readonly EntityResult[], tasks: readonly EntityResult[], resolver: ScheduleResolver) => {
    const primaryTrack = resolver.primaryTrack(projectDoc.planning);
    const workloadTrack = resolver.workloadTrack(projectDoc.planning);
    const comparison = resolver.comparisonTrack(projectDoc.planning);
    const tracks = [...new Set([primaryTrack, workloadTrack, comparison].filter((track): track is string => track !== undefined && track !== ""))];
    const activeMilestoneIds = new Set(milestones.filter((milestone) => milestone.document.lifecycle === "active").map((milestone) => milestone.document.id));
    const hierarchy = resolveSchedulingHierarchy({
      project: projectDoc,
      milestones: milestones.filter((milestone) => milestone.document.lifecycle === "active").map((milestone) => milestone.document),
      tasks: tasks.filter((task) => task.document.lifecycle === "active").map((task): SchedulingHierarchyTask => ({
        ...task.document,
        parent: typeof task.document.parent === "string" && task.document.parent !== "" ? task.document.parent : undefined,
        milestone: typeof task.document.milestone === "string" && task.document.milestone !== "" && activeMilestoneIds.has(task.document.milestone) ? task.document.milestone : undefined,
      })),
      tracks,
    });
    return { readModels: hierarchy.readModels, workloadTrack };
  };

  it("scenario 1: an archived root task with an estimate but no time records never reaches the current plan, table, or selector", async () => {
    const archivedRoot = { document: { schema: "gitpm/task@2", id: "T-ARCH-ROOT", project: "P-26-1", title: "Archived root", type: "task", status: "done", lifecycle: "archived", schedules: { estimate: { effort_hours: 99 } } }, path: "g.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const listProjectTimeEntries = vi.fn(async () => ({ total: 0, offset: 0, limit: 200, items: [] }));
    const api = { listProjectTimeEntries };
    const projectDoc = project({ estimate: { effort_hours: 10 } }, { primary_track: "working", workload_track: "estimate" });
    const { readModels, workloadTrack } = buildActiveReportProps(projectDoc, [], [archivedRoot], multiTrackScheduling);
    render(<ProjectActualReport api={api} draft={draft} locale="en" onNavigate={onNavigate} project={projectEntity(projectDoc)} projectId={String(projectDoc.id)} readModels={readModels} tasks={[archivedRoot]} workloadTrack={workloadTrack} />);

    await waitFor(() => expect(listProjectTimeEntries).toHaveBeenCalled());
    // "Estimate of planned work" stays empty (—): the 99h archived estimate is not part of the
    // current plan because the read models were built from active tasks only.
    const plan = await waitFor(() => screen.getByText("Estimate of planned work").parentElement!);
    expect(plan.textContent ?? "").toMatch(/—/u);
    expect(plan.textContent ?? "").not.toMatch(/99/u);
    // The archived root is absent from the table body and from the task selector.
    expect(document.querySelector('tr[data-task-id="T-ARCH-ROOT"]')).toBeNull();
    const taskSelect = screen.getByLabelText("Task") as HTMLSelectElement;
    expect(Array.from(taskSelect.options).some((option) => option.value === archivedRoot.document.id)).toBe(false);
  });

  it("scenario 2: an archived subtask does not inflate the active parent's current plan", async () => {
    const parentTask = { document: { schema: "gitpm/task@2", id: "T-ACT-P", project: "P-26-1", title: "Active parent", type: "task", status: "in-progress", lifecycle: "active" }, path: "p.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const activeChild = { document: { schema: "gitpm/task@2", id: "T-ACT-C", project: "P-26-1", parent: "T-ACT-P", title: "Active child", type: "task", status: "in-progress", lifecycle: "active", schedules: { estimate: { effort_hours: 20 } } }, path: "c.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const archivedChild = { document: { schema: "gitpm/task@2", id: "T-ARCH-C", project: "P-26-1", parent: "T-ACT-P", title: "Archived child", type: "task", status: "done", lifecycle: "archived", schedules: { estimate: { effort_hours: 80 } } }, path: "ac.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const listProjectTimeEntries = vi.fn(async () => ({ total: 0, offset: 0, limit: 200, items: [] }));
    const api = { listProjectTimeEntries };
    const projectDoc = project({}, { primary_track: "working", workload_track: "estimate" });
    const { readModels, workloadTrack } = buildActiveReportProps(projectDoc, [], [parentTask, activeChild, archivedChild], multiTrackScheduling);
    render(<ProjectActualReport api={api} draft={draft} locale="en" onNavigate={onNavigate} project={projectEntity(projectDoc)} projectId={String(projectDoc.id)} readModels={readModels} tasks={[parentTask, activeChild, archivedChild]} workloadTrack={workloadTrack} />);

    // Scope to the active parent (with subtasks): the branch plan is the active child's 20h, not
    // 20+80=100, because the archived child is absent from the active-only read models.
    fireEvent.change(await screen.findByLabelText("Task"), { target: { value: parentTask.document.id } });
    await waitFor(() => expect(screen.getByText("Plan of selected scope").parentElement?.textContent).toMatch(/20 hours/u));
    expect(screen.getByText("Plan of selected scope").parentElement?.textContent ?? "").not.toMatch(/100/u);
    // The parent's own row plan cell is also 20h.
    const parentRow = document.querySelector<HTMLElement>(`tr[data-task-id="${parentTask.document.id}"]`)!;
    expect(parentRow.querySelectorAll("td")[0]?.textContent).toMatch(/20 hours/u);
  });

  it("scenario 3: an archived task with historical time records shows as a historical row, keeps its hours, and does not inflate the current plan", async () => {
    const activeRoot = { document: { schema: "gitpm/task@2", id: "T-ACT-R", project: "P-26-1", title: "Active root", type: "task", status: "in-progress", lifecycle: "active", schedules: { estimate: { effort_hours: 10 } } }, path: "r.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const archivedTask = { document: { schema: "gitpm/task@2", id: "T-ARCH-HIST", project: "P-26-1", title: "Legacy with hours", type: "task", status: "done", lifecycle: "archived", schedules: { estimate: { effort_hours: 50 } } }, path: "h.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const items = [{ document: { schema: "gitpm/time-entry@1" as const, id: "E-HIST", project: "P-26-1", task: archivedTask.document.id, person: "U-1", performed_on: "2026-05-01", hours: 5, category: "regular", created_at: "2026-05-01T00:00:00.000Z", state: "active" as const }, path: "e", blob_id: "a", draft_fingerprint: "f" }];
    const listProjectTimeEntries = vi.fn(async () => ({ total: items.length, offset: 0, limit: 200, items }));
    const api = { listProjectTimeEntries };
    const projectDoc = project({ estimate: { effort_hours: 10 } }, { primary_track: "working", workload_track: "estimate" });
    const { readModels, workloadTrack } = buildActiveReportProps(projectDoc, [], [activeRoot, archivedTask], multiTrackScheduling);
    render(<ProjectActualReport api={api} draft={draft} locale="en" onNavigate={onNavigate} project={projectEntity(projectDoc)} projectId={String(projectDoc.id)} readModels={readModels} tasks={[activeRoot, archivedTask]} workloadTrack={workloadTrack} />);

    // The archived task surfaces as a historical row with its 5 hours and the "Archived task"
    // marker; its plan cell is empty (—) because it is not part of the current read models.
    await waitFor(() => expect(document.querySelector(`tr[data-task-id="${archivedTask.document.id}"]`)).not.toBeNull());
    const archivedRow = document.querySelector<HTMLElement>(`tr[data-task-id="${archivedTask.document.id}"]`)!;
    expect(archivedRow.textContent).toContain("Archived task");
    expect(archivedRow.querySelectorAll("td")[2]?.textContent).toMatch(/5 hours/u);
    expect(archivedRow.querySelectorAll("td")[0]?.textContent).toMatch(/—/u);
    // The current plan stays at the active root's 10h; the archived 50h estimate never joins it.
    const plan = await screen.getByText("Estimate of planned work").parentElement!;
    expect(plan.textContent ?? "").toMatch(/10 hours/u);
    expect(plan.textContent ?? "").not.toMatch(/50|60/u);
  });

  it("selector: lists archived tasks with history but not without, and keeps history under a person filter", async () => {
    const activeTask = { document: { schema: "gitpm/task@2", id: "T-SEL-ACT", project: "P-26-1", title: "Active selectable", type: "task", status: "in-progress", lifecycle: "active", schedules: { estimate: { effort_hours: 4 } } }, path: "a.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const archivedWithHistory = { document: { schema: "gitpm/task@2", id: "T-SEL-HIST", project: "P-26-1", title: "Archived with hours", type: "task", status: "done", lifecycle: "archived", schedules: { estimate: { effort_hours: 7 } } }, path: "h.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const archivedWithoutHistory = { document: { schema: "gitpm/task@2", id: "T-SEL-GHOST", project: "P-26-1", title: "Archived ghost", type: "task", status: "done", lifecycle: "archived", schedules: { estimate: { effort_hours: 9 } } }, path: "g.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const personA = "U-A";
    const personB = "U-B";
    const allItems = [
      { document: { schema: "gitpm/time-entry@1" as const, id: "E-A", project: "P-26-1", task: activeTask.document.id, person: personA, performed_on: "2026-05-01", hours: 4, category: "regular", created_at: "2026-05-01T00:00:00.000Z", state: "active" as const }, path: "a", blob_id: "a", draft_fingerprint: "f" },
      { document: { schema: "gitpm/time-entry@1" as const, id: "E-B", project: "P-26-1", task: archivedWithHistory.document.id, person: personB, performed_on: "2026-05-02", hours: 7, category: "regular", created_at: "2026-05-02T00:00:00.000Z", state: "active" as const }, path: "b", blob_id: "a", draft_fingerprint: "f" },
    ];
    const listProjectTimeEntries = vi.fn(async (_d: string, _p: string, filters: Record<string, unknown> = {}) => {
      const filtered = allItems.filter((item) => filters.person === undefined || item.document.person === filters.person);
      return { total: filtered.length, offset: Number(filters.offset ?? 0), limit: Number(filters.limit ?? 200), items: filtered };
    });
    const api = { listProjectTimeEntries };
    const projectDoc = project({}, { primary_track: "working", workload_track: "estimate" });
    const { readModels, workloadTrack } = buildActiveReportProps(projectDoc, [], [activeTask, archivedWithHistory, archivedWithoutHistory], multiTrackScheduling);
    render(<ProjectActualReport api={api} draft={draft} locale="en" onNavigate={onNavigate} project={projectEntity(projectDoc)} projectId={String(projectDoc.id)} readModels={readModels} tasks={[activeTask, archivedWithHistory, archivedWithoutHistory]} workloadTrack={workloadTrack} />);

    const taskSelect = await screen.findByLabelText("Task") as HTMLSelectElement;
    // Initially the active task and the archived task WITH history are listed; the archived task
    // without history is not.
    await waitFor(() => {
      expect(Array.from(taskSelect.options).some((option) => option.value === activeTask.document.id)).toBe(true);
      expect(Array.from(taskSelect.options).some((option) => option.value === archivedWithHistory.document.id)).toBe(true);
      expect(Array.from(taskSelect.options).some((option) => option.value === archivedWithoutHistory.document.id)).toBe(false);
    });

    // Narrowing to person A removes person B's records from the current result, but the archived
    // task with history (whose records belong to person B) must remain selectable because history
    // is read from the full project record set, not the filtered view.
    fireEvent.change(screen.getByLabelText("Person"), { target: { value: personA } });
    await waitFor(() => expect(listProjectTimeEntries).toHaveBeenLastCalledWith("DRF", "P-26-1", expect.objectContaining({ person: personA })));
    const filteredSelect = screen.getByLabelText("Task") as HTMLSelectElement;
    expect(Array.from(filteredSelect.options).some((option) => option.value === archivedWithHistory.document.id)).toBe(true);
    expect(Array.from(filteredSelect.options).some((option) => option.value === archivedWithoutHistory.document.id)).toBe(false);
  });

  // ── Mandatory test 1: archived parent promotes the active child to a root ─────────
  it("archived parent: active child becomes a root row, a flat selector option, and a plan contributor", async () => {
    const archivedParent = { document: { schema: "gitpm/task@2", id: "T-ARCH-PAR", project: "P-26-1", title: "Archived parent", type: "task", status: "done", lifecycle: "archived", schedules: { estimate: { effort_hours: 50 } } }, path: "ap.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const activeChild = { document: { schema: "gitpm/task@2", id: "T-ACT-CHILD", project: "P-26-1", parent: archivedParent.document.id, title: "Active child", type: "task", status: "in-progress", lifecycle: "active", schedules: { estimate: { effort_hours: 20 } } }, path: "ac.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const listProjectTimeEntries = vi.fn(async () => ({ total: 0, offset: 0, limit: 200, items: [] }));
    const api = { listProjectTimeEntries };
    const projectDoc = project({}, { primary_track: "working", workload_track: "estimate" });
    const { readModels, workloadTrack } = buildActiveReportProps(projectDoc, [], [archivedParent, activeChild], multiTrackScheduling);
    render(<ProjectActualReport api={api} draft={draft} locale="en" onNavigate={onNavigate} project={projectEntity(projectDoc)} projectId={String(projectDoc.id)} readModels={readModels} tasks={[archivedParent, activeChild]} workloadTrack={workloadTrack} />);

    const childRow = await waitFor(() => { const row = document.querySelector<HTMLElement>(`tr[data-task-id="${activeChild.document.id}"]`); expect(row).not.toBeNull(); return row!; });
    // Root depth: the archived parent does not pull the active child down.
    expect(childRow.getAttribute("data-depth")).toBe("0");
    expect(childRow.querySelector<HTMLElement>(".actual-report-task-cell")?.style.paddingLeft).toBe("0.5rem");
    // Current plan includes the child's 20h estimate; the archived parent's 50h is excluded.
    const plan = screen.getByText("Plan of selected scope").parentElement!;
    expect(plan.textContent ?? "").toMatch(/20 hours/u);
    expect(plan.textContent ?? "").not.toMatch(/50|70/u);
    // Selector option carries no nesting prefix (depth 0 → no \u00A0 characters).
    const taskSelect = screen.getByLabelText("Task") as HTMLSelectElement;
    const childOption = Array.from(taskSelect.options).find((option) => option.value === activeChild.document.id)!;
    expect(childOption.textContent).toBe("Active child");
    // The archived parent (no history) is absent from both the table and the selector.
    expect(document.querySelector(`tr[data-task-id="${archivedParent.document.id}"]`)).toBeNull();
    expect(Array.from(taskSelect.options).some((option) => option.value === archivedParent.document.id)).toBe(false);
  });

  // ── Mandatory test 2: archived parent with history stays historical ──────────────
  it("archived parent with history surfaces as a historical row while the active child stays root", async () => {
    const archivedParent = { document: { schema: "gitpm/task@2", id: "T-ARCH-PAR-H", project: "P-26-1", title: "Archived parent with hours", type: "task", status: "done", lifecycle: "archived", schedules: { estimate: { effort_hours: 50 } } }, path: "ap.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const activeChild = { document: { schema: "gitpm/task@2", id: "T-ACT-CHILD-H", project: "P-26-1", parent: archivedParent.document.id, title: "Active child H", type: "task", status: "in-progress", lifecycle: "active", schedules: { estimate: { effort_hours: 20 } } }, path: "ac.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const items = [{ document: { schema: "gitpm/time-entry@1" as const, id: "E-ARCH-PAR-H", project: "P-26-1", task: archivedParent.document.id, person: "U-1", performed_on: "2026-05-01", hours: 5, category: "regular", created_at: "2026-05-01T00:00:00.000Z", state: "active" as const }, path: "e", blob_id: "a", draft_fingerprint: "f" }];
    const listProjectTimeEntries = vi.fn(async () => ({ total: items.length, offset: 0, limit: 200, items }));
    const api = { listProjectTimeEntries };
    const projectDoc = project({}, { primary_track: "working", workload_track: "estimate" });
    const { readModels, workloadTrack } = buildActiveReportProps(projectDoc, [], [archivedParent, activeChild], multiTrackScheduling);
    render(<ProjectActualReport api={api} draft={draft} locale="en" onNavigate={onNavigate} project={projectEntity(projectDoc)} projectId={String(projectDoc.id)} readModels={readModels} tasks={[archivedParent, activeChild]} workloadTrack={workloadTrack} />);

    // The archived parent surfaces as a flat historical row with its 5 hours.
    const archivedRow = await waitFor(() => { const row = document.querySelector<HTMLElement>(`tr[data-task-id="${archivedParent.document.id}"]`); expect(row).not.toBeNull(); return row!; });
    expect(archivedRow.getAttribute("data-depth")).toBe("0");
    expect(archivedRow.textContent).toContain("Archived task");
    expect(archivedRow.querySelectorAll("td")[1]?.textContent).toMatch(/5 hours/u);
    // The active child is a root (depth 0), not pulled under its archived parent.
    const childRow = document.querySelector<HTMLElement>(`tr[data-task-id="${activeChild.document.id}"]`)!;
    expect(childRow.getAttribute("data-depth")).toBe("0");
    // The child's current estimate (20h) is preserved in its plan cell.
    expect(childRow.querySelectorAll("td")[0]?.textContent).toMatch(/20 hours/u);
    // The plan total includes the active child's 20h, never the archived parent's 50h.
    const plan = screen.getByText("Plan of selected scope").parentElement!;
    expect(plan.textContent ?? "").toMatch(/20 hours/u);
    expect(plan.textContent ?? "").not.toMatch(/50|70/u);
  });

  // ── Mandatory test 3: missing parent promotes the task to a root ────────────────
  it("missing parent: task with an unknown parent id is rendered as root, in the selector, and in the plan", async () => {
    const orphan = { document: { schema: "gitpm/task@2", id: "T-ORPHAN", project: "P-26-1", parent: "T-GONE", title: "Orphan task", type: "task", status: "in-progress", lifecycle: "active", schedules: { estimate: { effort_hours: 12 } } }, path: "o.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const listProjectTimeEntries = vi.fn(async () => ({ total: 0, offset: 0, limit: 200, items: [] }));
    const api = { listProjectTimeEntries };
    const projectDoc = project({}, { primary_track: "working", workload_track: "estimate" });
    const { readModels, workloadTrack } = buildActiveReportProps(projectDoc, [], [orphan], multiTrackScheduling);
    render(<ProjectActualReport api={api} draft={draft} locale="en" onNavigate={onNavigate} project={projectEntity(projectDoc)} projectId={String(projectDoc.id)} readModels={readModels} tasks={[orphan]} workloadTrack={workloadTrack} />);

    const orphanRow = await waitFor(() => { const row = document.querySelector<HTMLElement>(`tr[data-task-id="${orphan.document.id}"]`); expect(row).not.toBeNull(); return row!; });
    expect(orphanRow.getAttribute("data-depth")).toBe("0");
    // Present in the selector.
    const taskSelect = screen.getByLabelText("Task") as HTMLSelectElement;
    expect(Array.from(taskSelect.options).some((option) => option.value === orphan.document.id)).toBe(true);
    // Participates in the current plan (12h).
    const plan = screen.getByText("Plan of selected scope").parentElement!;
    expect(plan.textContent ?? "").toMatch(/12 hours/u);
  });

  // ── Mandatory test 4: race between the full-index and the filtered request ──────
  it("filtered response can resolve before the full index without losing archived tasks", async () => {
    const activeTask = { document: { schema: "gitpm/task@2", id: "T-RACE-ACT", project: "P-26-1", title: "Race active", type: "task", status: "in-progress", lifecycle: "active", schedules: { estimate: { effort_hours: 8 } } }, path: "a.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const archivedTask = { document: { schema: "gitpm/task@2", id: "T-RACE-ARCH", project: "P-26-1", title: "Race archived", type: "task", status: "done", lifecycle: "archived" }, path: "h.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const personA = "U-RACE-A";
    const personB = "U-RACE-B";
    const personAEntity = { document: { schema: "gitpm/person@1", id: personA, name: "Race A", lifecycle: "active" } } as EntityResult;
    const personBEntity = { document: { schema: "gitpm/person@1", id: personB, name: "Race B", lifecycle: "active" } } as EntityResult;
    const allItems = [
      { document: { schema: "gitpm/time-entry@1" as const, id: "E-RACE-A", project: "P-26-1", task: activeTask.document.id, person: personA, performed_on: "2026-05-01", hours: 4, category: "regular", created_at: "2026-05-01T00:00:00.000Z", state: "active" as const }, path: "a", blob_id: "a", draft_fingerprint: "f" },
      { document: { schema: "gitpm/time-entry@1" as const, id: "E-RACE-B", project: "P-26-1", task: archivedTask.document.id, person: personB, performed_on: "2026-05-02", hours: 5, category: "regular", created_at: "2026-05-02T00:00:00.000Z", state: "active" as const }, path: "b", blob_id: "a", draft_fingerprint: "f" },
    ];
    let resolveFullIndex!: () => void;
    let resolveFiltered!: () => void;
    const fullIndexGate = new Promise<void>((resolve) => { resolveFullIndex = resolve; });
    const filteredGate = new Promise<void>((resolve) => { resolveFiltered = resolve; });
    const listProjectTimeEntries = vi.fn(async (_d: string, _p: string, filters: Record<string, unknown> = {}) => {
      // Request A: full unfiltered index — no state filter. Held until resolveFullIndex.
      if (filters.state === undefined) { await fullIndexGate; return { total: allItems.length, offset: 0, limit: 200, items: allItems }; }
      // Request B with a person filter — held until resolveFiltered.
      if (filters.person !== undefined) { await filteredGate; const items = allItems.filter((item) => item.document.person === filters.person); return { total: items.length, offset: 0, limit: 200, items }; }
      // Request B initial (mount, no person) — returns immediately.
      return { total: allItems.length, offset: 0, limit: 200, items: allItems };
    });
    const api = { listProjectTimeEntries };
    const projectDoc = project({}, { primary_track: "working", workload_track: "estimate" });
    const { readModels, workloadTrack } = buildActiveReportProps(projectDoc, [], [activeTask, archivedTask], multiTrackScheduling);
    render(<ProjectActualReport api={api} draft={draft} locale="en" onNavigate={onNavigate} people={[personAEntity, personBEntity]} project={projectEntity(projectDoc)} projectId={String(projectDoc.id)} readModels={readModels} tasks={[activeTask, archivedTask]} workloadTrack={workloadTrack} />);

    // The full-index request (A) fires on mount and must never carry user filters.
    await waitFor(() => expect(listProjectTimeEntries.mock.calls.some((call) => (call[2] as Record<string, unknown> | undefined)?.state === undefined)).toBe(true));
    const fullIndexCall = listProjectTimeEntries.mock.calls.find((call) => (call[2] as Record<string, unknown> | undefined)?.state === undefined)![2] as Record<string, unknown>;
    expect(fullIndexCall.person).toBeUndefined();
    expect(fullIndexCall.category).toBeUndefined();

    // Select person A — Request B fires with the person filter.
    await screen.findByLabelText("Person");
    fireEvent.change(screen.getByLabelText("Person"), { target: { value: personA } });
    await waitFor(() => expect(listProjectTimeEntries.mock.calls.some((call) => (call[2] as Record<string, unknown> | undefined)?.person === personA)).toBe(true));
    const filteredCall = listProjectTimeEntries.mock.calls.find((call) => (call[2] as Record<string, unknown> | undefined)?.person === personA)![2] as Record<string, unknown>;
    expect(filteredCall.state).toBe("active");

    // Resolve the filtered response first, then the full-index response.
    resolveFiltered();
    resolveFullIndex();

    // The displayed rows are narrowed to person A (4h). The archived task (person B's 5h) is
    // absent from the plan/actual table because its display records are filtered out.
    await waitFor(() => expect(screen.getAllByText("Actual hours")[0]?.parentElement?.textContent).toMatch(/4 hours/u));
    expect(document.querySelector(`tr[data-task-id="${archivedTask.document.id}"]`)).toBeNull();
    // But the full historical index retains the archived task, so it stays selectable — no
    // page reload is needed to recover it after resetting the filter.
    const taskSelect = screen.getByLabelText("Task") as HTMLSelectElement;
    expect(Array.from(taskSelect.options).some((option) => option.value === archivedTask.document.id)).toBe(true);
  });

  // ── Mandatory test 5a: changing the draft clears old state ──────────────────────
  it("changing the draft clears old tasks, entries, people, and categories", async () => {
    const activeTask = { document: { schema: "gitpm/task@2", id: "T-DRAFT-ACT", project: "P-26-1", title: "Draft active", type: "task", status: "in-progress", lifecycle: "active", schedules: { estimate: { effort_hours: 5 } } }, path: "a.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const archivedTask = { document: { schema: "gitpm/task@2", id: "T-DRAFT-ARCH", project: "P-26-1", title: "Draft archived", type: "task", status: "done", lifecycle: "archived" }, path: "h.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const draft1Entry = { document: { schema: "gitpm/time-entry@1" as const, id: "E-D1", project: "P-26-1", task: archivedTask.document.id, person: "U-ONLY-D1", performed_on: "2026-05-01", hours: 5, category: "catD1", created_at: "2026-05-01T00:00:00.000Z", state: "active" as const }, path: "1", blob_id: "a", draft_fingerprint: "f" };
    const listProjectTimeEntries = vi.fn(async (draftId: string, _p: string, _filters: Record<string, unknown> = {}) => {
      const items = draftId === "DRF" ? [draft1Entry] : [];
      return { total: items.length, offset: 0, limit: 200, items };
    });
    const api = { listProjectTimeEntries };
    const projectDoc = project({}, { primary_track: "working", workload_track: "estimate" });
    const { readModels, workloadTrack } = buildActiveReportProps(projectDoc, [], [activeTask, archivedTask], multiTrackScheduling);
    const draftTwo: DraftStatus = { ...draft, draft_id: "DRF-2" };
    const rendered = render(<ProjectActualReport api={api} draft={draft} locale="en" onNavigate={onNavigate} project={projectEntity(projectDoc)} projectId={String(projectDoc.id)} readModels={readModels} tasks={[activeTask, archivedTask]} workloadTrack={workloadTrack} />);

    // Draft 1: the archived task with history is selectable and its person/category appear.
    await waitFor(() => {
      const select = screen.getByLabelText("Task") as HTMLSelectElement;
      expect(Array.from(select.options).some((option) => option.value === archivedTask.document.id)).toBe(true);
    });
    expect(Array.from((screen.getByLabelText("Person") as HTMLSelectElement).options).some((option) => option.value === "U-ONLY-D1")).toBe(true);
    expect(Array.from((screen.getByLabelText("Category") as HTMLSelectElement).options).some((option) => option.value === "catD1")).toBe(true);

    // Switch to draft 2 (which has no archived task, no entries, no unique person/category).
    rendered.rerender(<ProjectActualReport api={api} draft={draftTwo} locale="en" onNavigate={onNavigate} project={projectEntity(projectDoc)} projectId={String(projectDoc.id)} readModels={readModels} tasks={[activeTask]} workloadTrack={workloadTrack} />);

    // New requests use the new draft id.
    await waitFor(() => expect(listProjectTimeEntries.mock.calls.some((call) => call[0] === "DRF-2")).toBe(true));
    // The archived task, its person, and its category are all gone.
    await waitFor(() => {
      const select = screen.getByLabelText("Task") as HTMLSelectElement;
      expect(Array.from(select.options).some((option) => option.value === archivedTask.document.id)).toBe(false);
    });
    expect(Array.from((screen.getByLabelText("Person") as HTMLSelectElement).options).some((option) => option.value === "U-ONLY-D1")).toBe(false);
    expect(Array.from((screen.getByLabelText("Category") as HTMLSelectElement).options).some((option) => option.value === "catD1")).toBe(false);
  });

  // ── Mandatory test 5b: changing the projectId clears old state ──────────────────
  it("changing the projectId clears old tasks, entries, people, and categories", async () => {
    const activeTask = { document: { schema: "gitpm/task@2", id: "T-PROJ-ACT", project: "P-26-1", title: "Project active", type: "task", status: "in-progress", lifecycle: "active", schedules: { estimate: { effort_hours: 5 } } }, path: "a.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const archivedTask = { document: { schema: "gitpm/task@2", id: "T-PROJ-ARCH", project: "P-26-1", title: "Project archived", type: "task", status: "done", lifecycle: "archived" }, path: "h.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const project1Entry = { document: { schema: "gitpm/time-entry@1" as const, id: "E-P1", project: "P-26-1", task: archivedTask.document.id, person: "U-ONLY-P1", performed_on: "2026-05-01", hours: 5, category: "catP1", created_at: "2026-05-01T00:00:00.000Z", state: "active" as const }, path: "1", blob_id: "a", draft_fingerprint: "f" };
    const listProjectTimeEntries = vi.fn(async (_d: string, projectId: string, _filters: Record<string, unknown> = {}) => {
      const items = projectId === "P-26-1" ? [project1Entry] : [];
      return { total: items.length, offset: 0, limit: 200, items };
    });
    const api = { listProjectTimeEntries };
    const projectDoc = project({}, { primary_track: "working", workload_track: "estimate" });
    const projectTwoDoc = { ...projectDoc, id: "P-26-2" } as EntityDocument;
    const { readModels, workloadTrack } = buildActiveReportProps(projectDoc, [], [activeTask, archivedTask], multiTrackScheduling);
    const rendered = render(<ProjectActualReport api={api} draft={draft} locale="en" onNavigate={onNavigate} project={projectEntity(projectDoc)} projectId={String(projectDoc.id)} readModels={readModels} tasks={[activeTask, archivedTask]} workloadTrack={workloadTrack} />);

    await waitFor(() => {
      const select = screen.getByLabelText("Task") as HTMLSelectElement;
      expect(Array.from(select.options).some((option) => option.value === archivedTask.document.id)).toBe(true);
    });
    expect(Array.from((screen.getByLabelText("Person") as HTMLSelectElement).options).some((option) => option.value === "U-ONLY-P1")).toBe(true);

    // Switch to project 2 (no archived task, no entries).
    rendered.rerender(<ProjectActualReport api={api} draft={draft} locale="en" onNavigate={onNavigate} project={projectEntity(projectTwoDoc)} projectId="P-26-2" readModels={readModels} tasks={[activeTask]} workloadTrack={workloadTrack} />);

    await waitFor(() => expect(listProjectTimeEntries.mock.calls.some((call) => call[1] === "P-26-2")).toBe(true));
    await waitFor(() => {
      const select = screen.getByLabelText("Task") as HTMLSelectElement;
      expect(Array.from(select.options).some((option) => option.value === archivedTask.document.id)).toBe(false);
    });
    expect(Array.from((screen.getByLabelText("Person") as HTMLSelectElement).options).some((option) => option.value === "U-ONLY-P1")).toBe(false);
  });

  // ── Mandatory test 6: resetting a filter restores hidden archived tasks ─────────
  it("resetting the person filter restores a hidden archived task without reloading the page", async () => {
    const activeTask = { document: { schema: "gitpm/task@2", id: "T-RESET-ACT", project: "P-26-1", title: "Reset active", type: "task", status: "in-progress", lifecycle: "active", schedules: { estimate: { effort_hours: 3 } } }, path: "a.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const archivedTask = { document: { schema: "gitpm/task@2", id: "T-RESET-ARCH", project: "P-26-1", title: "Reset archived", type: "task", status: "done", lifecycle: "archived" }, path: "h.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const personA = "U-RESET-A";
    const personB = "U-RESET-B";
    const allItems = [
      { document: { schema: "gitpm/time-entry@1" as const, id: "E-RESET-A", project: "P-26-1", task: archivedTask.document.id, person: personA, performed_on: "2026-05-01", hours: 5, category: "regular", created_at: "2026-05-01T00:00:00.000Z", state: "active" as const }, path: "a", blob_id: "a", draft_fingerprint: "f" },
      { document: { schema: "gitpm/time-entry@1" as const, id: "E-RESET-B", project: "P-26-1", task: activeTask.document.id, person: personB, performed_on: "2026-05-02", hours: 3, category: "regular", created_at: "2026-05-02T00:00:00.000Z", state: "active" as const }, path: "b", blob_id: "a", draft_fingerprint: "f" },
    ];
    const listProjectTimeEntries = vi.fn(async (_d: string, _p: string, filters: Record<string, unknown> = {}) => {
      const filtered = allItems.filter((item) => filters.person === undefined || item.document.person === filters.person);
      return { total: filtered.length, offset: 0, limit: 200, items: filtered };
    });
    const api = { listProjectTimeEntries };
    const projectDoc = project({}, { primary_track: "working", workload_track: "estimate" });
    const { readModels, workloadTrack } = buildActiveReportProps(projectDoc, [], [activeTask, archivedTask], multiTrackScheduling);
    render(<ProjectActualReport api={api} draft={draft} locale="en" onNavigate={onNavigate} project={projectEntity(projectDoc)} projectId={String(projectDoc.id)} readModels={readModels} tasks={[activeTask, archivedTask]} workloadTrack={workloadTrack} />);

    // Initially both tasks appear: the archived task has person A's 5h.
    await waitFor(() => expect(document.querySelector(`tr[data-task-id="${archivedTask.document.id}"]`)).not.toBeNull());

    // Select person B — the archived task's row (person A's records) is hidden from the report.
    fireEvent.change(screen.getByLabelText("Person"), { target: { value: personB } });
    await waitFor(() => expect(document.querySelector(`tr[data-task-id="${archivedTask.document.id}"]`)).toBeNull());
    // But the full historical index is unchanged: the archived task stays in the selector.
    const taskSelect = screen.getByLabelText("Task") as HTMLSelectElement;
    expect(Array.from(taskSelect.options).some((option) => option.value === archivedTask.document.id)).toBe(true);

    // Reset the person filter — the archived task reappears in the table without reloading.
    fireEvent.change(screen.getByLabelText("Person"), { target: { value: "" } });
    await waitFor(() => expect(document.querySelector(`tr[data-task-id="${archivedTask.document.id}"]`)).not.toBeNull());
  });
});
