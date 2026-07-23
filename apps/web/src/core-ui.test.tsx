// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitPmApi } from "./api.js";
import { AssigneeChecks, CoreWorkspace, existingProjectGroups, groupProjects, newEntityId, SafeMarkdown } from "./core-ui.js";
import { message } from "./i18n.js";
import type { DraftStatus, EntityResult, GitPmDocument } from "./types.js";

const draft: DraftStatus = { draft_id: "DRF-CORE", owner_gitlab_user_id: "42", branch: "gitpm/42/DRF-CORE", base_commit: "a".repeat(40), writer_mode: "ui", state: "open", fingerprint: "b".repeat(64), created_at: "2026-07-10T00:00:00.000Z", updated_at: "2026-07-10T00:00:00.000Z" };

class EntityApi {
  entities: EntityResult[] = [];
  revision = 0;
  private result(document: GitPmDocument): EntityResult { this.revision += 1; return { document, path: `${document.id}.yaml`, blob_id: String(this.revision).padStart(40, "a"), draft_fingerprint: String(this.revision).padStart(64, "b") }; }
  async listEntities(_draftId: string, type: string, project?: string) { const schemaName = type === "people" ? "person" : type.slice(0, -1); return this.entities.filter((item) => item.document.schema === `gitpm/${schemaName}@1` && (project === undefined || item.document.project === project)); }
  async createEntity(_draftId: string, _type: string, _fingerprint: string, document: GitPmDocument) { const next = this.result(document); this.entities.push(next); return next; }
  async updateEntity(_draftId: string, _type: string, entity: EntityResult, _fingerprint: string, document: GitPmDocument) { const next = this.result(document); this.entities = this.entities.map((item) => item === entity ? next : item); return next; }
  async moveTask(_draftId: string, entity: EntityResult, _fingerprint: string, targetProject: string, targetMilestone?: string) { return await this.updateEntity(_draftId, "tasks", entity, _fingerprint, { ...entity.document, project: targetProject, milestone: targetMilestone }); }
  async archiveEntity(_draftId: string, type: string, entity: EntityResult, fingerprint: string) { return await this.updateEntity(_draftId, type, entity, fingerprint, { ...entity.document, lifecycle: "archived" }); }
  async deleteEntity(_draftId: string, _type: string, entity: EntityResult) { this.entities = this.entities.filter((item) => item !== entity); }
  async getConfiguration(_draftId: string, kind: "statuses" | "issue-types"): Promise<EntityResult> { const document = (kind === "statuses" ? { schema: "gitpm/statuses@1", id: "CONFIG-STATUSES", lifecycle: "active", statuses: [{ slug: "backlog", title: "Backlog", active: true }, { slug: "done", title: "Done", active: true }] } : { schema: "gitpm/issue-types@1", id: "CONFIG-TYPES", lifecycle: "active", issue_types: [{ slug: "task", title: "Task", active: true }] }) as GitPmDocument; return { document, path: kind, blob_id: "a".repeat(40), draft_fingerprint: "b".repeat(64) }; }
  async updateConfiguration(): Promise<EntityResult> { throw new Error("not used"); }
}

afterEach(cleanup);

describe("core UI", () => {
  it("keeps the form compact and opens the full people directory as a filterable list", () => {
    const people = Array.from({ length: 1_000 }, (_, index) => ({ document: { schema: "gitpm/person@1", id: `U-26-${String(index).padStart(6, "0")}`, name: `Person ${index}`, lifecycle: "active" } as GitPmDocument, path: `${index}.yaml`, blob_id: "a".repeat(40), draft_fingerprint: "b".repeat(64) }));
    render(<form><AssigneeChecks disabled={false} people={people} selected={[people[0]!.document.id, people[999]!.document.id]} t={(key) => message("en", key)} /></form>);

    expect(screen.getByText("Person 0")).toBeTruthy();
    expect(screen.getByText("Person 999")).toBeTruthy();
    expect(screen.queryByText("Person 500")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Add assignee/u }));
    expect(screen.getByText("Person 500")).toBeTruthy();
    expect(document.querySelector(".assignee-search-results")?.children).toHaveLength(998);
    fireEvent.change(screen.getByLabelText("Search people"), { target: { value: "Person 500" } });
    expect(document.querySelector(".assignee-search-results")?.children).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Person 500" }));
    expect(screen.getByText("Person 500")).toBeTruthy();
  });

  it("does not turn the global task entry point into an all-project task stream", async () => {
    const entityApi = new EntityApi(); const api = entityApi as unknown as GitPmApi;
    const project = await entityApi.createEntity("DRF-CORE", "projects", "", { schema: "gitpm/project@1", id: "P-26-111111", name: "Alpha", status: "backlog", lifecycle: "active" });
    await entityApi.createEntity("DRF-CORE", "tasks", "", { schema: "gitpm/task@1", id: "T-26-222222", project: project.document.id, title: "Must stay scoped", type: "task", status: "backlog", lifecycle: "active" });

    render(<CoreWorkspace api={api} draft={draft} locale="en" surface="tasks" onChanged={vi.fn(async () => undefined)} />);
    expect(await screen.findByRole("heading", { name: "Choose a project" })).toBeTruthy();
    expect(screen.queryByText("Must stay scoped")).toBeNull();
    expect((screen.getByLabelText("Project") as HTMLSelectElement).value).toBe("");
  });

  it("animates the task row while an inline status change is being saved", async () => {
    const entityApi = new EntityApi(); const api = entityApi as unknown as GitPmApi;
    const project = await entityApi.createEntity("DRF-CORE", "projects", "", { schema: "gitpm/project@1", id: "P-26-111111", name: "Alpha", status: "backlog", lifecycle: "active" });
    await entityApi.createEntity("DRF-CORE", "tasks", "", { schema: "gitpm/task@1", id: "T-26-222222", project: project.document.id, title: "Animated task", type: "task", status: "backlog", lifecycle: "active" });
    let finishRefresh: () => void = () => undefined;
    const onChanged = vi.fn(() => new Promise<void>((resolve) => { finishRefresh = resolve; }));

    render(<CoreWorkspace api={api} draft={draft} initialProjectId={project.document.id} locale="en" surface="tasks" onChanged={onChanged} />);
    const status = await screen.findByRole<HTMLSelectElement>("combobox", { name: "Status: Animated task" });
    fireEvent.change(status, { target: { value: "done" } });
    expect(screen.getByText("Animated task").closest(".task-row")?.classList.contains("is-saving")).toBe(true);
    await waitFor(() => expect(entityApi.entities.find((item) => item.document.id === "T-26-222222")?.document.status).toBe("done"));
    await waitFor(() => expect(status.disabled).toBe(false));
    expect(screen.getByText("Animated task").closest(".task-row")?.classList.contains("is-saving")).toBe(false);
    expect(onChanged).toHaveBeenCalled();
    finishRefresh();
  });

  it("creates valid immutable IDs and renders Markdown without creating raw HTML", () => {
    expect(newEntityId("T", () => 0, new Date("2026-01-01T00:00:00Z"))).toBe("T-26-000000");
    const { container } = render(<SafeMarkdown source={'# **Safe**\n<img src=x onerror="alert(1)">'} />);
    expect(container.querySelector("strong")?.textContent).toBe("Safe");
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x");
  });

  it("derives exact group options and sorts named groups, projects, and the ungrouped section", async () => {
    const entityApi = new EntityApi(); const api = entityApi as unknown as GitPmApi;
    const projects = [
      await entityApi.createEntity("DRF-CORE", "projects", "", { schema: "gitpm/project@1", id: "P-26-111111", name: "Zulu project", status: "backlog", lifecycle: "active", group: "Delivery" }),
      await entityApi.createEntity("DRF-CORE", "projects", "", { schema: "gitpm/project@1", id: "P-26-222222", name: "Alpha project", status: "backlog", lifecycle: "active", group: "Delivery" }),
      await entityApi.createEntity("DRF-CORE", "projects", "", { schema: "gitpm/project@1", id: "P-26-333333", name: "Research project", status: "backlog", lifecycle: "active", group: "Research" }),
      await entityApi.createEntity("DRF-CORE", "projects", "", { schema: "gitpm/project@1", id: "P-26-444444", name: "Loose project", status: "backlog", lifecycle: "active" }),
      await entityApi.createEntity("DRF-CORE", "projects", "", { schema: "gitpm/project@1", id: "P-26-555555", name: "Archived project", status: "backlog", lifecycle: "archived", group: "Archive only" }),
    ];
    expect(existingProjectGroups(projects, "en")).toEqual(["Archive only", "Delivery", "Research"]);
    expect(groupProjects(projects.slice(0, 4), "en", "Ungrouped").map((section) => [section.title, section.projects.map((project) => project.document.name)]))
      .toEqual([
        ["Delivery", ["Alpha project", "Zulu project"]],
        ["Research", ["Research project"]],
        ["Ungrouped", ["Loose project"]],
      ]);

    const onNavigate = vi.fn();
    const { container } = render(<CoreWorkspace api={api} draft={draft} locale="en" surface="projects" onNavigate={onNavigate} onChanged={vi.fn(async () => undefined)} />);
    await screen.findByRole("heading", { name: "Delivery" });
    const sections = Array.from(container.querySelectorAll<HTMLElement>(".project-group"));
    expect(sections.map((section) => section.querySelector("h4")?.textContent)).toEqual(["Delivery", "Research", "Ungrouped"]);
    expect(Array.from(sections[0]!.querySelectorAll(".project-register-row strong")).map((item) => item.textContent)).toEqual(["Alpha project", "Zulu project"]);
    expect(within(sections[0]!).getByText("2 projects")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Archive only" })).toBeNull();
    fireEvent.click(within(sections[1]!).getByRole("button", { name: /Research project/u }));
    expect(onNavigate).toHaveBeenCalledWith("projects", { projectId: "P-26-333333" });
  });

  it("creates, changes, and removes a Project group while validating new group names", async () => {
    const entityApi = new EntityApi(); const api = entityApi as unknown as GitPmApi;
    await entityApi.createEntity("DRF-CORE", "projects", "", { schema: "gitpm/project@1", id: "P-26-111111", name: "Existing", status: "backlog", lifecycle: "active", group: "Platform" });
    await entityApi.createEntity("DRF-CORE", "projects", "", { schema: "gitpm/project@1", id: "P-26-222222", name: "Archived", status: "backlog", lifecycle: "archived", group: "Research" });
    const onChanged = vi.fn(async () => undefined);
    const rendered = render(<CoreWorkspace api={api} draft={draft} locale="en" surface="projects" onChanged={onChanged} />);

    fireEvent.click(await screen.findByRole("button", { name: /New project/u }));
    let dialog = screen.getByRole("dialog", { name: "New project" });
    expect((within(dialog).getByLabelText("Group") as HTMLSelectElement).value).toBe("");
    expect(within(dialog).getByRole("option", { name: "Platform" })).toBeTruthy();
    expect(within(dialog).getByRole("option", { name: "Research" })).toBeTruthy();
    const platformOptionValue = (within(dialog).getByRole("option", { name: "Platform" }) as HTMLOptionElement).value;
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Grouped project" } });
    fireEvent.change(within(dialog).getByLabelText("Group"), { target: { value: platformOptionValue } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(entityApi.entities.find((item) => item.document.name === "Grouped project")?.document.group).toBe("Platform"));

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    dialog = screen.getByRole("dialog", { name: "Edit: Grouped project" });
    expect((within(dialog).getByLabelText("Group") as HTMLSelectElement).value).toBe(platformOptionValue);
    fireEvent.change(within(dialog).getByLabelText("Group"), { target: { value: "__new__" } });
    fireEvent.change(within(dialog).getByLabelText("New group name"), { target: { value: "  Operations  " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(entityApi.entities.find((item) => item.document.name === "Grouped project")?.document.group).toBe("Operations"));
    expect(await screen.findByText("Group: Operations")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    dialog = screen.getByRole("dialog", { name: "Edit: Grouped project" });
    fireEvent.change(within(dialog).getByLabelText("Group"), { target: { value: "" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(entityApi.entities.find((item) => item.document.name === "Grouped project")?.document).not.toHaveProperty("group"));

    rendered.unmount();
    render(<CoreWorkspace api={api} draft={draft} locale="en" surface="projects" onChanged={onChanged} />);
    fireEvent.click(await screen.findByRole("button", { name: /New project/u }));
    dialog = screen.getByRole("dialog", { name: "New project" });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Invalid group project" } });
    fireEvent.change(within(dialog).getByLabelText("Group"), { target: { value: "__new__" } });
    fireEvent.submit(within(dialog).getByRole("button", { name: "Create project" }).closest("form")!);
    expect(entityApi.entities.some((item) => item.document.name === "Invalid group project")).toBe(false);
    fireEvent.change(within(dialog).getByLabelText("New group name"), { target: { value: "Platform" } });
    expect(within(dialog).getByRole("alert").textContent).toContain("already exists");
    fireEvent.submit(within(dialog).getByRole("button", { name: "Create project" }).closest("form")!);
    expect(entityApi.entities.some((item) => item.document.name === "Invalid group project")).toBe(false);
  });

  it("creates Project, Milestone and Task, then edits and archives the Task in the drawer", async () => {
    const entityApi = new EntityApi();
    const api = entityApi as unknown as GitPmApi;
    const onChanged = vi.fn(async () => undefined);
    const person = await entityApi.createEntity("DRF-CORE", "people", "", { schema: "gitpm/person@1", id: "U-26-555555", name: "Ada", weekly_capacity_hours: 40, calendar: "C-26-111111", lifecycle: "active" });
    const rendered = render(<CoreWorkspace api={api} draft={draft} locale="en" surface="projects" onChanged={onChanged} />);

    fireEvent.click(await screen.findByRole("button", { name: /New project/u }));
    const projectDialog = screen.getByRole("dialog", { name: "New project" });
    const projectForm = within(projectDialog).getByRole("button", { name: "Create project" }).closest("form")!;
    fireEvent.change(within(projectForm).getByLabelText("Name"), { target: { value: "Alpha" } });
    fireEvent.change(within(projectForm).getByLabelText("Description (Markdown)"), { target: { value: "# Alpha" } });
    fireEvent.submit(projectForm);
    expect(await screen.findAllByText("Alpha")).not.toHaveLength(0);
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /New milestone/u }));
    const milestoneForm = within(screen.getByRole("dialog", { name: "New milestone" })).getByRole("button", { name: "Create milestone" }).closest("form")!;
    fireEvent.change(within(milestoneForm).getByLabelText("Name"), { target: { value: "M1" } });
    fireEvent.submit(milestoneForm);
    expect(await screen.findByText("M1")).toBeTruthy();

    rendered.rerender(<CoreWorkspace api={api} draft={draft} initialProjectId={entityApi.entities.find((item) => item.document.schema === "gitpm/project@1")?.document.id} locale="en" surface="tasks" onChanged={onChanged} />);
    fireEvent.click(await screen.findByRole("button", { name: /New task/u }));
    const taskForm = within(screen.getByRole("dialog", { name: "New task" })).getByRole("button", { name: "Create task" }).closest("form")!;
    fireEvent.change(within(taskForm).getByLabelText("Title"), { target: { value: "First task" } });
    fireEvent.change(within(taskForm).getByLabelText("Milestone"), { target: { value: entityApi.entities.find((item) => item.document.schema === "gitpm/milestone@1")?.document.id } });
    fireEvent.click(within(taskForm).getByRole("button", { name: /Add assignee/u }));
    fireEvent.change(within(taskForm).getByLabelText("Search people"), { target: { value: "Ada" } });
    fireEvent.click(within(taskForm).getByRole("button", { name: "Ada" }));
    fireEvent.change(within(taskForm).getByLabelText("Start date"), { target: { value: "2026-07-20" } });
    fireEvent.change(within(taskForm).getByLabelText("Due date"), { target: { value: "2026-07-24" } });
    fireEvent.change(within(taskForm).getByLabelText("Estimate (hours)"), { target: { value: "20" } });
    fireEvent.change(within(taskForm).getByLabelText("Description (Markdown)"), { target: { value: "**important**" } });
    fireEvent.submit(taskForm);
    expect(await screen.findByText("First task")).toBeTruthy();
    await waitFor(() => expect(rendered.container.querySelector(".task-milestone")?.textContent).toBe("M1"));
    expect(entityApi.entities.find((item) => item.document.schema === "gitpm/task@1")?.document.milestone).toBe(entityApi.entities.find((item) => item.document.schema === "gitpm/milestone@1")?.document.id);
    expect(entityApi.entities.find((item) => item.document.schema === "gitpm/task@1")?.document.assignees).toEqual([person.document.id]);
    expect(entityApi.entities.find((item) => item.document.schema === "gitpm/task@1")?.document).toMatchObject({ start: "2026-07-20", due: "2026-07-24", estimate_hours: 20 });

    const createdTask = entityApi.entities.find((item) => item.document.schema === "gitpm/task@1")!;
    const createdProject = entityApi.entities.find((item) => item.document.schema === "gitpm/project@1")!;
    rendered.unmount();
    render(<CoreWorkspace api={api} draft={draft} initialProjectId={createdProject.document.id} initialTaskId={createdTask.document.id} locale="en" surface="tasks" onChanged={onChanged} />);
    await screen.findByRole("heading", { name: "First task" });
    expect(within(document.querySelector<HTMLElement>(".task-detail-meta")!).getByText("Ada")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const editDialog = screen.getByRole("dialog", { name: "Edit: First task" });
    fireEvent.change(within(editDialog).getByLabelText("Status"), { target: { value: "done" } });
    fireEvent.click(within(editDialog).getByRole("button", { name: "Remove Ada" }));
    fireEvent.change(within(editDialog).getByLabelText("Estimate (hours)"), { target: { value: "24" } });
    fireEvent.click(within(editDialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(entityApi.entities.find((item) => item.document.schema === "gitpm/task@1")?.document.status).toBe("done"));
    expect(entityApi.entities.find((item) => item.document.schema === "gitpm/task@1")?.document.assignees).toEqual([]);
    expect(entityApi.entities.find((item) => item.document.schema === "gitpm/task@1")?.document.estimate_hours).toBe(24);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const archiveDialog = screen.getByRole("dialog", { name: "Edit: First task" });
    fireEvent.click(within(archiveDialog).getByText("More actions"));
    fireEvent.click(within(archiveDialog).getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(entityApi.entities.find((item) => item.document.schema === "gitpm/task@1")?.document.lifecycle).toBe("archived"));
  });

  it("uses configured status titles and requires confirmation before permanent deletion", async () => {
    const entityApi = new EntityApi(); const api = entityApi as unknown as GitPmApi;
    const project = await entityApi.createEntity("DRF-CORE", "projects", "", { schema: "gitpm/project@1", id: "P-26-111111", name: "Alpha", status: "backlog", lifecycle: "active" });
    await entityApi.createEntity("DRF-CORE", "tasks", "", { schema: "gitpm/task@1", id: "T-26-222222", project: project.document.id, title: "Localized task", type: "task", status: "backlog", lifecycle: "active" });
    const confirmAction = vi.fn(() => false);
    const rendered = render(<CoreWorkspace api={api} confirmAction={confirmAction} draft={draft} locale="en" surface="portfolio" onChanged={vi.fn(async () => undefined)} />);

    expect(await screen.findByText("Backlog")).toBeTruthy();
    rendered.rerender(<CoreWorkspace api={api} confirmAction={confirmAction} draft={draft} initialProjectId={project.document.id} locale="en" surface="projects" onChanged={vi.fn(async () => undefined)} />);
    await screen.findAllByText("Alpha");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("dialog", { name: "Edit: Alpha" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(confirmAction).toHaveBeenCalledWith("Delete Alpha permanently? This action cannot be undone.");
    expect(entityApi.entities).toContain(project);

    confirmAction.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit: Alpha" })).toBeNull());
  });

  it("shows resolved project and archived milestone names in task details", async () => {
    const entityApi = new EntityApi(); const api = entityApi as unknown as GitPmApi;
    const project = await entityApi.createEntity("DRF-CORE", "projects", "", { schema: "gitpm/project@1", id: "P-26-111111", name: "Alpha", status: "backlog", lifecycle: "active" });
    const milestone = await entityApi.createEntity("DRF-CORE", "milestones", "", { schema: "gitpm/milestone@1", id: "M-26-222222", project: project.document.id, name: "Archived stage", lifecycle: "archived" });
    const task = await entityApi.createEntity("DRF-CORE", "tasks", "", { schema: "gitpm/task@1", id: "T-26-333333", project: project.document.id, milestone: milestone.document.id, title: "Linked task", type: "task", status: "backlog", lifecycle: "active" });

    const onNavigate = vi.fn();
    const { container } = render(<CoreWorkspace api={api} draft={draft} initialProjectId={project.document.id} initialTaskId={task.document.id} locale="en" surface="tasks" onNavigate={onNavigate} onChanged={vi.fn(async () => undefined)} />);
    await screen.findByRole("heading", { name: "Linked task" });
    const metadata = container.querySelector<HTMLElement>(".task-detail-meta")!;
    expect(within(metadata).getByRole("button", { name: "Alpha" })).toBeTruthy();
    expect(within(metadata).getByText(/Archived stage/u)).toBeTruthy();
    expect(metadata.querySelector(".archived-reference")?.textContent).toContain("Archived");
    expect(within(metadata).queryByText("P-26-111111")).toBeNull();
    fireEvent.click(within(metadata).getByRole("button", { name: /Archived stage/u }));
    expect(onNavigate).toHaveBeenCalledWith("stages", { projectId: project.document.id, stageId: milestone.document.id });
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
    expect(onNavigate).toHaveBeenCalledWith("stages", { projectId: project.document.id, stageId: milestone.document.id });

    rendered.unmount();
    const filtered = render(<CoreWorkspace api={api} draft={draft} initialProjectId={project.document.id} initialMilestoneFilter={milestone.document.id} locale="en" surface="tasks" onNavigate={onNavigate} onChanged={vi.fn(async () => undefined)} />);
    expect(await screen.findByText("Linked")).toBeTruthy();
    expect(screen.queryByText("Unlinked")).toBeNull();
    const toolbar = filtered.container.querySelector<HTMLElement>(".task-toolbar-controls")!;
    expect((within(toolbar).getByRole("combobox", { name: "Milestone" }) as HTMLSelectElement).value).toBe(milestone.document.id);
  });

  it("moves a task through the explicit project transfer workflow", async () => {
    const entityApi = new EntityApi(); const api = entityApi as unknown as GitPmApi;
    const source = await entityApi.createEntity("DRF-CORE", "projects", "", { schema: "gitpm/project@1", id: "P-26-111111", name: "Source", status: "backlog", lifecycle: "active" });
    const target = await entityApi.createEntity("DRF-CORE", "projects", "", { schema: "gitpm/project@1", id: "P-26-222222", name: "Target", status: "backlog", lifecycle: "active" });
    const milestone = await entityApi.createEntity("DRF-CORE", "milestones", "", { schema: "gitpm/milestone@1", id: "M-26-333333", project: target.document.id, name: "Target stage", lifecycle: "active" });
    const task = await entityApi.createEntity("DRF-CORE", "tasks", "", { schema: "gitpm/task@1", id: "T-26-444444", project: source.document.id, title: "Move me", type: "task", status: "backlog", lifecycle: "active" });
    const onNavigate = vi.fn();
    render(<CoreWorkspace api={api} draft={draft} initialProjectId={source.document.id} initialTaskId={task.document.id} locale="en" surface="tasks" onNavigate={onNavigate} onChanged={vi.fn(async () => undefined)} />);
    await screen.findByRole("heading", { name: "Move me" });
    fireEvent.click(screen.getByText("Move to another project"));
    const moveForm = screen.getByRole("dialog", { name: "Move to another project" });
    fireEvent.change(within(moveForm).getByLabelText("Target project"), { target: { value: target.document.id } });
    fireEvent.change(within(moveForm).getByLabelText("Milestone"), { target: { value: milestone.document.id } });
    fireEvent.click(within(moveForm).getByRole("button", { name: "Move task" }));

    await waitFor(() => expect(entityApi.entities.find((item) => item.document.id === task.document.id)?.document).toMatchObject({ project: target.document.id, milestone: milestone.document.id }));
    expect(onNavigate).toHaveBeenCalledWith("tasks", { projectId: target.document.id, taskId: task.document.id });
  });

  it("reloads external changes, marks only changed fields, and keeps the focused read control", async () => {
    const entityApi = new EntityApi(); const api = entityApi as unknown as GitPmApi;
    const project = await entityApi.createEntity("DRF-CORE", "projects", "", { schema: "gitpm/project@1", id: "P-26-111111", name: "External project", status: "backlog", lifecycle: "active" });
    const task = await entityApi.createEntity("DRF-CORE", "tasks", "", { schema: "gitpm/task@1", id: "T-26-222222", project: project.document.id, title: "Before agent", type: "task", status: "backlog", lifecycle: "active" });
    const external = { ...draft, writer_mode: "external" as const, changed_externally: false, external_fingerprint: "1".repeat(64) };
    const rendered = render(<CoreWorkspace api={api} draft={external} initialProjectId={project.document.id} locale="en" surface="tasks" onChanged={vi.fn(async () => undefined)} />);
    const readButton = await screen.findByRole("button", { name: /Before agent/u }); readButton.focus(); expect(document.activeElement).toBe(readButton);
    await entityApi.updateEntity("DRF-CORE", "tasks", task, "", { ...task.document, title: "After agent", status: "done" });
    rendered.rerender(<CoreWorkspace api={api} draft={{ ...external, external_fingerprint: "2".repeat(64), changed_externally: true }} initialProjectId={project.document.id} locale="en" surface="tasks" onChanged={vi.fn(async () => undefined)} />);
    const updated = await screen.findByText("After agent"); const row = updated.closest<HTMLElement>(".task-row")!;
    await waitFor(() => expect(row.classList.contains("external-update")).toBe(true));
    expect(row.dataset.externalFields).toBe("status,title");
    expect(document.activeElement).toBe(readButton);
    expect(within(row).queryByRole("combobox")).toBeNull();
    expect(within(row).getByText("Done")).toBeTruthy();
  });
});
