// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitPmApi } from "./api.js";
import { buildGanttModel, dependencyPath, GanttWorkspace } from "./gantt-ui.js";
import type { DraftStatus, EntityDocument, EntityResult } from "./types.js";

const projectId = "P-26-111111";
const draft: DraftStatus = { draft_id: "DRF-GANTT", owner_gitlab_user_id: "42", branch: "gitpm/42/DRF-GANTT", base_commit: "a".repeat(40), writer_mode: "ui", state: "open", fingerprint: "b".repeat(64), created_at: "2026-07-11T00:00:00.000Z", updated_at: "2026-07-11T00:00:00.000Z" };
const result = (document: EntityDocument): EntityResult => ({ document, path: `${document.id}.yaml`, blob_id: "c".repeat(40), draft_fingerprint: "d".repeat(64) });
const task = (suffix: string, title: string, start?: string, due?: string, extra: Record<string, unknown> = {}) => result({ schema: "gitpm/task@1", id: `T-26-${suffix.repeat(6)}`, project: projectId, title, type: "task", status: "backlog", lifecycle: "active", ...(start === undefined ? {} : { start }), ...(due === undefined ? {} : { due }), ...extra });

const parent = task("2", "Plan release", "2026-07-01", "2026-07-05");
const child = task("3", "Build API", "2026-07-02", "2026-07-03", { parent: parent.document.id, milestone: "M-26-888888" });
const dependent = task("4", "Ship UI", "2026-07-04", "2026-07-06", { depends_on: [child.document.id] });
const review = task("5", "Review", "2026-07-06", "2026-07-07", { depends_on: [dependent.document.id] });
const launch = task("6", "Launch", "2026-07-08", "2026-07-08", { depends_on: [review.document.id, dependent.document.id] });
const undated = task("7", "Undated");
const archived = task("9", "Archived", "2026-07-01", "2026-07-02", { lifecycle: "archived" });
const milestone = result({ schema: "gitpm/milestone@1", id: "M-26-888888", project: projectId, name: "Beta", due: "2026-07-08", lifecycle: "active" });

afterEach(cleanup);
describe("read-only Gantt", () => {
  it("routes dependencies orthogonally into the centers of task bars", () => {
    expect(dependencyPath(100, 27, 180, 85)).toBe("M 100 27 H 116 V 85 H 180");
    expect(dependencyPath(180, 27, 100, 85)).toBe("M 180 27 H 196 V 56 H 84 V 85 H 100");
  });

  it("builds deterministic bars, hierarchy, milestones, and dependency edges", () => {
    const model = buildGanttModel([parent, child, dependent, review, launch, undated, archived], [milestone])!;
    expect(model.rows).toHaveLength(5);
    expect(model.rows.map((row) => row.title)).not.toContain("Undated");
    expect(model.rows.map((row) => row.title)).not.toContain("Archived");
    expect(model.rows.find((row) => row.id === child.document.id)).toMatchObject({ startOffset: 1, duration: 2, depth: 1, milestone: milestone.document.id });
    expect(model.milestones).toEqual([{ id: milestone.document.id, name: "Beta", due: "2026-07-08", offset: 7 }]);
    expect(model.dependencies).toEqual([{ from: child.document.id, to: dependent.document.id }, { from: dependent.document.id, to: review.document.id }, { from: review.document.id, to: launch.document.id }, { from: dependent.document.id, to: launch.document.id }]);
  });

  it("renders five bars and cannot mutate repository data", async () => {
    const updateEntity = vi.fn(); const createEntity = vi.fn(); const deleteEntity = vi.fn();
    const onNavigate = vi.fn();
    const entities = [result({ schema: "gitpm/project@1", id: projectId, name: "Beta portfolio", status: "backlog", lifecycle: "active" }), parent, child, dependent, review, launch, undated, archived, milestone];
    const api = { listEntities: vi.fn(async (_draftId: string, type: string, project?: string) => entities.filter((item) => {
      const schemas: Record<string, string> = { projects: "gitpm/project@1", tasks: "gitpm/task@1", milestones: "gitpm/milestone@1" };
      return item.document.schema === schemas[type] && (project === undefined || item.document.project === project);
    })), updateEntity, createEntity, deleteEntity } as unknown as GitPmApi;
    const { container } = render(<GanttWorkspace api={api} draft={draft} locale="en" onNavigate={onNavigate} />);
    await waitFor(() => expect(container.querySelectorAll(".gantt-bar")).toHaveLength(5));
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
