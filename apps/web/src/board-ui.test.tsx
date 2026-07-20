// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitPmApi } from "./api.js";
import { BoardWorkspace } from "./board-ui.js";
import type { DraftStatus, EntityResult, GitPmDocument } from "./types.js";

const draft: DraftStatus = { draft_id: "DRF-BOARD", owner_gitlab_user_id: "42", branch: "gitpm/42/DRF-BOARD", base_commit: "a".repeat(40), writer_mode: "ui", state: "open", fingerprint: "b".repeat(64), created_at: "2026-07-11T00:00:00.000Z", updated_at: "2026-07-11T00:00:00.000Z" };
const projectId = "P-26-111111";
const taskId = "T-26-222222";
const milestoneId = "M-26-333333";

class BoardApi {
  revision = 0;
  entities: EntityResult[] = [
    this.result({ schema: "gitpm/project@1", id: projectId, name: "Alpha", status: "backlog", lifecycle: "active" }),
    this.result({ schema: "gitpm/milestone@1", id: milestoneId, project: projectId, name: "Beta", lifecycle: "active" }),
    this.result({ schema: "gitpm/task@1", id: taskId, project: projectId, milestone: milestoneId, title: "Drag me", type: "task", status: "backlog", lifecycle: "active" }),
  ];
  private result(document: GitPmDocument): EntityResult { this.revision += 1; const project = String(document.project ?? ""); const path = document.schema === "gitpm/project@1" ? `projects/${document.id}/project.yaml` : document.schema === "gitpm/task@1" ? `projects/${project}/tasks/${document.id}.yaml` : `projects/${project}/views/${document.id}.yaml`; return { document, path, blob_id: String(this.revision).padStart(40, "a"), draft_fingerprint: String(this.revision).padStart(64, "b") }; }
  async listEntities(_draftId: string, type: string, project?: string) { const schemas: Record<string, string> = { projects: "gitpm/project@1", tasks: "gitpm/task@1", milestones: "gitpm/milestone@1", views: "gitpm/saved-view@1" }; return this.entities.filter((item) => item.document.schema === schemas[type] && (project === undefined || item.document.project === project)); }
  async createEntity(_draftId: string, _type: string, _fingerprint: string, document: GitPmDocument) { const result = this.result(document); this.entities.push(result); return result; }
  async updateEntity(_draftId: string, _type: string, entity: EntityResult, _fingerprint: string, document: GitPmDocument) { const result = this.result(document); this.entities = this.entities.map((item) => item.document.id === entity.document.id ? result : item); return result; }
  async getConfiguration(_draftId: string, kind: "statuses" | "issue-types"): Promise<EntityResult> { const document = (kind === "statuses" ? { schema: "gitpm/statuses@1", id: "CONFIG-STATUSES", lifecycle: "active", statuses: [{ slug: "backlog", title: "Backlog", active: true }, { slug: "done", title: "Done", active: true }] } : { schema: "gitpm/issue-types@1", id: "CONFIG-TYPES", lifecycle: "active", issue_types: [{ slug: "task", title: "Task", active: true }, { slug: "bug", title: "Bug", active: true }] }) as GitPmDocument; return this.result(document); }
}

afterEach(cleanup);
describe("Board and Saved Views", () => {
  it("drags a Task between status columns and reopens persisted filters", async () => {
    const entityApi = new BoardApi(); const api = entityApi as unknown as GitPmApi;
    const onNavigate = vi.fn();
    const { container } = render(<BoardWorkspace api={api} draft={draft} locale="en" onNavigate={onNavigate} onChanged={vi.fn(async () => undefined)} />);
    const card = await screen.findByText("Drag me");
    expect(container.querySelector(".board-milestone")?.textContent).toBe("Beta");
    fireEvent.click(screen.getByRole("button", { name: "Beta" }));
    expect(onNavigate).toHaveBeenCalledWith("stages", { projectId, stageId: milestoneId });
    fireEvent.click(card);
    expect(onNavigate).toHaveBeenCalledWith("tasks", { projectId, taskId });
    const data = new Map<string, string>(); const dataTransfer = { setData: (kind: string, value: string) => data.set(kind, value), getData: (kind: string) => data.get(kind) ?? "" };
    fireEvent.dragStart(card.closest("article")!, { dataTransfer });
    const doneColumn = container.querySelector<HTMLElement>('[data-status="done"]')!;
    fireEvent.dragOver(doneColumn, { dataTransfer }); fireEvent.drop(doneColumn, { dataTransfer });
    expect(doneColumn.textContent).toContain("Drag me");
    expect(container.querySelector(".workspace-loading")).toBeNull();
    await waitFor(() => expect(entityApi.entities.find((item) => item.document.id === taskId)?.document.status).toBe("done"));
    await waitFor(() => expect(doneColumn.textContent).toContain("Drag me"));
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "backlog" } });
    await waitFor(() => expect(entityApi.entities.find((item) => item.document.id === taskId)?.document.status).toBe("backlog"));

    fireEvent.change(screen.getByLabelText("Status filter"), { target: { value: "done" } });
    fireEvent.change(screen.getByLabelText("Type filter"), { target: { value: "task" } });
    expect(onNavigate).toHaveBeenCalledWith("board", { projectId, query: { status: ["done"], type: ["task"] } });
    fireEvent.change(screen.getByLabelText("Milestone"), { target: { value: milestoneId } });
    expect(onNavigate).toHaveBeenCalledWith("board", { projectId, query: { status: ["done"], type: ["task"], milestone: [milestoneId] } });
    fireEvent.click(screen.getByText("Create and manage saved views"));
    fireEvent.change(screen.getByLabelText("View name"), { target: { value: "Done tasks" } });
    fireEvent.click(screen.getByRole("button", { name: "Save view" }));
    expect(await screen.findByRole("button", { name: /Done tasks/u })).toBeTruthy();
    const saved = entityApi.entities.find((item) => item.document.schema === "gitpm/saved-view@1")!;
    expect(saved.document).toMatchObject({ kind: "board", group_by: "status", filters: { statuses: ["done"], types: ["task"], milestones: [milestoneId] } });

    fireEvent.change(screen.getByLabelText("Status filter"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Type filter"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Milestone"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Saved view"), { target: { value: saved.document.id } });
    expect((screen.getByLabelText("Status filter") as HTMLSelectElement).value).toBe("done");
    expect((screen.getByLabelText("Type filter") as HTMLSelectElement).value).toBe("task");
    expect((screen.getByLabelText("Milestone") as HTMLSelectElement).value).toBe(milestoneId);
    expect(onNavigate).toHaveBeenCalledWith("board", { projectId, query: { status: ["done"], type: ["task"], milestone: [milestoneId], view: [saved.document.id] } });
  });

  it("restores project, status, type and saved view route state", async () => {
    const api = new BoardApi() as unknown as GitPmApi;
    render(<BoardWorkspace api={api} draft={draft} locale="en" initialProjectId={projectId} initialStatusFilter="done" initialTypeFilter="task" initialMilestoneFilter={milestoneId} initialViewId="V-26-ROUTED" onChanged={vi.fn(async () => undefined)} />);
    expect(await screen.findByLabelText("Status filter")).toHaveProperty("value", "done");
    expect(screen.getByLabelText("Type filter")).toHaveProperty("value", "task");
    expect(screen.getByLabelText("Milestone")).toHaveProperty("value", milestoneId);
  });
});
