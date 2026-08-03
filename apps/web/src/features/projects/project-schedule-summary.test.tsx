// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectScheduleSummary } from "./project-schedule-summary.js";
import { SchedulingOverflowWarnings } from "../../scheduling-overflow-warnings.js";
import { ScheduleResolver, scheduleTracksConfig } from "../../schedules.js";
import type { EntityDocument, EntityResult } from "../../types.js";

const configDocument = { schema: "gitpm/schedule-tracks@1", tracks: [{ slug: "plan", title: "Plan", kind: "manual", capabilities: ["dates", "effort", "dependencies"] }, { slug: "target", title: "Target", kind: "manual", capabilities: ["dates"] }, { slug: "actual", title: "Actual", kind: "actual", source: "time_entries" }], defaults: { enabled_tracks: ["plan", "target", "actual"], primary_track: "plan", workload_track: "plan", comparison_track: "target", dashboard_tracks: ["plan", "target", "actual"] } };
const scheduling = new ScheduleResolver(scheduleTracksConfig(configDocument));

// A track-agnostic configuration where the primary, workload, and comparison roles
// are bound to three distinct made-up slugs (`working`, `estimate`, `forecast`).
const multiTrackDocument = { schema: "gitpm/schedule-tracks@1", tracks: [{ slug: "working", title: "Working", kind: "manual", capabilities: ["dates", "effort"] }, { slug: "forecast", title: "Forecast", kind: "manual", capabilities: ["dates"] }, { slug: "estimate", title: "Estimate", kind: "manual", capabilities: ["dates", "effort"] }, { slug: "actual", title: "Actual", kind: "actual", source: "time_entries" }], defaults: { enabled_tracks: ["working", "forecast", "estimate", "actual"], primary_track: "working", workload_track: "estimate", comparison_track: "forecast", dashboard_tracks: ["working", "forecast", "estimate", "actual"] } };
const multiTrackScheduling = new ScheduleResolver(scheduleTracksConfig(multiTrackDocument));

// A primary-only configuration with no comparison track. Used to pin the no-duplication
// rule from §5.3 (a primary finish alone is already shown in the project header).
const primaryOnlyDocument = { schema: "gitpm/schedule-tracks@1", tracks: [{ slug: "plan", title: "Plan", kind: "manual", capabilities: ["dates", "effort", "dependencies"] }, { slug: "actual", title: "Actual", kind: "actual", source: "time_entries" }], defaults: { enabled_tracks: ["plan", "actual"], primary_track: "plan", workload_track: "plan", dashboard_tracks: ["plan", "actual"] } };
const primaryOnlyScheduling = new ScheduleResolver(scheduleTracksConfig(primaryOnlyDocument));

const projectId = "P-26-1";
const project = (schedules: Record<string, unknown>, planning?: Record<string, unknown>): EntityDocument =>
  ({ schema: "gitpm/project@2", id: projectId, name: "Demo", status: "in-progress", lifecycle: "active", ...(planning === undefined ? {} : { planning }), schedules } as EntityDocument);

const overflowingHierarchy = () => {
  const milestone = { document: { schema: "gitpm/milestone@2", id: "M-1", project: projectId, name: "Release", lifecycle: "active" }, path: "m.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
  const parent = { document: { schema: "gitpm/task@2", id: "T-parent", project: projectId, milestone: "M-1", title: "Parent", type: "task", status: "backlog", lifecycle: "active" }, path: "parent.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
  const child = { document: { schema: "gitpm/task@2", id: "T-child", project: projectId, milestone: "M-1", parent: "T-parent", title: "Child", type: "task", status: "backlog", lifecycle: "active", schedules: { plan: { start: "2026-09-01", finish: "2026-09-15" } } }, path: "child.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
  return { milestone, parent, child };
};

afterEach(cleanup);

describe("ProjectScheduleSummary", () => {
  it("renders nothing without schedule finishes", () => {
    const { container } = render(<ProjectScheduleSummary project={project({})} projectId={projectId} onNavigate={vi.fn()} locale="en" scheduling={primaryOnlyScheduling} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing for a primary-only project with no overflow warnings (no header duplication)", () => {
    // §5.3: a primary finish alone is already shown in the project header and must not be
    // duplicated as a standalone card just to show one finish line.
    const { container } = render(<ProjectScheduleSummary project={project({ plan: { finish: "2026-03-20" } })} projectId={projectId} onNavigate={vi.fn()} locale="en" scheduling={primaryOnlyScheduling} />);
    expect(container.firstChild).toBeNull();
  });

  it("labels comparison rows with track titles and functional roles, not slugs or technical labels", () => {
    const onNavigate = vi.fn();
    render(<ProjectScheduleSummary project={project({ plan: { finish: "2026-03-20" }, target: { finish: "2026-02-28" } }, { primary_track: "plan", comparison_track: "target" })} projectId={projectId} onNavigate={onNavigate} locale="en" scheduling={scheduling} />);
    // Track titles from TrackDefinition.title appear as the row labels.
    expect(screen.getByText("Plan")).toBeTruthy();
    expect(screen.getByText("Target")).toBeTruthy();
    // Functional subtitles disambiguate the two rows.
    expect(screen.getByText("Primary schedule")).toBeTruthy();
    expect(screen.getByText("Comparison schedule")).toBeTruthy();
    // Legacy technical labels are gone.
    expect(screen.queryByText("Primary finish")).toBeNull();
    expect(screen.queryByText("Comparison finish")).toBeNull();
    // Track slugs never leak into user-facing text.
    expect(document.body.textContent ?? "").not.toContain("plan");
    expect(document.body.textContent ?? "").not.toContain("target");
    // Primary date is present on the primary row only.
    const primaryRow = screen.getByText("Primary schedule").closest("dt")!.parentElement!;
    expect(primaryRow.querySelector("dd")!.textContent).toContain("Mar");
    const comparisonRow = screen.getByText("Comparison schedule").closest("dt")!.parentElement!;
    expect(comparisonRow.querySelector("dd")!.textContent).toContain("Feb");
    expect(screen.getByText("Variance").parentElement?.textContent).toMatch(/\+20 days/);
  });

  it("opens the Gantt for the project when the open-Gantt action is clicked", () => {
    const onNavigate = vi.fn();
    render(<ProjectScheduleSummary project={project({ plan: { finish: "2026-03-20" }, target: { finish: "2026-02-28" } }, { primary_track: "plan", comparison_track: "target" })} projectId={projectId} onNavigate={onNavigate} locale="en" scheduling={scheduling} />);
    fireEvent.click(screen.getByRole("button", { name: "Open Gantt chart" }));
    expect(onNavigate).toHaveBeenCalledWith("gantt", { projectId });
  });

  it("uses the comparison heading when a comparison track is present", () => {
    render(<ProjectScheduleSummary project={project({ plan: { finish: "2026-03-20" }, target: { finish: "2026-02-28" } }, { primary_track: "plan", comparison_track: "target" })} projectId={projectId} onNavigate={vi.fn()} locale="en" scheduling={scheduling} />);
    expect(screen.getByRole("heading", { name: "Schedule comparison", level: 3 })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Schedule", level: 3 })).toBeNull();
  });

  it("uses the neutral schedule heading when only overflow warnings are present", () => {
    const { milestone, parent, child } = overflowingHierarchy();
    render(<ProjectScheduleSummary project={project({ plan: { start: "2026-09-05", finish: "2026-09-10" } })} projectId={projectId} onNavigate={vi.fn()} locale="en" milestones={[milestone]} scheduling={primaryOnlyScheduling} tasks={[parent, child]} />);
    expect(screen.getByRole("heading", { name: "Schedule", level: 3 })).toBeTruthy();
  });

  it("renders project overflow warnings from resolved milestone task roots", () => {
    const { milestone, parent, child } = overflowingHierarchy();
    render(<ProjectScheduleSummary project={project({ plan: { start: "2026-09-05", finish: "2026-09-10" } })} projectId={projectId} onNavigate={vi.fn()} locale="en" milestones={[milestone]} scheduling={scheduling} tasks={[parent, child]} />);

    const warning = screen.getByText("Schedule overflow").parentElement!;
    expect(warning.textContent).toContain("Plan");
    expect(warning.textContent).toContain("set to Sep 5, 2026");
    expect(warning.textContent).toContain("child items reach Sep 1, 2026");
    expect(warning.textContent).toContain("set to Sep 10, 2026");
    expect(warning.textContent).toContain("child items reach Sep 15, 2026");
  });

  it("makes overflow warnings clickable and opens the Gantt when a warning is activated", () => {
    const onNavigate = vi.fn();
    const { milestone, parent, child } = overflowingHierarchy();
    render(<ProjectScheduleSummary project={project({ plan: { start: "2026-09-05", finish: "2026-09-10" } })} projectId={projectId} onNavigate={onNavigate} locale="en" milestones={[milestone]} scheduling={scheduling} tasks={[parent, child]} />);
    const warningButtons = screen.getAllByRole("button", { name: /set to/u });
    expect(warningButtons.length).toBeGreaterThan(0);
    fireEvent.click(warningButtons[0]!);
    expect(onNavigate).toHaveBeenCalledWith("gantt", { projectId });
  });

  it("renders overflow warnings without a primary-finish row when comparison is absent but warnings exist", () => {
    // §5.2: even without a comparison track, the card still renders heading + warnings,
    // but it MUST NOT show a standalone primary-finish row (no duplication of the header).
    const { milestone, parent, child } = overflowingHierarchy();
    const { container } = render(<ProjectScheduleSummary project={project({ plan: { start: "2026-09-05", finish: "2026-09-10" } })} projectId={projectId} onNavigate={vi.fn()} locale="en" milestones={[milestone]} scheduling={primaryOnlyScheduling} tasks={[parent, child]} />);

    expect(screen.getByText("Schedule overflow")).toBeTruthy();
    expect(container.querySelector("dl")).toBeNull();
  });

  it("reads primary and comparison finishes from their configured tracks and signs the variance (track-agnostic)", () => {
    // Primary track `working` finishes BEFORE comparison track `forecast` => negative variance.
    // The `estimate` (workload) finish must never appear as a project finish label here.
    render(<ProjectScheduleSummary project={project({ working: { finish: "2026-04-10" }, forecast: { finish: "2026-05-01" }, estimate: { finish: "2026-06-20" } }, { primary_track: "working", workload_track: "estimate", comparison_track: "forecast" })} projectId={projectId} onNavigate={vi.fn()} locale="en" scheduling={multiTrackScheduling} />);
    const primaryRow = screen.getByText("Primary schedule").closest("dt")!.parentElement!;
    expect(primaryRow.querySelector("dd")!.textContent).toMatch(/Apr.{1,3}10/);
    expect(primaryRow.textContent).not.toMatch(/May|Jun/u);
    const comparisonRow = screen.getByText("Comparison schedule").closest("dt")!.parentElement!;
    expect(comparisonRow.querySelector("dd")!.textContent).toMatch(/May.{1,3}1/);
    const variance = screen.getByText("Variance").parentElement!;
    expect(variance.textContent).toMatch(/-21 days/);
  });

  it("hides the comparison card when the comparison track equals the primary track", () => {
    // §5.3: a comparison track that points at the same slug as the primary track must not
    // duplicate the primary finish as a second row.
    const { container } = render(<ProjectScheduleSummary project={project({ plan: { finish: "2026-03-20" }, target: { finish: "2026-02-28" } }, { primary_track: "plan", comparison_track: "plan" })} projectId={projectId} onNavigate={vi.fn()} locale="en" scheduling={scheduling} />);
    expect(container.firstChild).toBeNull();
  });

  it("localizes the variance for Russian without leaking the English day abbreviation", () => {
    render(<ProjectScheduleSummary project={project({ plan: { finish: "2026-03-20" }, target: { finish: "2026-02-28" } }, { primary_track: "plan", comparison_track: "target" })} projectId={projectId} onNavigate={vi.fn()} locale="ru" scheduling={scheduling} />);
    const variance = screen.getByText("Отклонение").parentElement!;
    expect(variance.textContent).toMatch(/\+20 дн\./u);
    expect(variance.textContent).not.toMatch(/ d/u);
  });
});

describe("SchedulingOverflowWarnings", () => {
  it("renders warnings as plain text when onOpenGantt is omitted", () => {
    render(<SchedulingOverflowWarnings locale="en" trackTitle={() => "Plan"} warnings={[{ track: "plan", field: "finish", declared: "2026-09-05", rolled: "2026-09-01" }]} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(/set to/u)).toBeTruthy();
  });

  it("renders warnings as activatable buttons when onOpenGantt is provided", () => {
    const onOpenGantt = vi.fn();
    render(<SchedulingOverflowWarnings locale="en" trackTitle={() => "Plan"} warnings={[{ track: "plan", field: "finish", declared: "2026-09-05", rolled: "2026-09-01" }]} onOpenGantt={onOpenGantt} />);
    const button = screen.getByRole("button", { name: /set to/u });
    fireEvent.click(button);
    expect(onOpenGantt).toHaveBeenCalledTimes(1);
  });
});
