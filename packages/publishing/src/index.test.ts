import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { DraftManager } from "@gitpm/drafts";
import { GitClient } from "@gitpm/git-client";
import { GitLabProtocolTestDouble } from "@gitpm/gitlab";
import { atomicWriteDomainFile } from "@gitpm/security";
import { PublicationService } from "./index.js";

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
  it("commits all, pushes through ASKPASS env, and creates and polls an MR", async () => {
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
      (await readFile(absolute, "utf8")).replace("name: GitPM launch", "name: GitPM publish"),
    );
    await drafts.setWriterMode("DRF-PUBLISH", "42", "ui");

    const gitlab = new GitLabProtocolTestDouble();
    const publishing = new PublicationService(drafts, client, { defaultBranch: "main", mergeRequests: gitlab });
    const workspace = { draftId: "DRF-PUBLISH" };
    const local = { ownerId: "42", authorName: "maintainer", authorEmail: "42@users.noreply.gitlab.example.test" };
    const remoteContext = { ownerId: "42", accessToken: () => "gitlab-test-double-access-token" };

    const committed = await publishing.commit(local, workspace, "Update project");
    expect(committed.commit).toMatch(/^[0-9a-f]{40}$/u);
    expect(await git(draft.worktree_path, "log", "-1", "--format=%an <%ae>"))
      .toBe("maintainer <42@users.noreply.gitlab.example.test>");
    const pushed = await publishing.push(remoteContext, workspace);
    expect(await git(root, "--git-dir", remote, "rev-parse", "refs/heads/gitpm/42/DRF-PUBLISH")).toBe(pushed.commit);
    const mergeRequest = await publishing.createMergeRequest(remoteContext, workspace, {
      title: "Update project",
      description: "Automated test",
    });
    expect(mergeRequest).toMatchObject({ iid: 1, state: "opened", source_branch: "gitpm/42/DRF-PUBLISH", target_branch: "main" });
    expect(await publishing.pollMergeRequest(remoteContext, workspace)).toEqual(mergeRequest);

    const captures = JSON.stringify(gitlab.captures);
    expect(captures).toContain('"operation":"create-mr"');
    expect(captures).not.toContain("gitlab-test-double-access-token");
    expect(JSON.stringify(commands)).not.toContain("gitlab-test-double-access-token");
    expect(await filesContain(data, "gitlab-test-double-access-token")).toBe(false);
  }, 60_000);
});
