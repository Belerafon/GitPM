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

    const projectButton = await screen.findByRole("button", { name: "Create project" });
    expect((screen.getByText("New project").closest("details") as HTMLDetailsElement).open).toBe(false);
    const projectForm = projectButton.closest("form")!;
    fireEvent.change(within(projectForm).getByLabelText("Name"), { target: { value: "Alpha" } });
    fireEvent.change(within(projectForm).getByLabelText("Description (Markdown)"), { target: { value: "# Alpha" } });
    fireEvent.submit(projectForm);
    const projectName = await screen.findByDisplayValue("Alpha");
    expect((projectName.closest("details") as HTMLDetailsElement).open).toBe(false);

    const milestoneButton = screen.getByRole("button", { name: "Create milestone" });
    const milestoneForm = milestoneButton.closest("form")!;
    fireEvent.change(within(milestoneForm).getByLabelText("Name"), { target: { value: "M1" } });
    fireEvent.submit(milestoneForm);
    expect(await screen.findByDisplayValue("M1")).toBeTruthy();

    rendered.rerender(<CoreWorkspace api={api} draft={draft} initialProjectId={entityApi.entities.find((item) => item.document.schema === "gitpm/project@1")?.document.id} locale="en" surface="tasks" onChanged={onChanged} />);
    const taskButton = await screen.findByRole("button", { name: "Create task" });
    const taskForm = taskButton.closest("form")!;
    fireEvent.change(within(taskForm).getByLabelText("Title"), { target: { value: "First task" } });
    fireEvent.change(within(taskForm).getByLabelText("Milestone"), { target: { value: entityApi.entities.find((item) => item.document.schema === "gitpm/milestone@1")?.document.id } });
    fireEvent.change(within(taskForm).getByLabelText("Description (Markdown)"), { target: { value: "**important**" } });
    fireEvent.submit(taskForm);
    expect(await screen.findByText("First task")).toBeTruthy();
    await waitFor(() => expect(rendered.container.querySelector(".task-milestone")?.textContent).toBe("M1"));
    expect(entityApi.entities.find((item) => item.document.schema === "gitpm/task@1")?.document.milestone).toBe(entityApi.entities.find((item) => item.document.schema === "gitpm/milestone@1")?.document.id);

    fireEvent.change(screen.getByLabelText("Status First task"), { target: { value: "done" } });
    await waitFor(() => expect(entityApi.entities.find((item) => item.document.schema === "gitpm/task@1")?.document.status).toBe("done"));
    const taskRow = screen.getByText("First task").closest<HTMLElement>(".task-row")!;
    fireEvent.click(within(taskRow).getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(screen.queryByText("First task")).toBeNull());
    expect(entityApi.entities.find((item) => item.document.schema === "gitpm/task@1")?.document.lifecycle).toBe("archived");
  });

  it("uses configured status titles and requires confirmation before permanent deletion", async () => {
    const entityApi = new EntityApi(); const api = entityApi as unknown as GitPmApi;
    const project = await entityApi.createEntity("DRF-CORE", "projects", "", { schema: "gitpm/project@1", id: "P-26-111111", name: "Alpha", status: "backlog", lifecycle: "active" });
    await entityApi.createEntity("DRF-CORE", "tasks", "", { schema: "gitpm/task@1", id: "T-26-222222", project: project.document.id, title: "Localized task", type: "task", status: "backlog", lifecycle: "active" });
    const confirmAction = vi.fn(() => false);
    const rendered = render(<CoreWorkspace api={api} confirmAction={confirmAction} draft={draft} locale="en" surface="portfolio" onChanged={vi.fn(async () => undefined)} />);

    expect(await screen.findByText("Backlog")).toBeTruthy();
    rendered.rerender(<CoreWorkspace api={api} confirmAction={confirmAction} draft={draft} initialProjectId={project.document.id} locale="en" surface="projects" onChanged={vi.fn(async () => undefined)} />);
    await screen.findByDisplayValue("Alpha");
    fireEvent.click(screen.getByText("Edit"));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(confirmAction).toHaveBeenCalledWith("Delete Alpha permanently? This action cannot be undone.");
    expect(entityApi.entities).toContain(project);

    confirmAction.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByDisplayValue("Alpha")).toBeNull());
  });

  it("shows resolved project and archived milestone names in task details", async () => {
    const entityApi = new EntityApi(); const api = entityApi as unknown as GitPmApi;
    const project = await entityApi.createEntity("DRF-CORE", "projects", "", { schema: "gitpm/project@1", id: "P-26-111111", name: "Alpha", status: "backlog", lifecycle: "active" });
    const milestone = await entityApi.createEntity("DRF-CORE", "milestones", "", { schema: "gitpm/milestone@1", id: "M-26-222222", project: project.document.id, name: "Archived stage", lifecycle: "archived" });
    const task = await entityApi.createEntity("DRF-CORE", "tasks", "", { schema: "gitpm/task@1", id: "T-26-333333", project: project.document.id, milestone: milestone.document.id, title: "Linked task", type: "task", status: "backlog", lifecycle: "active" });

    const { container } = render(<CoreWorkspace api={api} draft={draft} initialProjectId={project.document.id} initialTaskId={task.document.id} locale="en" surface="tasks" onChanged={vi.fn(async () => undefined)} />);
    await screen.findByRole("heading", { name: "Linked task" });
    const metadata = container.querySelector<HTMLElement>(".task-detail-meta")!;
    expect(within(metadata).getByRole("button", { name: "Alpha" })).toBeTruthy();
    expect(within(metadata).getByText(/Archived stage/u)).toBeTruthy();
    expect(metadata.querySelector(".archived-reference")?.textContent).toContain("Archived");
    expect(within(metadata).queryByText("P-26-111111")).toBeNull();
  });

  it("filters tasks by milestone and links project milestone progress to that filter", async () => {
    const entityApi = new EntityApi(); const api = entityApi as unknown as GitPmApi;
    const project = await entityApi.createEntity("DRF-CORE", "projects", "", { schema: "gitpm/project@1", id: "P-26-111111", name: "Alpha", status: "backlog", lifecycle: "active" });
    const milestone = await entityApi.createEntity("DRF-CORE", "milestones", "", { schema: "gitpm/milestone@1", id: "M-26-222222", project: project.document.id, name: "Beta", lifecycle: "active" });
    await entityApi.createEntity("DRF-CORE", "tasks", "", { schema: "gitpm/task@1", id: "T-26-333333", project: project.document.id, milestone: milestone.document.id, title: "Linked", type: "task", status: "done", lifecycle: "active" });
    await entityApi.createEntity("DRF-CORE", "tasks", "", { schema: "gitpm/task@1", id: "T-26-444444", project: project.document.id, title: "Unlinked", type: "task", status: "backlog", lifecycle: "active" });
    const onNavigate = vi.fn();

    const rendered = render(<CoreWorkspace api={api} draft={draft} initialProjectId={project.document.id} locale="en" surface="projects" onNavigate={onNavigate} onChanged={vi.fn(async () => undefined)} />);
    const progress = await screen.findByRole("button", { name: "1 of 1 tasks completed" });
    fireEvent.click(progress);
    expect(onNavigate).toHaveBeenCalledWith("tasks", { projectId: project.document.id, query: { milestone: [milestone.document.id] } });

    rendered.unmount();
    const filtered = render(<CoreWorkspace api={api} draft={draft} initialProjectId={project.document.id} initialMilestoneFilter={milestone.document.id} locale="en" surface="tasks" onNavigate={onNavigate} onChanged={vi.fn(async () => undefined)} />);
    expect(await screen.findByText("Linked")).toBeTruthy();
    expect(screen.queryByText("Unlinked")).toBeNull();
    const toolbar = filtered.container.querySelector<HTMLElement>(".task-toolbar-controls")!;
    expect((within(toolbar).getByRole("combobox", { name: "Milestone" }) as HTMLSelectElement).value).toBe(milestone.document.id);
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
