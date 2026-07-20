// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitPmApi } from "../../api.js";
import type { DraftStatus, EntityResult, GitPmDocument } from "../../types.js";
import { ProjectPlanWorkspace } from "../projects/project-plan-workspace.js";
import { StageWorkspace } from "./stage-workspace.js";

const fingerprint = "b".repeat(64);
const draft: DraftStatus = { draft_id: "DRF-STAGES", owner_gitlab_user_id: "42", branch: "gitpm/42/DRF-STAGES", base_commit: "a".repeat(40), writer_mode: "ui", state: "open", fingerprint, created_at: "2026-07-10T00:00:00.000Z", updated_at: "2026-07-10T00:00:00.000Z" };
const result = (document: GitPmDocument): EntityResult => ({ document, path: `${document.id}.yaml`, blob_id: "a".repeat(40), draft_fingerprint: fingerprint });

const project = result({ schema: "gitpm/project@1", id: "P-26-111111", name: "Alpha", status: "backlog", lifecycle: "active" });
const stage = result({ schema: "gitpm/milestone@1", id: "M-26-222222", project: project.document.id, name: "Launch", lifecycle: "active", due: "2026-08-01" });
const laterStage = result({ schema: "gitpm/milestone@1", id: "M-26-777777", project: project.document.id, name: "Follow-up", lifecycle: "active", due: "2026-09-01" });
const linked = result({ schema: "gitpm/task@1", id: "T-26-333333", project: project.document.id, milestone: stage.document.id, title: "Linked task", type: "task", status: "done", lifecycle: "active", estimate_hours: 20 });
const other = result({ schema: "gitpm/task@1", id: "T-26-444444", project: project.document.id, title: "Without stage", type: "task", status: "backlog", lifecycle: "active" });
const urgent = result({ schema: "gitpm/task@1", id: "T-26-555555", project: project.document.id, milestone: stage.document.id, title: "Zebra task", type: "task", status: "backlog", lifecycle: "active", due: "2026-07-20", estimate_hours: 2 });
const large = result({ schema: "gitpm/task@1", id: "T-26-666666", project: project.document.id, milestone: stage.document.id, title: "Alpha task", type: "task", status: "backlog", lifecycle: "active", due: "2026-09-01", estimate_hours: 13 });

function api() {
  let currentProject = project;
  let currentStages = [stage, laterStage];
  const createEntity = vi.fn(async (_draftId: string, _type: string, _fingerprint: string, document: GitPmDocument) => result(document));
  const updateEntity = vi.fn(async (_draftId: string, type: string, _entity: EntityResult, _fingerprint: string, document: GitPmDocument) => {
    const updated = result(document);
    if (type === "projects") currentProject = updated;
    if (type === "milestones") currentStages = currentStages.map((item) => item.document.id === document.id ? updated : item);
    return updated;
  });
  return {
    projectWorkspace: vi.fn(async () => ({ project: currentProject, milestones: currentStages, tasks: [linked, other, large, urgent], draft_fingerprint: fingerprint })),
    getConfiguration: vi.fn(async (_draftId: string, kind: "statuses" | "issue-types") => result(kind === "statuses"
      ? { schema: "gitpm/statuses@1", id: "CONFIG-STATUSES", lifecycle: "active", statuses: [{ slug: "backlog", title: "Backlog", active: true }, { slug: "done", title: "Done", active: true }] }
      : { schema: "gitpm/issue-types@1", id: "CONFIG-TYPES", lifecycle: "active", issue_types: [{ slug: "task", title: "Task", active: true }] })),
    listEntities: vi.fn(async () => []),
    createEntity,
    updateEntity,
  } as unknown as GitPmApi & { createEntity: typeof createEntity; updateEntity: typeof updateEntity };
}

afterEach(cleanup);

describe("project plan and stage workspace", () => {
  it("shows every task inside the project plan and opens a stage as a first-class route", async () => {
    const client = api(); const onNavigate = vi.fn();
    render(<ProjectPlanWorkspace api={client} draft={draft} locale="en" onChanged={vi.fn(async () => undefined)} onNavigate={onNavigate} projectId={project.document.id} />);

    const stageHeading = await screen.findByRole("heading", { name: "Launch" });
    const stageCard = stageHeading.closest<HTMLElement>("article")!;
    expect(screen.getByText("Linked task")).toBeTruthy();
    expect(screen.getByText("Without stage")).toBeTruthy();
    fireEvent.click(within(stageCard).getByRole("button", { name: /Milestone: Launch/u }));
    expect(onNavigate).toHaveBeenCalledWith("stages", { projectId: project.document.id, stageId: stage.document.id });

    fireEvent.click(within(stageCard).getByRole("button", { name: /Linked task/u }));
    expect(onNavigate).toHaveBeenLastCalledWith("tasks", { projectId: project.document.id, taskId: linked.document.id });

    fireEvent.click(within(stageCard).getByRole("button", { name: /New task/u }));
    const dialog = screen.getByRole("dialog", { name: "New task" });
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Created from plan" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(client.createEntity).toHaveBeenCalled());
    expect(client.createEntity.mock.calls[0]?.[3]).toMatchObject({ project: project.document.id, milestone: stage.document.id, title: "Created from plan" });
  });

  it("numbers milestones and tasks and persists their manual order", async () => {
    const client = api(); const onNavigate = vi.fn();
    render(<ProjectPlanWorkspace api={client} draft={draft} locale="en" onChanged={vi.fn(async () => undefined)} onNavigate={onNavigate} projectId={project.document.id} />);

    const stageHeading = await screen.findByRole("heading", { name: "Launch" });
    const stageCard = stageHeading.closest<HTMLElement>("article")!;
    const titles = () => Array.from(stageCard.querySelectorAll(".project-plan-task-row strong"), (element) => element.textContent);
    expect(titles()).toEqual(["Zebra task", "Alpha task", "Linked task"]);
    expect(stageCard.querySelector(".project-plan-stage-kind")?.textContent).toBe(`Milestone 1. ${stage.document.id}.`);
    expect(stageCard.querySelector(".project-plan-task-kind")?.textContent).toBe(`Task 1. ${urgent.document.id}.`);

    fireEvent.click(within(stageCard).getByRole("button", { name: "Move task 2 up" }));
    expect(titles()).toEqual(["Alpha task", "Zebra task", "Linked task"]);
    expect(document.querySelector(".workspace-loading")).toBeNull();
    await waitFor(() => expect(titles()).toEqual(["Alpha task", "Zebra task", "Linked task"]));
    expect(client.updateEntity.mock.calls[0]?.[1]).toBe("milestones");
    expect(client.updateEntity.mock.calls[0]?.[4]).toMatchObject({ task_order: [large.document.id, urgent.document.id, linked.document.id] });

    const moveMilestoneDown = screen.getByRole<HTMLButtonElement>("button", { name: "Move milestone 1 down" });
    await waitFor(() => expect(moveMilestoneDown.disabled).toBe(false));
    fireEvent.click(moveMilestoneDown);
    await waitFor(() => expect(stageCard.querySelector(".project-plan-stage-kind")?.textContent).toBe(`Milestone 2. ${stage.document.id}.`));
    expect(client.updateEntity.mock.calls[1]?.[1]).toBe("projects");
    expect(client.updateEntity.mock.calls[1]?.[4]).toMatchObject({ milestone_order: [laterStage.document.id, stage.document.id] });
  });

  it("shows only stage tasks and creates a task inside the stage context", async () => {
    const client = api(); const onNavigate = vi.fn();
    render(<StageWorkspace api={client} draft={draft} locale="en" onChanged={vi.fn(async () => undefined)} onNavigate={onNavigate} projectId={project.document.id} stageId={stage.document.id} />);

    expect(await screen.findByRole("heading", { name: "Launch" })).toBeTruthy();
    expect(screen.getByText("Linked task")).toBeTruthy();
    expect(screen.queryByText("Without stage")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Linked task/u }));
    expect(onNavigate).toHaveBeenCalledWith("tasks", { projectId: project.document.id, taskId: linked.document.id });

    fireEvent.click(screen.getByRole("button", { name: /New task in milestone/u }));
    const dialog = screen.getByRole("dialog", { name: "New task in milestone" });
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Created here" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(client.createEntity).toHaveBeenCalled());
    expect(client.createEntity.mock.calls[0]?.[3]).toMatchObject({ project: project.document.id, milestone: stage.document.id, title: "Created here" });
  });
});
