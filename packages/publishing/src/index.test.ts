import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { DraftManager } from "@gitpm/drafts";
import { GitClient } from "@gitpm/git-client";
import { AuthService, GitLabProtocolTestDouble } from "@gitpm/gitlab";
import { atomicWriteDomainFile } from "@gitpm/security";
import { PublishingService } from "./index.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const demo = path.join(process.cwd(), "fixtures", "schema-v1", "demo");
const projectFile = "projects/P-26-MGP84K/project.yaml";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, windowsHide: true, encoding: "utf8" });
  return result.stdout.trim();
}

async function filesContain(directory: string, needle: string): Promise<boolean> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (await filesContain(absolute, needle)) return true;
    } else if ((await readFile(absolute)).includes(Buffer.from(needle))) return true;
  }
  return false;
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("commit, push and Merge Request contract", () => {
  it("commits all, pushes through ASKPASS env, creates and polls MR with refreshed role", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gitpm-publish-"));
    roots.push(root);
    const source = path.join(root, "source");
    const remote = path.join(root, "remote.git");
    const data = path.join(root, "data");
    await mkdir(source);
    await cp(demo, source, { recursive: true });
    await git(source, "init", "-b", "main");
    await git(source, "add", ".");
    await git(source, "-c", "user.name=GitPM Test", "-c", "user.email=gitpm@example.test", "commit", "-m", "fixture");
    await git(root, "init", "--bare", remote);
    await git(source, "remote", "add", "origin", remote);
    await git(source, "push", "origin", "main");

    const commands: string[][] = [];
    const client = new GitClient({
      dataDirectory: data,
      remoteUrl: remote,
      defaultBranch: "main",
      allowLocalTestRemote: true,
      askPassPath: path.join(process.cwd(), "scripts", "git-askpass.mjs"),
      onCommand: (record) => commands.push([...record.args]),
    });
    const drafts = new DraftManager(client, data);
    const draft = await drafts.createDraft("DRF-PUBLISH", "42");
    const absolute = path.join(draft.worktree_path, ...projectFile.split("/"));
    await atomicWriteDomainFile(
      draft.worktree_path,
      projectFile,
      (await readFile(absolute, "utf8")).replace("GitPM launch", "GitPM publish"),
    );
    await drafts.setWriterMode("DRF-PUBLISH", "42", "ui");

    const gitlab = new GitLabProtocolTestDouble();
    const auth = new AuthService({
      authorizeUrl: "https://gitlab.example.test/oauth/authorize",
      clientId: "gitpm",
      redirectUri: "https://gitpm.example.test/auth/callback",
      protocol: gitlab,
    });
    const login = auth.startLogin();
    const session = await auth.completeLogin(login.state, "code");
    const publishing = new PublishingService(auth, drafts, client, gitlab, "main");

    const committed = await publishing.commitAll(session.session_id, "DRF-PUBLISH", "Update project");
    expect(committed.commit).toMatch(/^[0-9a-f]{40}$/u);
    const pushed = await publishing.push(session.session_id, "DRF-PUBLISH");
    expect(await git(root, "--git-dir", remote, "rev-parse", "refs/heads/gitpm/42/DRF-PUBLISH")).toBe(pushed.commit);
    const mergeRequest = await publishing.createMergeRequest(session.session_id, "DRF-PUBLISH", "Update project", "Automated test");
    expect(mergeRequest).toMatchObject({ iid: 1, state: "opened", source_branch: "gitpm/42/DRF-PUBLISH", target_branch: "main" });
    expect(await publishing.pollMergeRequest(session.session_id, "DRF-PUBLISH")).toEqual(mergeRequest);

    const captures = JSON.stringify(gitlab.captures);
    expect(captures).toContain('"operation":"create-mr"');
    expect(captures).not.toContain("gitlab-test-double-access-token");
    expect(gitlab.captures.filter((capture) => capture.operation === "project-role")).toHaveLength(4);
    expect(JSON.stringify(commands)).not.toContain("gitlab-test-double-access-token");
    expect(await filesContain(data, "gitlab-test-double-access-token")).toBe(false);
  }, 60_000);
});
