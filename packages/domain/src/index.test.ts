import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DraftManager } from "@gitpm/drafts";
import { GitClient } from "@gitpm/git-client";
import type { GitPmDocument } from "@gitpm/repository-format";
import { CommentStore, DomainOperationError, EntityStore, planEntityCreation, planEntityUpdate, type CommentActor } from "./index.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const demo = path.join(process.cwd(), "fixtures", "schema-v1", "demo");
let templateRoot: string;
let templateRemote: string;

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

beforeAll(async () => {
  templateRoot = await mkdtemp(path.join(os.tmpdir(), "gitpm-domain-template-"));
  const source = path.join(templateRoot, "source");
  templateRemote = path.join(templateRoot, "remote.git");
  await mkdir(source);
  await cp(demo, source, { recursive: true });
  await git(source, "init", "-b", "main");
  await git(source, "add", ".");
  await git(source, "-c", "user.name=GitPM Test", "-c", "user.email=gitpm@example.test", "commit", "-m", "fixture");
  await git(templateRoot, "init", "--bare", templateRemote);
  await git(source, "remote", "add", "origin", templateRemote);
  await git(source, "push", "origin", "main");
});

afterAll(async () => rm(templateRoot, { recursive: true, force: true }));

async function runtime(): Promise<{ manager: DraftManager; store: EntityStore; comments: CommentStore }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gitpm-domain-"));
  roots.push(root);
  const remote = path.join(root, "remote.git");
  const data = path.join(root, "data");
  await cp(templateRemote, remote, { recursive: true });
  const client = new GitClient({ dataDirectory: data, remoteUrl: remote, defaultBranch: "main", allowLocalTestRemote: true });
  const manager = new DraftManager(client, data);
  return { manager, store: new EntityStore(manager), comments: new CommentStore(manager) };
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("entity create planning", () => {
  const calendar = { schema: "gitpm/calendar@1", id: "C-26-QD7FJ4", name: "Default", working_weekdays: [1, 2, 3, 4, 5], holidays: [], lifecycle: "active" };
  const repository = { schema: "gitpm/repository@1", default_calendar: calendar.id };

  it("generates identity and materializes Person defaults while preserving a supplied ID", () => {
    const generated = planEntityCreation([{ name: "Ada", weekly_capacity_hours: 40 }], [repository, calendar], "person")[0]!;
    expect(generated.document).toMatchObject({ schema: "gitpm/person@1", name: "Ada", weekly_capacity_hours: 40, calendar: calendar.id, lifecycle: "active" });
    expect(generated.document.id).toMatch(/^U-\d{2}-[0-9A-HJKMNP-TV-Z]{6}$/u);
    expect(generated.path).toBe(`people/${String(generated.document.id)}.yaml`);

    const supplied = planEntityCreation([{ id: "U-26-KB9RXB", name: "Grace", weekly_capacity_hours: 32 }], [repository, calendar], "people")[0]!;
    expect(supplied.document.id).toBe("U-26-KB9RXB");
  });

  it("rejects invalid, duplicate and inactive-calendar inputs before writing", () => {
    expect(() => planEntityCreation([{ id: "person-1", name: "Bad", weekly_capacity_hours: 40 }], [repository, calendar], "person"))
      .toThrowError(expect.objectContaining({ code: "ENTITY_ID_INVALID" }));
    expect(() => planEntityCreation([
      { id: "U-26-KB9RXB", name: "One", weekly_capacity_hours: 40 },
      { id: "U-26-KB9RXB", name: "Two", weekly_capacity_hours: 40 },
    ], [repository, calendar], "person")).toThrowError(expect.objectContaining({ code: "ENTITY_EXISTS" }));
    expect(() => planEntityCreation([{ name: "Archived calendar", weekly_capacity_hours: 40 }], [repository, { ...calendar, lifecycle: "archived" }], "person"))
      .toThrowError(expect.objectContaining({ code: "ENTITY_CALENDAR_INACTIVE" }));
  });
});

describe("entity update planning", () => {
  const documents: GitPmDocument[] = [
    { schema: "gitpm/project@1", id: "P-26-Y9S1D8", name: "Project", status: "backlog", lifecycle: "active" },
    { schema: "gitpm/task@1", id: "T-26-FM5Q4W", project: "P-26-Y9S1D8", title: "Task", type: "task", status: "backlog", lifecycle: "active" },
    { schema: "gitpm/milestone@1", id: "M-26-KK4VXH", project: "P-26-Y9S1D8", name: "Milestone", lifecycle: "active" },
    { schema: "gitpm/person@1", id: "U-26-KB9RXB", name: "Person", email: "old@example.test", weekly_capacity_hours: 40, calendar: "C-26-7GQW87", lifecycle: "active" },
    { schema: "gitpm/team@1", id: "G-26-22K88P", name: "Team", members: [], lifecycle: "active" },
    { schema: "gitpm/calendar@1", id: "C-26-7GQW87", name: "Calendar", working_weekdays: [1, 2, 3, 4, 5], holidays: [], lifecycle: "active" },
    { schema: "gitpm/saved-view@1", id: "V-26-B0C5A1", project: "P-26-Y9S1D8", name: "View", kind: "list", filters: {}, lifecycle: "active" },
  ];

  it("patches every editable entity type and removes optional fields with null", () => {
    const cases = [
      ["project", "P-26-Y9S1D8", { name: "Проект" }, "name", "Проект"],
      ["task", "T-26-FM5Q4W", { title: "Задача" }, "title", "Задача"],
      ["milestone", "M-26-KK4VXH", { name: "Этап" }, "name", "Этап"],
      ["person", "U-26-KB9RXB", { email: "new@example.test" }, "email", "new@example.test"],
      ["team", "G-26-22K88P", { name: "Команда" }, "name", "Команда"],
      ["calendar", "C-26-7GQW87", { name: "Календарь" }, "name", "Календарь"],
      ["saved-view", "V-26-B0C5A1", { name: "Представление" }, "name", "Представление"],
    ] as const;
    for (const [type, id, patch, field, expected] of cases) {
      const plan = planEntityUpdate(patch, documents, type, id);
      expect(plan.document[field]).toBe(expected);
      expect(plan.document.id).toBe(id);
      expect(plan.path).toContain(id);
    }
    expect(planEntityUpdate({ email: null }, documents, "person", "U-26-KB9RXB").document).not.toHaveProperty("email");
  });

  it("rejects identity, schema and owning-Project changes", () => {
    expect(() => planEntityUpdate({ id: "T-26-RHBNH8" }, documents, "task", "T-26-FM5Q4W"))
      .toThrowError(expect.objectContaining({ code: "ENTITY_IDENTITY_IMMUTABLE" }));
    expect(() => planEntityUpdate({ schema: "gitpm/person@1" }, documents, "task", "T-26-FM5Q4W"))
      .toThrowError(expect.objectContaining({ code: "ENTITY_IDENTITY_IMMUTABLE" }));
    expect(() => planEntityUpdate({ project: "P-26-MGP84K" }, documents, "task", "T-26-FM5Q4W"))
      .toThrowError(expect.objectContaining({ code: "ENTITY_IDENTITY_IMMUTABLE" }));
  });
});

describe("domain entity store", () => {
  it("persists task comments, resolves stable mentions and exposes in-app notifications", async () => {
    const { manager, comments } = await runtime();
    const draft = await manager.createDraft("DRF-COMMENTS", "42");
    const author: CommentActor = { userId: "42", role: "Developer", identity: { provider: "git", subject: "boris@example.test", display_name: "Boris" }, email: "boris@example.test" };
    const anna: CommentActor = { userId: "42", role: "Developer", identity: { provider: "git", subject: "anna@example.test", display_name: "Anna" }, email: "ANNA@example.test" };
    const project = "P-26-MGP84K";
    const task = "T-26-P9G3P8";

    const created = await comments.create("DRF-COMMENTS", project, task, draft.fingerprint, "Please review @[Anna Petrova](person:U-26-5EBAE3)", author);
    expect(created.document).toMatchObject({ schema: "gitpm/comment@1", project, task, state: "active", mentions: [{ person: "U-26-5EBAE3" }] });
    expect(created.path).toMatch(new RegExp(`^projects/${project}/comments/${task}/N-\\d{2}-[0-9A-HJKMNP-TV-Z]{6}\\.yaml$`, "u"));
    expect((await comments.list("DRF-COMMENTS", project, task, author))[0]).toMatchObject({ can_edit: true, can_delete: true });

    const notifications = await comments.notifications("DRF-COMMENTS", anna);
    expect(notifications.recipient_person_id).toBe("U-26-5EBAE3");
    expect(notifications.items).toHaveLength(1);
    expect(notifications.items[0]).toMatchObject({ task_id: task, comment_id: created.document.id, excerpt: "Please review @Anna Petrova" });
    expect((await comments.notifications("DRF-COMMENTS", author)).items).toHaveLength(0);

    await expect(comments.update("DRF-COMMENTS", project, task, created.document.id, created.draft_fingerprint, created.blob_id, "Not allowed", anna))
      .rejects.toMatchObject({ code: "COMMENT_FORBIDDEN" });
    const current = (await comments.list("DRF-COMMENTS", project, task, author))[0]!;
    const deleted = await comments.delete("DRF-COMMENTS", project, task, current.document.id, current.draft_fingerprint, current.blob_id, author);
    expect(deleted.document).toMatchObject({ state: "deleted", mentions: [] });
    expect(deleted.document.body_markdown).toBeUndefined();
    expect((await comments.notifications("DRF-COMMENTS", anna)).items).toHaveLength(0);
  });

  it("keeps comment paths and blob IDs paired when an external YAML has another schema", async () => {
    const { manager, comments } = await runtime();
    const draft = await manager.createDraft("DRF-COMMENT-PATHS", "42");
    const author: CommentActor = { userId: "42", role: "Developer", identity: { provider: "git", subject: "boris@example.test", display_name: "Boris" } };
    const project = "P-26-MGP84K";
    const task = "T-26-P9G3P8";
    const created = await comments.create("DRF-COMMENT-PATHS", project, task, draft.fingerprint, "Path pairing", author);
    const commentAbsolute = path.join(draft.worktree_path, ...created.path.split("/"));
    await writeFile(path.join(path.dirname(commentAbsolute), "A-external.yaml"), "schema: gitpm/person@1\n", "utf8");

    const listed = await comments.list("DRF-COMMENT-PATHS", project, task, author);

    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      document: { id: created.document.id },
      path: created.path,
      blob_id: created.blob_id,
    });
  });

  it("returns a project-scoped workspace snapshot", async () => {
    const { manager, store } = await runtime();
    await manager.createDraft("DRF-WORKSPACE", "42");
    const workspace = await store.projectWorkspace("DRF-WORKSPACE", "P-26-MGP84K");

    expect(workspace.project.document).toMatchObject({ id: "P-26-MGP84K", schema: "gitpm/project@1" });
    expect(workspace.milestones.every((item) => item.document.project === "P-26-MGP84K")).toBe(true);
    expect(workspace.tasks.every((item) => item.document.project === "P-26-MGP84K")).toBe(true);
    expect(workspace.draft_fingerprint).toBe(workspace.project.draft_fingerprint);
  });

  it("invalidates the repository index when an external writer changes content", async () => {
    const { manager, store } = await runtime();
    const draft = await manager.createDraft("DRF-INDEX", "42");
    const before = await store.projectWorkspace("DRF-INDEX", "P-26-MGP84K");
    const task = before.tasks.find((item) => item.document.id === "T-26-P9G3P8")!;
    const absolute = path.join(draft.worktree_path, ...task.path.split("/"));
    await writeFile(absolute, (await readFile(absolute, "utf8")).replace("title: Approve schema v1", "title: Externally changed"), "utf8");

    const after = await store.projectWorkspace("DRF-INDEX", "P-26-MGP84K");
    expect(after.tasks.find((item) => item.document.id === task.document.id)?.document.title).toBe("Externally changed");
  });

  it("moves a task between projects and rejects moves that break project-local references", async () => {
    const { manager, store, comments } = await runtime();
    const draft = await manager.createDraft("DRF-MOVE", "42");
    const task = await store.get("DRF-MOVE", "tasks", "T-26-G2TG9R");
    const comment = await comments.create("DRF-MOVE", String(task.document.project), String(task.document.id), draft.fingerprint, "Moves with its task", { userId: "42", role: "Developer", identity: { provider: "git", subject: "author@example.test", display_name: "Author" } });
    const moved = await store.moveTask("DRF-MOVE", "42", String(task.document.id), comment.draft_fingerprint, task.blob_id, "P-26-MGP84K", "M-26-461GDJ");

    expect(moved.document).toMatchObject({ project: "P-26-MGP84K", milestone: "M-26-461GDJ" });
    expect(moved.path).toBe("projects/P-26-MGP84K/tasks/T-26-G2TG9R.yaml");
    expect(await readFile(path.join(draft.worktree_path, "projects", "P-26-MGP84K", "comments", "T-26-G2TG9R", `${comment.document.id}.yaml`), "utf8")).toContain("project: P-26-MGP84K");
    const dependent = await store.get("DRF-MOVE", "tasks", "T-26-P9G3P8");
    await expect(store.moveTask("DRF-MOVE", "42", String(dependent.document.id), moved.draft_fingerprint, dependent.blob_id, "P-26-8S9HQQ"))
      .rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect((await store.get("DRF-MOVE", "tasks", String(dependent.document.id))).path).toBe(dependent.path);
  });

  it("unlinks a person from every supported reference before confirmed deletion", async () => {
    const { manager, store, comments } = await runtime();
    const draft = await manager.createDraft("DRF-UNLINK-PERSON", "42");
    const personId = "U-26-15QJP8";
    const comment = await comments.create(
      "DRF-UNLINK-PERSON",
      "P-26-MGP84K",
      "T-26-P9G3P8",
      draft.fingerprint,
      "Please ask @[Boris Sokolov](person:U-26-15QJP8)",
      { userId: "42", role: "Developer", identity: { provider: "git", subject: "author@example.test", display_name: "Author" } },
    );
    const person = await store.get("DRF-UNLINK-PERSON", "people", personId);

    await expect(store.delete("DRF-UNLINK-PERSON", "42", "people", personId, comment.draft_fingerprint, person.blob_id))
      .rejects.toMatchObject({
        code: "DELETE_RESTRICTED",
        details: expect.arrayContaining([
          expect.objectContaining({ path: "teams/G-26-XB86WT.yaml", label: "Core team" }),
          expect.objectContaining({ path: "projects/P-26-MGP84K/views/V-26-AG873M.yaml", label: "Active work" }),
          expect.objectContaining({ path: "projects/P-26-MGP84K/tasks/T-26-RHBNH8.yaml", label: "Implement parser" }),
          expect.objectContaining({ path: "projects/P-26-8S9HQQ/project.yaml", label: "Operations" }),
          expect.objectContaining({ path: comment.path }),
        ]),
      });

    const deleted = await store.delete("DRF-UNLINK-PERSON", "42", "people", personId, comment.draft_fingerprint, person.blob_id, true);
    expect(deleted.unlinked_paths).toEqual(expect.arrayContaining([
      "teams/G-26-XB86WT.yaml",
      "projects/P-26-MGP84K/views/V-26-AG873M.yaml",
      "projects/P-26-MGP84K/tasks/T-26-RHBNH8.yaml",
      "projects/P-26-8S9HQQ/project.yaml",
      comment.path,
    ]));
    await expect(store.get("DRF-UNLINK-PERSON", "people", personId)).rejects.toMatchObject({ code: "ENTITY_NOT_FOUND" });
    expect(await readFile(path.join(draft.worktree_path, "teams", "G-26-XB86WT.yaml"), "utf8")).not.toContain(personId);
    expect(await readFile(path.join(draft.worktree_path, "projects", "P-26-MGP84K", "views", "V-26-AG873M.yaml"), "utf8")).not.toContain(personId);
    expect(await readFile(path.join(draft.worktree_path, "projects", "P-26-MGP84K", "tasks", "T-26-RHBNH8.yaml"), "utf8")).not.toContain(personId);
    expect(await readFile(path.join(draft.worktree_path, "projects", "P-26-8S9HQQ", "project.yaml"), "utf8")).not.toContain("owner:");
    const updatedComment = await readFile(path.join(draft.worktree_path, ...comment.path.split("/")), "utf8");
    expect(updatedComment).toContain("Please ask @Boris Sokolov");
    expect(updatedComment).not.toContain(personId);
  }, 60_000);

  it("plans a delete impact preview with restrictions, cascade and unlink without writing", async () => {
    const { manager, store, comments } = await runtime();
    const draft = await manager.createDraft("DRF-PLAN-DELETE", "42");
    let fingerprint = draft.fingerprint;
    const cleanCalendar = await store.create("DRF-PLAN-DELETE", "42", fingerprint, { schema: "gitpm/calendar@1", id: "C-26-ABCDEF", name: "Unreferenced calendar", working_weekdays: [1, 2, 3, 4, 5], holidays: [], lifecycle: "active" });
    fingerprint = cleanCalendar.draft_fingerprint;
    const personId = "U-26-15QJP8";
    const comment = await comments.create(
      "DRF-PLAN-DELETE",
      "P-26-MGP84K",
      "T-26-P9G3P8",
      fingerprint,
      "Heads up @[Boris Sokolov](person:U-26-15QJP8)",
      { userId: "42", role: "Developer", identity: { provider: "git", subject: "author@example.test", display_name: "Author" } },
    );

    const personPlan = await store.planDelete("DRF-PLAN-DELETE", "people", personId);
    expect(personPlan).toMatchObject({ entityType: "people", id: personId, schema: "gitpm/person@1", supports_unlink: true });
    expect(personPlan.path).toBe(`people/${personId}.yaml`);
    expect(personPlan.restrictions).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "teams/G-26-XB86WT.yaml", label: "Core team" }),
      expect.objectContaining({ path: "projects/P-26-8S9HQQ/project.yaml", label: "Operations" }),
      expect.objectContaining({ path: "projects/P-26-MGP84K/tasks/T-26-RHBNH8.yaml", label: "Implement parser" }),
      expect.objectContaining({ path: comment.path }),
    ]));
    expect(personPlan.would_unlink.map((item) => item.path)).toEqual(expect.arrayContaining([
      "teams/G-26-XB86WT.yaml",
      "projects/P-26-8S9HQQ/project.yaml",
      "projects/P-26-MGP84K/tasks/T-26-RHBNH8.yaml",
      comment.path,
    ]));
    expect(personPlan.cascaded_comments).toEqual([]);

    const taskPlan = await store.planDelete("DRF-PLAN-DELETE", "tasks", "T-26-P9G3P8");
    expect(taskPlan.schema).toBe("gitpm/task@1");
    expect(taskPlan.cascaded_comments.map((item) => item.id)).toEqual(expect.arrayContaining([String(comment.document.id)]));
    expect(taskPlan.supports_unlink).toBe(false);
    expect(taskPlan.would_unlink).toEqual([]);

    const cleanPlan = await store.planDelete("DRF-PLAN-DELETE", "calendars", "C-26-ABCDEF");
    expect(cleanPlan.restrictions).toEqual([]);
    expect(cleanPlan.would_unlink).toEqual([]);

    await expect(store.get("DRF-PLAN-DELETE", "people", personId)).resolves.toBeDefined();
    const commentFile = path.join(draft.worktree_path, ...comment.path.split("/"));
    expect(await readFile(commentFile, "utf8")).toContain(personId);
  });

  it("creates all editable entity types, updates, archives and deletes with restrict", async () => {
    const { manager, store } = await runtime();
    const draft = await manager.createDraft("DRF-DOMAIN", "42");
    let fingerprint = draft.fingerprint;
    const documents: GitPmDocument[] = [
      { schema: "gitpm/calendar@1", id: "C-26-7GQW87", name: "Second calendar", working_weekdays: [1, 2, 3, 4, 5], holidays: [], lifecycle: "active" },
      { schema: "gitpm/person@1", id: "U-26-KB9RXB", name: "New person", weekly_capacity_hours: 40, calendar: "C-26-7GQW87", lifecycle: "active" },
      { schema: "gitpm/team@1", id: "G-26-22K88P", name: "New team", members: ["U-26-KB9RXB"], lifecycle: "active" },
      { schema: "gitpm/project@1", id: "P-26-Y9S1D8", name: "New project", status: "backlog", lifecycle: "active" },
      { schema: "gitpm/milestone@1", id: "M-26-KK4VXH", project: "P-26-Y9S1D8", name: "New milestone", lifecycle: "active" },
      { schema: "gitpm/task@1", id: "T-26-FM5Q4W", project: "P-26-Y9S1D8", title: "New task", type: "task", status: "backlog", lifecycle: "active" },
      { schema: "gitpm/saved-view@1", id: "V-26-B0C5A1", project: "P-26-Y9S1D8", name: "New view", kind: "list", filters: {}, lifecycle: "active" },
    ];
    const paths: string[] = [];
    for (const document of documents) {
      const created = await store.create("DRF-DOMAIN", "42", fingerprint, document);
      fingerprint = created.draft_fingerprint;
      paths.push(created.path);
    }
    expect(paths).toHaveLength(7);
    expect(await readFile(path.join(draft.worktree_path, "teams", "G-26-22K88P.yaml"), "utf8"))
      .toContain("U-26-KB9RXB # person: New person");

    const project = await store.get("DRF-DOMAIN", "projects", "P-26-Y9S1D8");
    const updated = await store.update("DRF-DOMAIN", "42", "projects", String(project.document.id), fingerprint, project.blob_id, { ...project.document, name: "Updated project" });
    fingerprint = updated.draft_fingerprint;
    expect(updated.document.name).toBe("Updated project");
    expect(await readFile(path.join(draft.worktree_path, "projects", "P-26-Y9S1D8", "milestones", "M-26-KK4VXH.yaml"), "utf8"))
      .toContain("P-26-Y9S1D8 # project: Updated project");
    await expect(store.update("DRF-DOMAIN", "42", "projects", String(project.document.id), fingerprint, project.blob_id, updated.document))
      .rejects.toMatchObject({ code: "FILE_VERSION_MISMATCH" });
    fingerprint = (await manager.getDraft("DRF-DOMAIN")).fingerprint;

    const task = await store.get("DRF-DOMAIN", "tasks", "T-26-FM5Q4W");
    const archived = await store.archive("DRF-DOMAIN", "42", "tasks", String(task.document.id), fingerprint, task.blob_id);
    fingerprint = archived.draft_fingerprint;
    expect(archived.document.lifecycle).toBe("archived");
    const deleted = await store.delete("DRF-DOMAIN", "42", "tasks", String(task.document.id), fingerprint, archived.blob_id);
    fingerprint = deleted.draft_fingerprint;
    expect(deleted.deleted).toBe(true);

    const person = await store.get("DRF-DOMAIN", "people", "U-26-KB9RXB");
    await expect(store.delete("DRF-DOMAIN", "42", "people", String(person.document.id), fingerprint, person.blob_id))
      .rejects.toBeInstanceOf(DomainOperationError);
    await expect(store.delete("DRF-DOMAIN", "42", "people", String(person.document.id), fingerprint, person.blob_id))
      .rejects.toMatchObject({ code: "DELETE_RESTRICTED" });

    fingerprint = (await manager.getDraft("DRF-DOMAIN")).fingerprint;
    const statuses = await store.getConfiguration("DRF-DOMAIN", "statuses");
    const statusValues = statuses.document.statuses as Array<Record<string, unknown>>;
    const configuration = await store.updateConfiguration(
      "DRF-DOMAIN",
      "42",
      "statuses",
      fingerprint,
      statuses.blob_id,
      { ...statuses.document, statuses: statusValues.map((value) => value.slug === "backlog" ? { ...value, title: "Queue" } : value) },
    );
    expect((configuration.document.statuses as Array<Record<string, unknown>>)[0]?.title).toBe("Queue");
  });
});
