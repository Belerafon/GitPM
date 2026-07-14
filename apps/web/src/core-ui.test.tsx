// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitPmApi } from "./api.js";
import { CoreWorkspace, newEntityId, SafeMarkdown } from "./core-ui.js";
import type { DraftStatus, EntityResult, GitPmDocument } from "./types.js";

const draft: DraftStatus = { draft_id: "DRF-CORE", owner_gitlab_user_id: "42", branch: "gitpm/42/DRF-CORE", base_commit: "a".repeat(40), writer_mode: "ui", state: "open", fingerprint: "b".repeat(64), created_at: "2026-07-10T00:00:00.000Z", updated_at: "2026-07-10T00:00:00.000Z" };

class EntityApi {
  entities: EntityResult[] = [];
  revision = 0;
  private result(document: GitPmDocument): EntityResult { this.revision += 1; return { document, path: `${document.id}.yaml`, blob_id: String(this.revision).padStart(40, "a"), draft_fingerprint: String(this.revision).padStart(64, "b") }; }
  async listEntities(_draftId: string, type: string, project?: string) { return this.entities.filter((item) => item.document.schema === `gitpm/${type.slice(0, -1)}@1` && (project === undefined || item.document.project === project)); }
  async createEntity(_draftId: string, _type: string, _fingerprint: string, document: GitPmDocument) { const next = this.result(document); this.entities.push(next); return next; }
  async updateEntity(_draftId: string, _type: string, entity: EntityResult, _fingerprint: string, document: GitPmDocument) { const next = this.result(document); this.entities = this.entities.map((item) => item === entity ? next : item); return next; }
  async archiveEntity(_draftId: string, type: string, entity: EntityResult, fingerprint: string) { return await this.updateEntity(_draftId, type, entity, fingerprint, { ...entity.document, lifecycle: "archived" }); }
  async deleteEntity(_draftId: string, _type: string, entity: EntityResult) { this.entities = this.entities.filter((item) => item !== entity); }
  async getConfiguration(_draftId: string, kind: "statuses" | "issue-types"): Promise<EntityResult> { const document = (kind === "statuses" ? { schema: "gitpm/statuses@1", id: "CONFIG-STATUSES", lifecycle: "active", statuses: [{ slug: "backlog", title: "Backlog", active: true }, { slug: "done", title: "Done", active: true }] } : { schema: "gitpm/issue-types@1", id: "CONFIG-TYPES", lifecycle: "active", issue_types: [{ slug: "task", title: "Task", active: true }] }) as GitPmDocument; return { document, path: kind, blob_id: "a".repeat(40), draft_fingerprint: "b".repeat(64) }; }
  async updateConfiguration(): Promise<EntityResult> { throw new Error("not used"); }
}

afterEach(cleanup);

describe("core UI", () => {
  it("creates valid immutable IDs and renders Markdown without creating raw HTML", () => {
    expect(newEntityId("T", () => 0, new Date("2026-01-01T00:00:00Z"))).toBe("T-26-000000");
    const { container } = render(<SafeMarkdown source={'# **Safe**\n<img src=x onerror="alert(1)">'} />);
    expect(container.querySelector("strong")?.textContent).toBe("Safe");
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x");
  });

  it("creates Project, Milestone and Task, inline-edits status and archives the Task", async () => {
    const entityApi = new EntityApi();
    const api = entityApi as unknown as GitPmApi;
    const onChanged = vi.fn(async () => undefined);
    const rendered = render(<CoreWorkspace api={api} draft={draft} locale="en" surface="projects" onChanged={onChanged} />);

    const projectButton = screen.getByRole("button", { name: "Create project" });
    const projectForm = projectButton.closest("form")!;
    fireEvent.change(within(projectForm).getByLabelText("Name"), { target: { value: "Alpha" } });
    fireEvent.change(within(projectForm).getByLabelText("Description (Markdown)"), { target: { value: "# Alpha" } });
    fireEvent.submit(projectForm);
    expect(await screen.findByDisplayValue("Alpha")).toBeTruthy();

    const milestoneButton = screen.getByRole("button", { name: "Create milestone" });
    const milestoneForm = milestoneButton.closest("form")!;
    fireEvent.change(within(milestoneForm).getByLabelText("Name"), { target: { value: "M1" } });
    fireEvent.submit(milestoneForm);
    expect(await screen.findByDisplayValue("M1")).toBeTruthy();

    rendered.rerender(<CoreWorkspace api={api} draft={draft} locale="en" surface="tasks" onChanged={onChanged} />);
    const taskButton = screen.getByRole("button", { name: "Create task" });
    const taskForm = taskButton.closest("form")!;
    fireEvent.change(within(taskForm).getByLabelText("Title"), { target: { value: "First task" } });
    fireEvent.change(within(taskForm).getByLabelText("Description (Markdown)"), { target: { value: "**important**" } });
    fireEvent.submit(taskForm);
    expect(await screen.findByText("First task")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Status First task"), { target: { value: "done" } });
    await waitFor(() => expect(entityApi.entities.find((item) => item.document.schema === "gitpm/task@1")?.document.status).toBe("done"));
    const taskRow = screen.getByText("First task").closest<HTMLElement>(".task-row")!;
    fireEvent.click(within(taskRow).getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(screen.queryByText("First task")).toBeNull());
    expect(entityApi.entities.find((item) => item.document.schema === "gitpm/task@1")?.document.lifecycle).toBe("archived");
  });

  it("reloads external changes, marks only changed fields, and keeps the focused read control", async () => {
    const entityApi = new EntityApi(); const api = entityApi as unknown as GitPmApi;
    const project = await entityApi.createEntity("DRF-CORE", "projects", "", { schema: "gitpm/project@1", id: "P-26-111111", name: "External project", status: "backlog", lifecycle: "active" });
    const task = await entityApi.createEntity("DRF-CORE", "tasks", "", { schema: "gitpm/task@1", id: "T-26-222222", project: project.document.id, title: "Before agent", type: "task", status: "backlog", lifecycle: "active" });
    const external = { ...draft, writer_mode: "external" as const, changed_externally: false, external_fingerprint: "1".repeat(64) };
    const rendered = render(<CoreWorkspace api={api} draft={external} locale="en" surface="tasks" onChanged={vi.fn(async () => undefined)} />);
    const readButton = await screen.findByRole("button", { name: /Before agent/u }); readButton.focus(); expect(document.activeElement).toBe(readButton);
    await entityApi.updateEntity("DRF-CORE", "tasks", task, "", { ...task.document, title: "After agent", status: "done" });
    rendered.rerender(<CoreWorkspace api={api} draft={{ ...external, external_fingerprint: "2".repeat(64), changed_externally: true }} locale="en" surface="tasks" onChanged={vi.fn(async () => undefined)} />);
    const updated = await screen.findByText("After agent"); const row = updated.closest<HTMLElement>(".task-row")!;
    await waitFor(() => expect(row.classList.contains("external-update")).toBe(true));
    expect(row.dataset.externalFields).toBe("status,title");
    expect(document.activeElement).toBe(readButton);
    expect((screen.getByLabelText("Status After agent") as HTMLSelectElement).disabled).toBe(true);
  });
});
