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
    await atomicWriteDomainFile(draft.worktree_path, projectFile, (await readFile(path.join(draft.worktree_path, ...projectFile.split("/")), "utf8")).replace("GitPM launch", "Agent delivery"));
    expect(await workflow.semanticDiff("DRF-AGENT", { allowedProject: projectId })).toMatchObject({ counts: { updated: 1 }, affected_projects: [projectId] });

    const personOriginal = await readFile(path.join(draft.worktree_path, ...personFile.split("/")), "utf8");
    await atomicWriteDomainFile(draft.worktree_path, personFile, personOriginal.replace("Anna Petrova", "Out of scope"));
    await expect(workflow.assertScope("DRF-AGENT", { allowedProject: projectId })).rejects.toMatchObject({ code: "AGENT_SCOPE_VIOLATION" });
    await atomicWriteDomainFile(draft.worktree_path, personFile, personOriginal);

    const taskOriginal = await readFile(path.join(draft.worktree_path, ...taskFile.split("/")), "utf8"); await rm(path.join(draft.worktree_path, ...taskFile.split("/")));
    await expect(workflow.assertScope("DRF-AGENT", { allowedProject: projectId })).rejects.toMatchObject({ code: "AGENT_DELETE_CONFIRMATION_REQUIRED" });
    expect((await workflow.assertScope("DRF-AGENT", { allowedProject: projectId, allowDelete: true })).changed_files).toEqual(expect.arrayContaining([expect.objectContaining({ path: taskFile, kind: "Deleted" })]));
    await atomicWriteDomainFile(draft.worktree_path, taskFile, taskOriginal);

    const committed = await workflow.commitAll("DRF-AGENT", "Agent updates project", { allowedProject: projectId });
    expect(committed.commit).toMatch(/^[0-9a-f]{40}$/u);
    const pushed = await workflow.push("DRF-AGENT"); expect(await git(root, "--git-dir", remote, "rev-parse", "refs/heads/gitpm/42/DRF-AGENT")).toBe(pushed.commit);
    const mr = await workflow.createMergeRequest("DRF-AGENT", "42", "Agent updates project");
    expect(mr).toMatchObject({ source_branch: "gitpm/42/DRF-AGENT", target_branch: "main", state: "opened" });
    expect(JSON.stringify(gitlab.captures)).not.toContain("agent-memory-token");
  }, 60_000);

  it("rejects agent mutations unless the draft is external", async () => {
    const error = new AgentWorkflowError("AGENT_EXTERNAL_MODE_REQUIRED", "required");
    expect(error.code).toBe("AGENT_EXTERNAL_MODE_REQUIRED");
  });
});
