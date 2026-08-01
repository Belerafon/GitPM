import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
const project = "P-26-MGP84K"; const personFile = "people/U-26-5EBAE3.yaml"; const taskFile = `projects/${project}/tasks/T-26-RHBNH8.yaml`; const viewFile = `projects/${project}/views/V-26-AG873M.yaml`;
async function git(cwd: string, ...args: string[]) { return (await execFileAsync("git", args, { cwd, windowsHide: true, encoding: "utf8" })).stdout.trim(); }
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("scripted agent CLI", () => {
  it("runs external edit through format, validate, semantic diff, scope/delete guards, commit-all, push and MR", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gitpm-agent-cli-")); roots.push(root); const source = path.join(root, "source"); const remote = path.join(root, "remote.git"); const data = path.join(root, "data");
    await mkdir(source); await cp(demo, source, { recursive: true }); await git(source, "init", "-b", "main"); await git(source, "add", "."); await git(source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture"); await git(root, "init", "--bare", remote); await git(source, "remote", "add", "origin", remote); await git(source, "push", "origin", "main");
    const client = new GitClient({ dataDirectory: data, remoteUrl: remote, defaultBranch: "main", allowLocalTestRemote: true, askPassPath: path.join(process.cwd(), "scripts", "git-askpass.mjs") }); const drafts = new DraftManager(client, data); const gitlab = new GitLabProtocolTestDouble(); const agent = new AgentWorkflow(drafts, client, new ChangesService(drafts, client), { accessToken: "agent-cli-token", authorName: "agent-42", authorEmail: "42@users.noreply.gitlab.example.test", defaultBranch: "main", mergeRequests: gitlab });
    const invoke = async (args: string[]) => JSON.parse((await run([...args, "--json"], root, { agent })).output) as Record<string, unknown>;
    const created = await invoke(["draft", "create", "--draft", "DRF-CLI", "--owner", "42"]); expect(created).toMatchObject({ ok: true, draft: { writer_mode: "external" } }); const draft = await agent.status("DRF-CLI");
    await writeFile(path.join(draft.worktree_path, "uploads", "source.yaml"), "customer: Acme\n", "utf8");
    const entityFile = path.join(root, "new-task.yaml");
    await writeFile(entityFile, (await readFile(path.join(draft.worktree_path, ...taskFile.split("/")), "utf8"))
      .replace("id: T-26-RHBNH8", "id: T-26-VP4MHE")
      .replace("title: Implement parser", "title: Проверить создание задачи через CLI"), "utf8");
    const createdEntity = await invoke(["entity", "create", "--draft", "DRF-CLI", "--file", entityFile, "--project", project]);
    if (createdEntity.ok !== true) throw new Error(`entity create failed: ${JSON.stringify(createdEntity)}`);
    expect(createdEntity).toMatchObject({
      ok: true,
      path: `projects/${project}/tasks/T-26-VP4MHE.yaml`,
      document: { schema: "gitpm/task@2", title: "Проверить создание задачи через CLI" },
    });
    expect(await invoke(["entity", "update", "--draft", "DRF-CLI", "--type", "project", "--id", project, "--set", "name=Agent CLI delivery", "--project", project])).toMatchObject({ ok: true, document: { id: project, name: "Agent CLI delivery" } });
    expect(await invoke(["format", "--draft", "DRF-CLI", "--project", project])).toMatchObject({ ok: true }); expect(await invoke(["validate", "--changed", "--draft", "DRF-CLI", "--project", project])).toMatchObject({ ok: true }); expect(await invoke(["diff", "--semantic", "--draft", "DRF-CLI", "--project", project])).toMatchObject({ ok: true, counts: { created: 1, updated: 6 } });
    const personOriginal = await readFile(path.join(draft.worktree_path, ...personFile.split("/")), "utf8"); await atomicWriteDomainFile(draft.worktree_path, personFile, personOriginal.replace("name: Anna Petrova", "name: Scope violation")); expect(await invoke(["validate", "--changed", "--draft", "DRF-CLI", "--project", project])).toMatchObject({ ok: false, code: "AGENT_SCOPE_VIOLATION" }); await atomicWriteDomainFile(draft.worktree_path, personFile, personOriginal);
    const viewOriginal = await readFile(path.join(draft.worktree_path, ...viewFile.split("/")), "utf8"); await rm(path.join(draft.worktree_path, ...viewFile.split("/"))); expect(await invoke(["validate", "--changed", "--draft", "DRF-CLI", "--project", project])).toMatchObject({ ok: false, code: "AGENT_DELETE_CONFIRMATION_REQUIRED" }); expect(await invoke(["validate", "--changed", "--draft", "DRF-CLI", "--project", project, "--allow-delete"])).toMatchObject({ ok: true }); await atomicWriteDomainFile(draft.worktree_path, viewFile, viewOriginal);
    const committed = await invoke(["commit", "--all", "-m", "Agent CLI delivery", "--draft", "DRF-CLI", "--project", project]); expect(committed.commit).toMatch(/^[0-9a-f]{40}$/u); const pushed = await invoke(["push", "--draft", "DRF-CLI"]); expect(await git(root, "--git-dir", remote, "rev-parse", "refs/heads/gitpm/42/DRF-CLI")).toBe(pushed.commit); const mr = await invoke(["mr", "create", "--draft", "DRF-CLI", "--owner", "42", "--title", "Agent CLI delivery"]); expect(mr).toMatchObject({ merge_request: { iid: 1, state: "opened" } }); expect(await invoke(["mr", "status", "--draft", "DRF-CLI", "--owner", "42"])).toMatchObject({ merge_request: { iid: 1, state: "opened" } }); expect(JSON.stringify(gitlab.captures)).not.toContain("agent-cli-token");
  }, 60_000);

  it("exposes GUI domain, changes and draft lifecycle operations in worktree mode", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gitpm-agent-parity-")); roots.push(root);
    const source = path.join(root, "source"); const remote = path.join(root, "remote.git"); const data = path.join(root, "data");
    await mkdir(source); await cp(demo, source, { recursive: true }); await git(source, "init", "-b", "main"); await git(source, "add", ".");
    await git(source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture");
    await git(root, "init", "--bare", remote); await git(source, "remote", "add", "origin", remote); await git(source, "push", "origin", "main");
    const client = new GitClient({ dataDirectory: data, remoteUrl: remote, defaultBranch: "main", allowLocalTestRemote: true, askPassPath: path.join(process.cwd(), "scripts", "git-askpass.mjs") });
    const drafts = new DraftManager(client, data);
    const agent = new AgentWorkflow(drafts, client, new ChangesService(drafts, client), { authorName: "Agent CLI", authorEmail: "anna.petrova@example.test", defaultBranch: "main" });
    const invoke = async (args: string[]) => JSON.parse((await run([...args, "--json"], root, { agent })).output) as Record<string, unknown>;
    expect(await invoke(["draft", "create", "--draft", "DRF-PARITY", "--owner", "42"])).toMatchObject({ ok: true });
    expect(await invoke(["draft", "list", "--owner", "42"])).toMatchObject({ items: [expect.objectContaining({ draft_id: "DRF-PARITY" })] });

    expect(await invoke(["config", "show", "--draft", "DRF-PARITY", "--kind", "schedule-tracks"])).toMatchObject({ ok: true, document: { schema: "gitpm/schedule-tracks@1" } });
    expect(await invoke(["config", "update", "--draft", "DRF-PARITY", "--kind", "schedule-tracks", "--set", "schema=gitpm/schedule-tracks@1"])).toMatchObject({ ok: true });

    const updatedProject = await invoke(["entity", "update", "--draft", "DRF-PARITY", "--type", "project", "--id", project, "--set", "name=Temporary parity name", "--project", project]);
    expect(updatedProject).toMatchObject({ ok: true, document: { name: "Temporary parity name" } });
    const changes = await invoke(["changes", "list", "--draft", "DRF-PARITY", "--project", project]) as unknown as { files: Array<{ path: string; kind: string; diff_token: string; hunks: readonly unknown[] }> };
    const projectChange = changes.files.find((file) => file.path === `projects/${project}/project.yaml`)!;
    expect(projectChange).toMatchObject({ kind: "Modified", hunks: [expect.any(Object)] });
    expect(await invoke(["changes", "restore-hunk", "--draft", "DRF-PARITY", "--path", projectChange.path, "--diff-token", projectChange.diff_token, "--hunk", "0", "--project", project])).toMatchObject({ ok: true, path: projectChange.path });
    expect(await invoke(["entity", "show", "--draft", "DRF-PARITY", "--type", "project", "--id", project])).toMatchObject({ document: { name: "GitPM launch" } });

    const comment = await invoke(["comment", "create", "--draft", "DRF-PARITY", "--project", project, "--task", "T-26-P9G3P8", "--body", "CLI parity comment"]);
    expect(comment).toMatchObject({ ok: true, document: { state: "active", body_markdown: "CLI parity comment" } });
    expect(await invoke(["comment", "list", "--draft", "DRF-PARITY", "--project", project, "--task", "T-26-P9G3P8"])).toMatchObject({ items: [expect.objectContaining({ state: "active" })] });
    expect(await invoke(["notification", "list", "--draft", "DRF-PARITY", "--person", "U-26-5EBAE3"])).toMatchObject({ ok: true, recipient_person_id: "U-26-5EBAE3" });

    const entry = await invoke(["time-entry", "create", "--draft", "DRF-PARITY", "--project", project, "--task", "T-26-P9G3P8", "--person", "U-26-5EBAE3", "--date", "2026-09-01", "--hours", "2", "--category", "regular"]) as unknown as { document: { id: string; state: string } };
    expect(entry).toMatchObject({ ok: true, document: { state: "active" } });
    expect(await invoke(["time-entry", "void", "--draft", "DRF-PARITY", "--project", project, "--task", "T-26-P9G3P8", "--id", entry.document.id])).toMatchObject({ document: { state: "voided" } });
    expect(await invoke(["schedule", "set", "--draft", "DRF-PARITY", "--type", "task", "--id", "T-26-P9G3P8", "--track", "plan", "--finish", "2026-07-04", "--project", project])).toMatchObject({ ok: true, document: { schedules: { plan: { finish: "2026-07-04" } } } });
    expect(await invoke(["planning", "set", "--draft", "DRF-PARITY", "--project", project, "--workload-track", "plan"])).toMatchObject({ ok: true, document: { planning: { workload_track: "plan" } } });
    expect(await invoke(["history", "list", "--draft", "DRF-PARITY", "--limit", "5"])).toMatchObject({ ok: true, items: [expect.objectContaining({ subject: "fixture" })] });

    expect(await invoke(["changes", "discard-all", "--draft", "DRF-PARITY", "--confirm", "discard-all"])).toMatchObject({ ok: true, discarded: expect.any(Number) });
    expect(await invoke(["draft", "close", "--draft", "DRF-PARITY", "--owner", "42"])).toMatchObject({ draft: { state: "closed" } });
    expect(await invoke(["draft", "reopen", "--draft", "DRF-PARITY", "--owner", "42"])).toMatchObject({ draft: { state: "open" } });
  }, 60_000);
});
