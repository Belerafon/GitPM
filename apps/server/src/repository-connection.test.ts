import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { GitClient } from "@gitpm/git-client";
import { RepositoryConnectionManager, assertGitLabRemoteMatchesProject } from "./repository-connection.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd, encoding: "utf8", windowsHide: true })).stdout.trim();
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "gitpm-connection-"));
  roots.push(root);
  const repository = path.join(root, "portfolio");
  const data = path.join(root, "data");
  const configPath = path.join(root, ".gitpm", "config.json");
  await mkdir(repository);
  await git(repository, "init", "-b", "main");
  await git(repository, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-m", "initial");
  const client = new GitClient({ dataDirectory: data, remoteUrl: repository, defaultBranch: "main", allowLocalRepository: true, askPassPath: path.resolve("scripts", "git-askpass.mjs") });
  const manager = new RepositoryConnectionManager({
    git: client,
    configPath,
    configuration: { repository, repositoryMode: "direct", defaultBranch: "main" },
    repositoryPath: repository,
    repositoryMode: "direct",
    defaultBranch: "main",
    remoteSource: "none",
    remoteEditable: true,
    gitlabEditable: true,
    redirectUri: "http://127.0.0.1:3000/api/auth/callback",
    directCheckoutPath: repository,
  });
  return { repository, configPath, manager };
}

afterEach(async () => await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))));

describe("repository connection", () => {
  it("persists one GitLab origin and applies it directly to the selected checkout", async () => {
    const test = await fixture();
    const updated = await test.manager.update({
      repository_url: "https://gitlab.example/group/portfolio.git",
      gitlab: { base_url: "https://gitlab.example", project: "group/portfolio", client_id: "client-id" },
    });

    expect(updated).toMatchObject({ repository_url: "https://gitlab.example/group/portfolio.git", remote_source: "config", gitlab: { configured: true } });
    expect(await git(test.repository, "remote", "get-url", "origin")).toBe("https://gitlab.example/group/portfolio.git");
    expect(JSON.parse(await readFile(test.configPath, "utf8"))).toMatchObject({
      repositoryUrl: "https://gitlab.example/group/portfolio.git",
      gitlab: { baseUrl: "https://gitlab.example", project: "group/portfolio", clientId: "client-id" },
    });
  });

  it("rejects a GitLab API project that differs from origin", async () => {
    expect(() => assertGitLabRemoteMatchesProject("https://gitlab.example/group/one.git", {
      baseUrl: "https://gitlab.example", project: "group/two", clientId: "client-id",
    })).toThrow(expect.objectContaining({ code: "GIT_REMOTE_PROJECT_MISMATCH" }));
  });

  it("requires explicit confirmation before replacing an existing origin", async () => {
    const test = await fixture();
    await test.manager.update({ repository_url: "https://gitlab.example/group/one.git" });
    await expect(test.manager.update({ repository_url: "https://gitlab.example/group/two.git" }))
      .rejects.toMatchObject({ code: "REPOSITORY_CONNECTION_CONFIRMATION_REQUIRED" });
    expect(await git(test.repository, "remote", "get-url", "origin")).toBe("https://gitlab.example/group/one.git");
  });
});
