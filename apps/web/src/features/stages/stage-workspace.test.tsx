// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitPmApi } from "../../api.js";
import type { DraftStatus, EntityResult, GitPmDocument } from "../../types.js";
import { StageWorkspace } from "./stage-workspace.js";

const fingerprint = "b".repeat(64);
const draft: DraftStatus = { draft_id: "DRF-STAGES", owner_gitlab_user_id: "42", branch: "gitpm/42/DRF-STAGES", base_commit: "a".repeat(40), writer_mode: "ui", state: "open", fingerprint, created_at: "2026-07-10T00:00:00.000Z", updated_at: "2026-07-10T00:00:00.000Z" };
const result = (document: GitPmDocument): EntityResult => ({ document, path: `${document.id}.yaml`, blob_id: "a".repeat(40), draft_fingerprint: fingerprint });

const project = result({ schema: "gitpm/project@1", id: "P-26-111111", name: "Alpha", status: "backlog", lifecycle: "active" });
const stage = result({ schema: "gitpm/milestone@1", id: "M-26-222222", project: project.document.id, name: "Launch", lifecycle: "active", due: "2026-08-01" });
const linked = result({ schema: "gitpm/task@1", id: "T-26-333333", project: project.document.id, milestone: stage.document.id, title: "Linked task", type: "task", status: "done", lifecycle: "active", estimate_hours: 8 });
const other = result({ schema: "gitpm/task@1", id: "T-26-444444", project: project.document.id, title: "Without stage", type: "task", status: "backlog", lifecycle: "active" });

function api() {
  const createEntity = vi.fn(async (_draftId: string, _type: string, _fingerprint: string, document: GitPmDocument) => result(document));
  return {
    projectWorkspace: vi.fn(async () => ({ project, milestones: [stage], tasks: [linked, other], draft_fingerprint: fingerprint })),
    getConfiguration: vi.fn(async (_draftId: string, kind: "statuses" | "issue-types") => result(kind === "statuses"
      ? { schema: "gitpm/statuses@1", id: "CONFIG-STATUSES", lifecycle: "active", statuses: [{ slug: "backlog", title: "Backlog", active: true }, { slug: "done", title: "Done", active: true }] }
      : { schema: "gitpm/issue-types@1", id: "CONFIG-TYPES", lifecycle: "active", issue_types: [{ slug: "task", title: "Task", active: true }] })),
    createEntity,
  } as unknown as GitPmApi & { createEntity: typeof createEntity };
}

afterEach(cleanup);

describe("stage workspace", () => {
  it("opens an entire stage card as a first-class route", async () => {
    const client = api(); const onNavigate = vi.fn();
    render(<StageWorkspace api={client} draft={draft} locale="en" onChanged={vi.fn(async () => undefined)} onNavigate={onNavigate} projectId={project.document.id} />);

    fireEvent.click(await screen.findByRole("button", { name: /Launch/u }));
    expect(onNavigate).toHaveBeenCalledWith("stages", { projectId: project.document.id, stageId: stage.document.id });
    expect(screen.getByRole("button", { name: /Tasks without a milestone/u }).textContent).toContain("Tasks: 1");
  });

  it("shows only stage tasks and creates a task inside the stage context", async () => {
    const client = api(); const onNavigate = vi.fn();
    render(<StageWorkspace api={client} draft={draft} locale="en" onChanged={vi.fn(async () => undefined)} onNavigate={onNavigate} projectId={project.document.id} stageId={stage.document.id} />);

    expect(await screen.findByRole("heading", { name: "Launch" })).toBeTruthy();
    expect(screen.getByText("Linked task")).toBeTruthy();
    expect(screen.queryByText("Without stage")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Linked task/u }));
    expect(onNavigate).toHaveBeenCalledWith("tasks", { projectId: project.document.id, taskId: linked.document.id, query: { milestone: [stage.document.id] } });

    fireEvent.click(screen.getByRole("button", { name: /New task in milestone/u }));
    const dialog = screen.getByRole("dialog", { name: "New task in milestone" });
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Created here" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(client.createEntity).toHaveBeenCalled());
    expect(client.createEntity.mock.calls[0]?.[3]).toMatchObject({ project: project.document.id, milestone: stage.document.id, title: "Created here" });
  });
});
