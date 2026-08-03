// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectScheduleSummary } from "./project-schedule-summary.js";
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

const project = (schedules: Record<string, unknown>, planning?: Record<string, unknown>): EntityDocument =>
  ({ schema: "gitpm/project@2", id: "P-26-1", name: "Demo", status: "in-progress", lifecycle: "active", ...(planning === undefined ? {} : { planning }), schedules } as EntityDocument);

afterEach(cleanup);

describe("ProjectScheduleSummary", () => {
  it("renders nothing without schedule finishes", () => {
    const { container } = render(<ProjectScheduleSummary project={project({})} locale="en" scheduling={primaryOnlyScheduling} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing for a primary-only project with no overflow warnings (no header duplication)", () => {
    // §5.3: a primary finish alone is already shown in the project header and must not be
    // duplicated as a standalone card just to show one finish line.
    const { container } = render(<ProjectScheduleSummary project={project({ plan: { finish: "2026-03-20" } })} locale="en" scheduling={primaryOnlyScheduling} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows primary and comparison finish with the signed variance", () => {
    render(<ProjectScheduleSummary project={project({ plan: { finish: "2026-03-20" }, target: { finish: "2026-02-28" } }, { primary_track: "plan", comparison_track: "target" })} locale="en" scheduling={scheduling} />);
    expect(screen.getByText("Primary finish").parentElement?.textContent).toContain("Mar");
    expect(screen.getByText("Comparison finish")).toBeTruthy();
    expect(screen.getByText("Variance").parentElement?.textContent).toMatch(/\+20 d/);
  });

  it("renders project overflow warnings from resolved milestone task roots", () => {
    const milestone = { document: { schema: "gitpm/milestone@2", id: "M-1", project: "P-26-1", name: "Release", lifecycle: "active" }, path: "m.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const parent = { document: { schema: "gitpm/task@2", id: "T-parent", project: "P-26-1", milestone: "M-1", title: "Parent", type: "task", status: "backlog", lifecycle: "active" }, path: "parent.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const child = { document: { schema: "gitpm/task@2", id: "T-child", project: "P-26-1", milestone: "M-1", parent: "T-parent", title: "Child", type: "task", status: "backlog", lifecycle: "active", schedules: { plan: { start: "2026-09-01", finish: "2026-09-15" } } }, path: "child.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;

    render(<ProjectScheduleSummary project={project({ plan: { start: "2026-09-05", finish: "2026-09-10" } })} locale="en" milestones={[milestone]} scheduling={scheduling} tasks={[parent, child]} />);

    const warning = screen.getByText("Schedule overflow").parentElement!;
    expect(warning.textContent).toContain("Plan");
    expect(warning.textContent).toContain("declared Sep 5, 2026");
    expect(warning.textContent).toContain("rolled Sep 1, 2026");
    expect(warning.textContent).toContain("declared Sep 10, 2026");
    expect(warning.textContent).toContain("rolled Sep 15, 2026");
  });

  it("renders overflow warnings without a primary-finish row when comparison is absent but warnings exist", () => {
    // §5.2: even without a comparison track, the card still renders heading + warnings,
    // but it MUST NOT show a standalone primary-finish row (no duplication of the header).
    const milestone = { document: { schema: "gitpm/milestone@2", id: "M-1", project: "P-26-1", name: "Release", lifecycle: "active" }, path: "m.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const parent = { document: { schema: "gitpm/task@2", id: "T-parent", project: "P-26-1", milestone: "M-1", title: "Parent", type: "task", status: "backlog", lifecycle: "active" }, path: "parent.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;
    const child = { document: { schema: "gitpm/task@2", id: "T-child", project: "P-26-1", milestone: "M-1", parent: "T-parent", title: "Child", type: "task", status: "backlog", lifecycle: "active", schedules: { plan: { start: "2026-09-01", finish: "2026-09-15" } } }, path: "child.yaml", blob_id: "a", draft_fingerprint: "f" } as EntityResult;

    const { container } = render(<ProjectScheduleSummary project={project({ plan: { start: "2026-09-05", finish: "2026-09-10" } })} locale="en" milestones={[milestone]} scheduling={primaryOnlyScheduling} tasks={[parent, child]} />);

    expect(screen.getByText("Schedule overflow")).toBeTruthy();
    expect(screen.queryByText("Primary finish")).toBeNull();
    expect(container.querySelector("dl")).toBeNull();
  });

  it("reads primary and comparison finishes from their configured tracks and signs the variance (track-agnostic)", () => {
    // Primary track `working` finishes BEFORE comparison track `forecast` => negative variance.
    // The `estimate` (workload) finish must never appear as a project finish label here.
    render(<ProjectScheduleSummary project={project({ working: { finish: "2026-04-10" }, forecast: { finish: "2026-05-01" }, estimate: { finish: "2026-06-20" } }, { primary_track: "working", workload_track: "estimate", comparison_track: "forecast" })} locale="en" scheduling={multiTrackScheduling} />);
    const primary = screen.getByText("Primary finish").parentElement!;
    expect(primary.textContent).toMatch(/Apr.{1,3}10/);
    expect(primary.textContent).not.toMatch(/May|Jun/u);
    const comparison = screen.getByText("Comparison finish").parentElement!;
    expect(comparison.textContent).toMatch(/May.{1,3}1/);
    const variance = screen.getByText("Variance").parentElement!;
    expect(variance.textContent).toMatch(/-21 d/);
  });
});
