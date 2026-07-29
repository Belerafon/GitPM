// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitPmApi } from "./api.js";
import { buildGanttModel, dependencyPath, GanttWorkspace } from "./gantt-ui.js";
import type { DraftStatus, EntityDocument, EntityResult } from "./types.js";

const projectId = "P-26-111111";
const draft: DraftStatus = { draft_id: "DRF-GANTT", owner_gitlab_user_id: "42", branch: "gitpm/42/DRF-GANTT", base_commit: "a".repeat(40), writer_mode: "ui", state: "open", fingerprint: "b".repeat(64), created_at: "2026-07-11T00:00:00.000Z", updated_at: "2026-07-11T00:00:00.000Z" };
const result = (document: EntityDocument): EntityResult => ({ document, path: `${document.id}.yaml`, blob_id: "c".repeat(40), draft_fingerprint: "d".repeat(64) });
const task = (suffix: string, title: string, start?: string, due?: string, extra: Record<string, unknown> = {}) => {
  const extraSchedules = typeof extra.schedules === "object" && extra.schedules !== null ? extra.schedules as Record<string, Record<string, unknown>> : undefined;
  const planExtra = extraSchedules?.plan ?? {};
  const otherTracks = extraSchedules === undefined ? {} : Object.fromEntries(Object.entries(extraSchedules).filter(([track]) => track !== "plan"));
  const planWindow = { ...(start === undefined ? {} : { start }), ...(due === undefined ? {} : { finish: due }), ...planExtra };
  const { schedules: _omitted, ...rest } = extra;
  return result({ schema: "gitpm/task@2", id: `T-26-${suffix.repeat(6)}`, project: projectId, title, type: "task", status: "backlog", lifecycle: "active", schedules: { plan: planWindow, ...otherTracks }, ...rest });
};

const parent = task("2", "Plan release", "2026-07-01", "2026-07-05");
const child = task("3", "Build API", "2026-07-02", "2026-07-03", { parent: parent.document.id, milestone: "M-26-888888" });
const grandchild = task("8", "Implement endpoint", "2026-07-03", "2026-07-03", { parent: child.document.id, milestone: "M-26-888888" });
const dependent = task("4", "Ship UI", "2026-07-04", "2026-07-06", { schedules: { plan: { depends_on: [child.document.id] } } });
const review = task("5", "Review", "2026-07-06", "2026-07-07", { schedules: { plan: { depends_on: [dependent.document.id] } } });
const launch = task("6", "Launch", "2026-07-08", "2026-07-08", { schedules: { plan: { depends_on: [review.document.id, dependent.document.id] } } });
const undated = task("7", "Undated");
const archived = task("9", "Archived", "2026-07-01", "2026-07-02", { lifecycle: "archived" });
const milestone = result({ schema: "gitpm/milestone@2", id: "M-26-888888", project: projectId, name: "Beta", lifecycle: "active", schedules: { plan: { finish: "2026-07-08" } } });

afterEach(cleanup);
describe("read-only Gantt", () => {
  it("routes dependencies orthogonally into the centers of task bars", () => {
    expect(dependencyPath(100, 27, 180, 85)).toBe("M 100 27 H 116 V 85 H 180");
    expect(dependencyPath(180, 27, 100, 85)).toBe("M 180 27 H 196 V 56 H 84 V 85 H 100");
  });

  it("builds deterministic bars, hierarchy, milestones, and dependency edges", () => {
    const model = buildGanttModel([parent, child, grandchild, dependent, review, launch, undated, archived], [milestone], new Map(), "plan")!;
    expect(model.rows).toHaveLength(6);
    expect(model.rows.map((row) => row.title)).not.toContain("Undated");
    expect(model.rows.map((row) => row.title)).not.toContain("Archived");
    expect(model.rows.find((row) => row.id === child.document.id)).toMatchObject({ startOffset: 1, duration: 2, depth: 1, milestone: milestone.document.id });
    expect(model.rows.find((row) => row.id === grandchild.document.id)).toMatchObject({ startOffset: 2, duration: 1, depth: 2, milestone: milestone.document.id });
    expect(model.rows.slice(0, 3).map((row) => row.id)).toEqual([parent.document.id, child.document.id, grandchild.document.id]);
    expect(model.milestones).toEqual([{ id: milestone.document.id, name: "Beta", due: "2026-07-08", offset: 7 }]);
    expect(model.dependencies).toEqual([{ from: child.document.id, to: dependent.document.id }, { from: dependent.document.id, to: review.document.id }, { from: review.document.id, to: launch.document.id }, { from: dependent.document.id, to: launch.document.id }]);
  });

  it("overlays secondary schedule tracks as thin bars under the primary bar", () => {
    const primary = task("P", "Primary", "2026-07-01", "2026-07-10", { schedules: { target: { start: "2026-07-03", finish: "2026-07-07" } } });
    const model = buildGanttModel([primary], [], new Map(), "plan")!;
    const row = model.rows.find((item) => item.id === primary.document.id)!;
    expect(row.start).toBe("2026-07-01");
    expect(row.overlays).toEqual([{ track: "target", start: "2026-07-03", finish: "2026-07-07", startOffset: 2, duration: 5 }]);
  });

  it("renders discrete actual-activity markers from time entries", () => {
    const task1 = task("A", "Active", "2026-07-01", "2026-07-10");
    const actual = new Map<string, readonly { readonly date: string; readonly hours: number }[]>([[task1.document.id, [{ date: "2026-07-02", hours: 3 }, { date: "2026-07-09", hours: 5 }]]]);
    const model = buildGanttModel([task1], [], actual, "plan")!;
    expect(model.rows[0]!.actual).toEqual([{ date: "2026-07-02", hours: 3, offset: 1 }, { date: "2026-07-09", hours: 5, offset: 8 }]);
  });

  it("renders six bars and cannot mutate repository data", async () => {
    const updateEntity = vi.fn(); const createEntity = vi.fn(); const deleteEntity = vi.fn();
    const onNavigate = vi.fn();
    const entities = [result({ schema: "gitpm/project@2", id: projectId, name: "Beta portfolio", status: "backlog", lifecycle: "active" }), parent, child, grandchild, dependent, review, launch, undated, archived, milestone];
    const api = { listEntities: vi.fn(async (_draftId: string, type: string, project?: string) => entities.filter((item) => {
      const schemas: Record<string, string> = { projects: "gitpm/project@2", tasks: "gitpm/task@2", milestones: "gitpm/milestone@2" };
      return item.document.schema === schemas[type] && (project === undefined || item.document.project === project);
    })), getConfiguration: vi.fn(async (_draftId: string, kind: string) => ({ document: kind === "schedule-tracks" ? { schema: "gitpm/schedule-tracks@1", tracks: [{ slug: "plan", title: "Plan", kind: "manual", capabilities: ["dates", "effort", "dependencies"] }], defaults: { enabled_tracks: ["plan"], primary_track: "plan", workload_track: "plan", dashboard_tracks: ["plan"] } } : { schema: "gitpm/statuses@2", statuses: [] }, path: kind, blob_id: "a".repeat(40), draft_fingerprint: "b".repeat(64) })), updateEntity, createEntity, deleteEntity } as unknown as GitPmApi;
    const { container } = render(<GanttWorkspace api={api} draft={draft} locale="en" onNavigate={onNavigate} />);
    await waitFor(() => expect(container.querySelectorAll(".gantt-bar")).toHaveLength(6));
    expect(screen.queryByText("Undated")).toBeNull(); expect(screen.queryByText("Archived")).toBeNull();
    expect(container.querySelectorAll(".gantt-dependencies path[data-from]")).toHaveLength(4);
    expect(container.querySelector(".gantt-dependencies path[data-from]")?.getAttribute("d")).not.toContain("C");
    expect(new Set(Array.from(container.querySelectorAll<SVGPathElement>(".gantt-dependencies path[data-from]"), (path) => path.style.stroke)).size).toBe(4);
    expect(container.querySelector(`[data-branch-from="${dependent.document.id}"]`)).not.toBeNull();
    expect(container.querySelectorAll(".gantt-dependency-branch")).toHaveLength(1);
    expect(container.querySelector('[data-milestone-id]')?.getAttribute("title")).toBe("Beta: 2026-07-08");
    fireEvent.click(container.querySelector<HTMLElement>('[data-milestone-id]')!);
    expect(onNavigate).toHaveBeenCalledWith("stages", { projectId, stageId: milestone.document.id });
    expect(screen.getByLabelText("Gantt legend")).toBeTruthy();
    const bar = container.querySelector<HTMLElement>(`[data-task-id="${child.document.id}"]`)!;
    const widthBefore = bar.style.width;
    fireEvent.change(screen.getByRole("combobox", { name: "Scale" }), { target: { value: "60" } });
    expect(bar.style.width).not.toBe(widthBefore);
    fireEvent.click(bar);
    expect(onNavigate).toHaveBeenCalledWith("tasks", { projectId, taskId: child.document.id });
    fireEvent.pointerDown(bar); fireEvent.pointerMove(bar, { clientX: 400 }); fireEvent.pointerUp(bar);
    expect(updateEntity).not.toHaveBeenCalled(); expect(createEntity).not.toHaveBeenCalled(); expect(deleteEntity).not.toHaveBeenCalled();
  });
});
