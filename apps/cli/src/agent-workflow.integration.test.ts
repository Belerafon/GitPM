import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { AgentWorkflow } from "@gitpm/agent";
import { ChangesService } from "@gitpm/changes";
import { DraftManager } from "@gitpm/drafts";
import { GitClient } from "@gitpm/git-client";
import { GitLabProtocolTestDouble } from "@gitpm/gitlab";
import { atomicWriteDomainFile } from "@gitpm/security";
import { run } from "./command.js";

const execFileAsync = promisify(execFile); const roots: string[] = []; const demo = path.join(process.cwd(), "fixtures", "schema-v1", "demo");
const project = "PRJ-01J2BZA35YJGY8Z4T1P8JZ2TYP"; const projectFile = `projects/${project}/project.yaml`; const personFile = "people/PER-01J2C01M9QHPMQ2ZK5F7N8S4VA.yaml"; const viewFile = `projects/${project}/views/VIW-01J2C01M9QHPMQ2ZK5F7N8S4VA.yaml`;
async function git(cwd: string, ...args: string[]) { return (await execFileAsync("git", args, { cwd, windowsHide: true, encoding: "utf8" })).stdout.trim(); }
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("scripted agent CLI", () => {
  it("runs external edit through format, validate, semantic diff, scope/delete guards, commit-all, push and MR", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gitpm-agent-cli-")); roots.push(root); const source = path.join(root, "source"); const remote = path.join(root, "remote.git"); const data = path.join(root, "data");
    await mkdir(source); await cp(demo, source, { recursive: true }); await git(source, "init", "-b", "main"); await git(source, "add", "."); await git(source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture"); await git(root, "init", "--bare", remote); await git(source, "remote", "add", "origin", remote); await git(source, "push", "origin", "main");
    const client = new GitClient({ dataDirectory: data, remoteUrl: remote, defaultBranch: "main", allowLocalTestRemote: true, askPassPath: path.join(process.cwd(), "scripts", "git-askpass.mjs") }); const drafts = new DraftManager(client, data); const gitlab = new GitLabProtocolTestDouble(); const agent = new AgentWorkflow(drafts, client, new ChangesService(drafts, client), { accessToken: "agent-cli-token", authorName: "agent-42", authorEmail: "42@users.noreply.gitlab.example.test", defaultBranch: "main", mergeRequests: gitlab });
    const invoke = async (args: string[]) => JSON.parse((await run([...args, "--json"], root, { agent })).output) as Record<string, unknown>;
    const created = await invoke(["draft", "create", "--draft", "DRF-CLI", "--owner", "42"]); expect(created).toMatchObject({ ok: true, draft: { writer_mode: "external" } }); const draft = await agent.status("DRF-CLI");
    await atomicWriteDomainFile(draft.worktree_path, projectFile, (await readFile(path.join(draft.worktree_path, ...projectFile.split("/")), "utf8")).replace("GitPM launch", "Agent CLI delivery"));
    expect(await invoke(["format", "--draft", "DRF-CLI", "--project", project])).toMatchObject({ ok: true }); expect(await invoke(["validate", "--changed", "--draft", "DRF-CLI", "--project", project])).toMatchObject({ ok: true }); expect(await invoke(["diff", "--semantic", "--draft", "DRF-CLI", "--project", project])).toMatchObject({ ok: true, counts: { updated: 1 } });
    const personOriginal = await readFile(path.join(draft.worktree_path, ...personFile.split("/")), "utf8"); await atomicWriteDomainFile(draft.worktree_path, personFile, personOriginal.replace("Anna Petrova", "Scope violation")); expect(await invoke(["validate", "--changed", "--draft", "DRF-CLI", "--project", project])).toMatchObject({ ok: false, code: "AGENT_SCOPE_VIOLATION" }); await atomicWriteDomainFile(draft.worktree_path, personFile, personOriginal);
    const viewOriginal = await readFile(path.join(draft.worktree_path, ...viewFile.split("/")), "utf8"); await rm(path.join(draft.worktree_path, ...viewFile.split("/"))); expect(await invoke(["validate", "--changed", "--draft", "DRF-CLI", "--project", project])).toMatchObject({ ok: false, code: "AGENT_DELETE_CONFIRMATION_REQUIRED" }); expect(await invoke(["validate", "--changed", "--draft", "DRF-CLI", "--project", project, "--allow-delete"])).toMatchObject({ ok: true }); await atomicWriteDomainFile(draft.worktree_path, viewFile, viewOriginal);
    const committed = await invoke(["commit", "--all", "-m", "Agent CLI delivery", "--draft", "DRF-CLI", "--project", project]); expect(committed.commit).toMatch(/^[0-9a-f]{40}$/u); const pushed = await invoke(["push", "--draft", "DRF-CLI"]); expect(await git(root, "--git-dir", remote, "rev-parse", "refs/heads/gitpm/42/DRF-CLI")).toBe(pushed.commit); const mr = await invoke(["mr", "create", "--draft", "DRF-CLI", "--owner", "42", "--title", "Agent CLI delivery"]); expect(mr).toMatchObject({ merge_request: { iid: 1, state: "opened" } }); expect(JSON.stringify(gitlab.captures)).not.toContain("agent-cli-token");
  }, 60_000);
});
