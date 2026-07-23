import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ChangesService } from "@gitpm/changes";
import { DraftManager } from "@gitpm/drafts";
import { GitClient } from "@gitpm/git-client";
import { GitLabProtocolTestDouble } from "@gitpm/gitlab";
import { atomicWriteDomainFile } from "@gitpm/security";
import { validateRepository } from "@gitpm/validation";
import { AgentWorkflow, AgentWorkflowError } from "./index.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const demo = path.join(process.cwd(), "fixtures", "schema-v1", "demo");
const projectId = "P-26-MGP84K";
const projectFile = `projects/${projectId}/project.yaml`;
const personFile = "people/U-26-5EBAE3.yaml";
const taskFile = `projects/${projectId}/tasks/T-26-RHBNH8.yaml`;

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd, windowsHide: true, encoding: "utf8" })).stdout.trim();
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("agent file and CLI workflow core", () => {
  it("enforces external mode, Project scope and explicit delete before commit-all, push and MR", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gitpm-agent-")); roots.push(root);
    const source = path.join(root, "source"); const remote = path.join(root, "remote.git"); const data = path.join(root, "data");
    await mkdir(source); await cp(demo, source, { recursive: true }); await git(source, "init", "-b", "main"); await git(source, "add", ".");
    await git(source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture");
    await git(root, "init", "--bare", remote); await git(source, "remote", "add", "origin", remote); await git(source, "push", "origin", "main");
    const client = new GitClient({ dataDirectory: data, remoteUrl: remote, defaultBranch: "main", allowLocalTestRemote: true, askPassPath: path.join(process.cwd(), "scripts", "git-askpass.mjs") });
    const drafts = new DraftManager(client, data); const changes = new ChangesService(drafts, client); const gitlab = new GitLabProtocolTestDouble();
    const workflow = new AgentWorkflow(drafts, client, changes, { accessToken: "agent-memory-token", authorName: "agent-42", authorEmail: "42@users.noreply.gitlab.example.test", defaultBranch: "main", mergeRequests: gitlab });
    const draft = await workflow.createDraft("DRF-AGENT", "42"); expect(draft.writer_mode).toBe("external");
    const dryImport = await workflow.createEntities("DRF-AGENT", [
      { name: "Dry Ada", weekly_capacity_hours: 40, email: "dry-ada@example.test" },
      { name: "Dry Grace", weekly_capacity_hours: 32, email: "dry-grace@example.test" },
    ], "person", {}, true);
    expect(dryImport).toMatchObject({ dry_run: true, items: [{ source_index: 0 }, { source_index: 1 }] });
    for (const item of dryImport.items) {
      await expect(readFile(path.join(draft.worktree_path, ...item.path.split("/")), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(await readFile(path.join(draft.worktree_path, "AGENTS.md"), "utf8")).toContain("GitPM draft `DRF-AGENT`");
    expect(await readFile(path.join(draft.worktree_path, ".agents", "skills", "gitpm", "SKILL.md"), "utf8")).toContain("name: gitpm");
    await rm(path.join(draft.worktree_path, "AGENTS.md"));
    await workflow.status("DRF-AGENT");
    expect(await readFile(path.join(draft.worktree_path, "AGENTS.md"), "utf8")).toContain("GitPM draft `DRF-AGENT`");
    await atomicWriteDomainFile(draft.worktree_path, projectFile, (await readFile(path.join(draft.worktree_path, ...projectFile.split("/")), "utf8")).replace("name: GitPM launch", "name: Agent delivery"));
    expect(await workflow.semanticDiff("DRF-AGENT", { allowedProject: projectId })).toMatchObject({ counts: { updated: 1 }, affected_projects: [projectId] });

    const personOriginal = await readFile(path.join(draft.worktree_path, ...personFile.split("/")), "utf8");
    await atomicWriteDomainFile(draft.worktree_path, personFile, personOriginal.replace("name: Anna Petrova", "name: Out of scope"));
    await expect(workflow.assertScope("DRF-AGENT", { allowedProject: projectId })).rejects.toMatchObject({ code: "AGENT_SCOPE_VIOLATION" });
    await atomicWriteDomainFile(draft.worktree_path, personFile, personOriginal);

    const taskOriginal = await readFile(path.join(draft.worktree_path, ...taskFile.split("/")), "utf8"); await rm(path.join(draft.worktree_path, ...taskFile.split("/")));
    await expect(workflow.assertScope("DRF-AGENT", { allowedProject: projectId })).rejects.toMatchObject({ code: "AGENT_DELETE_CONFIRMATION_REQUIRED" });
    expect((await workflow.assertScope("DRF-AGENT", { allowedProject: projectId, allowDelete: true })).changed_files).toEqual(expect.arrayContaining([expect.objectContaining({ path: taskFile, kind: "Deleted" })]));
    await atomicWriteDomainFile(draft.worktree_path, taskFile, taskOriginal);

    expect(await validateRepository(draft.worktree_path)).toMatchObject({ valid: true, errors: [] });
    const committed = await workflow.commitAll("DRF-AGENT", "Agent updates project", { allowedProject: projectId });
    expect(committed.commit).toMatch(/^[0-9a-f]{40}$/u);
    const committedPaths = await git(draft.worktree_path, "show", "--pretty=format:", "--name-only", "HEAD");
    expect(committedPaths).not.toContain("AGENTS.md");
    expect(committedPaths).not.toContain(".agents/skills/gitpm/SKILL.md");
    expect(await readFile(path.join(draft.worktree_path, "AGENTS.md"), "utf8")).toContain("GitPM draft `DRF-AGENT`");
    const pushed = await workflow.push("DRF-AGENT"); expect(await git(root, "--git-dir", remote, "rev-parse", "refs/heads/gitpm/42/DRF-AGENT")).toBe(pushed.commit);
    const mr = await workflow.createMergeRequest("DRF-AGENT", "42", "Agent updates project");
    expect(mr).toMatchObject({ source_branch: "gitpm/42/DRF-AGENT", target_branch: "main", state: "opened" });
    expect(JSON.stringify(gitlab.captures)).not.toContain("agent-memory-token");
  }, 60_000);

  it("rejects agent mutations unless the draft is external", async () => {
    const error = new AgentWorkflowError("AGENT_EXTERNAL_MODE_REQUIRED", "required");
    expect(error.code).toBe("AGENT_EXTERNAL_MODE_REQUIRED");
  });

  it("updates existing entities transactionally through the external workflow", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gitpm-agent-update-")); roots.push(root);
    const source = path.join(root, "source"); const remote = path.join(root, "remote.git"); const data = path.join(root, "data");
    await mkdir(source); await cp(demo, source, { recursive: true }); await git(source, "init", "-b", "main"); await git(source, "add", ".");
    await git(source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture");
    await git(root, "init", "--bare", remote); await git(source, "remote", "add", "origin", remote); await git(source, "push", "origin", "main");
    const client = new GitClient({ dataDirectory: data, remoteUrl: remote, defaultBranch: "main", allowLocalTestRemote: true, askPassPath: path.join(process.cwd(), "scripts", "git-askpass.mjs") });
    const drafts = new DraftManager(client, data); const changes = new ChangesService(drafts, client);
    const workflow = new AgentWorkflow(drafts, client, changes, { authorName: "agent-42", authorEmail: "42@example.test", defaultBranch: "main" });
    const draft = await workflow.createDraft("DRF-UPDATE", "42");
    const personPath = path.join(draft.worktree_path, ...personFile.split("/"));

    const updated = await workflow.updateEntity("DRF-UPDATE", { email: "новая-почта@example.test", weekly_capacity_hours: 36 }, "person", "U-26-5EBAE3");
    expect(updated.document).toMatchObject({ name: "Anna Petrova", email: "новая-почта@example.test", weekly_capacity_hours: 36 });
    await expect(readFile(personPath, "utf8")).resolves.toContain("email: новая-почта@example.test");

    const beforeInvalid = await readFile(personPath, "utf8");
    await expect(workflow.updateEntity("DRF-UPDATE", { weekly_capacity_hours: -1 }, "person", "U-26-5EBAE3"))
      .rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(await readFile(personPath, "utf8")).toBe(beforeInvalid);
    await expect(workflow.updateEntity("DRF-UPDATE", { email: "scoped@example.test" }, "person", "U-26-5EBAE3", { allowedProject: projectId }))
      .rejects.toMatchObject({ code: "AGENT_SCOPE_VIOLATION" });
    expect(await readFile(personPath, "utf8")).toBe(beforeInvalid);
  }, 60_000);

  it("lists, shows, plans delete, deletes, archives and moves entities through the external workflow", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gitpm-agent-entity-")); roots.push(root);
    const source = path.join(root, "source"); const remote = path.join(root, "remote.git"); const data = path.join(root, "data");
    await mkdir(source); await cp(demo, source, { recursive: true }); await git(source, "init", "-b", "main"); await git(source, "add", ".");
    await git(source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture");
    await git(root, "init", "--bare", remote); await git(source, "remote", "add", "origin", remote); await git(source, "push", "origin", "main");
    const client = new GitClient({ dataDirectory: data, remoteUrl: remote, defaultBranch: "main", allowLocalTestRemote: true, askPassPath: path.join(process.cwd(), "scripts", "git-askpass.mjs") });
    const drafts = new DraftManager(client, data); const changes = new ChangesService(drafts, client);
    const workflow = new AgentWorkflow(drafts, client, changes, { authorName: "agent-42", authorEmail: "42@example.test", defaultBranch: "main" });
    const draft = await workflow.createDraft("DRF-ENTITY", "42");
    const worktree = draft.worktree_path;

    const people = await workflow.listEntities("DRF-ENTITY", "people");
    expect(people.items.map((item) => item.path)).toEqual(expect.arrayContaining(["people/U-26-15QJP8.yaml", "people/U-26-5EBAE3.yaml"]));
    const projectTasks = await workflow.listEntities("DRF-ENTITY", "tasks", projectId);
    expect(projectTasks.items.every((item) => item.document.project === projectId)).toBe(true);
    expect(projectTasks.items.length).toBeGreaterThan(0);

    const shown = await workflow.getEntity("DRF-ENTITY", "people", "U-26-5EBAE3");
    expect(shown.document).toMatchObject({ name: "Anna Petrova" });
    expect(shown.path).toBe("people/U-26-5EBAE3.yaml");

    const plan = await workflow.planDelete("DRF-ENTITY", "people", "U-26-15QJP8");
    expect(plan).toMatchObject({ supports_unlink: true });
    expect(plan.restrictions.length).toBeGreaterThan(0);
    expect(plan.would_unlink.length).toBeGreaterThan(0);
    await expect(readFile(path.join(worktree, "people", "U-26-15QJP8.yaml"), "utf8")).resolves.toBeDefined();

    await expect(workflow.deleteEntity("DRF-ENTITY", "people", "U-26-15QJP8", false, { allowDelete: true }))
      .rejects.toMatchObject({ code: "DELETE_RESTRICTED" });

    const deleted = await workflow.deleteEntity("DRF-ENTITY", "people", "U-26-15QJP8", true, { allowDelete: true });
    expect(deleted.deleted).toBe(true);
    expect(deleted.unlinked_paths.length).toBeGreaterThan(0);
    await expect(readFile(path.join(worktree, "people", "U-26-15QJP8.yaml"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const teamFile = await readFile(path.join(worktree, "teams", "G-26-XB86WT.yaml"), "utf8");
    expect(teamFile).not.toContain("U-26-15QJP8");

    await expect(workflow.deleteEntity("DRF-ENTITY", "people", "U-26-15QJP8", false, { allowDelete: true }))
      .rejects.toMatchObject({ code: "ENTITY_NOT_FOUND" });

    await workflow.commitAll("DRF-ENTITY", "Delete person with unlink", { allowDelete: true });

    const milestoneBefore = await workflow.getEntity("DRF-ENTITY", "milestones", "M-26-461GDJ");
    const archived = await workflow.archiveEntity("DRF-ENTITY", "milestones", "M-26-461GDJ");
    expect(archived.document.lifecycle).toBe("archived");
    expect(await readFile(path.join(worktree, ...milestoneBefore.path.split("/")), "utf8")).toContain("lifecycle: archived");
    await workflow.commitAll("DRF-ENTITY", "Archive milestone");

    const moved = await workflow.moveTask("DRF-ENTITY", "T-26-G2TG9R", "P-26-MGP84K", undefined, { allowDelete: true });
    expect(moved.document.project).toBe("P-26-MGP84K");
    expect(moved.path).toBe("projects/P-26-MGP84K/tasks/T-26-G2TG9R.yaml");
    await expect(readFile(path.join(worktree, ...moved.path.split("/")), "utf8")).resolves.toContain("Prepare operations");
    await expect(readFile(path.join(worktree, "projects", "P-26-8S9HQQ", "tasks", "T-26-G2TG9R.yaml"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    expect(await validateRepository(worktree)).toMatchObject({ valid: true });
  }, 120_000);
});
