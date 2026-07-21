import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRepositoryApp, loadRepositoryRuntimeConfiguration } from "./repository-runtime.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return stdout.trim();
}

async function fixtureRepository(): Promise<{ root: string; repository: string; data: string; remote: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gitpm-repository-runtime-"));
  temporaryDirectories.push(root);
  const repository = path.join(root, "selected-repository");
  const remote = path.join(root, "remote.git");
  await cp(path.resolve("fixtures", "schema-v1", "demo"), repository, { recursive: true });
  await git(repository, "init", "-b", "main");
  await git(repository, "add", ".");
  await git(repository, "-c", "user.name=Local User", "-c", "user.email=local@example.test", "commit", "-m", "Initial data");
  await git(root, "init", "--bare", remote);
  await git(repository, "remote", "add", "origin", remote);
  await git(repository, "push", "-u", "origin", "main");
  return { root, repository, data: path.join(root, "runtime-data"), remote };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })));
});

describe("normal repository runtime", () => {
  it("requires a real selected repository instead of silently creating a fixture", async () => {
    vi.stubEnv("GITPM_REPOSITORY_PATH", "");
    await expect(loadRepositoryRuntimeConfiguration()).rejects.toThrow(/GITPM_REPOSITORY_PATH/u);
  });

  it("opens the selected repository without login and keeps test fixtures out of runtime data", async () => {
    const fixture = await fixtureRepository();
    vi.stubEnv("GITPM_REPOSITORY_PATH", fixture.repository);
    vi.stubEnv("GITPM_DATA_DIR", fixture.data);
    vi.stubEnv("GITPM_GITLAB_CLIENT_ID", "");
    const app = await buildRepositoryApp();
    try {
      const session = await app.inject({ method: "GET", url: "/api/auth/session" });
      expect(session.statusCode).toBe(200);
      expect(session.json()).toMatchObject({
        mode: "repository",
        repository: { name: "selected-repository", path: fixture.repository, has_remote: false },
        gitlab: { configured: false },
      });
      const drafts = await app.inject({ method: "GET", url: "/api/drafts" });
      expect(drafts.statusCode).toBe(200);
      expect(drafts.json()).toEqual([expect.objectContaining({ draft_id: "DRF-LOCAL", writer_mode: "ui", state: "open" })]);
      const projects = await app.inject({ method: "GET", url: "/api/drafts/DRF-LOCAL/entities/projects" });
      expect(projects.statusCode).toBe(200);
      expect(projects.json()).toEqual(expect.arrayContaining([
        expect.objectContaining({ document: expect.objectContaining({ schema: "gitpm/project@1", name: "GitPM launch" }) }),
        expect.objectContaining({ document: expect.objectContaining({ schema: "gitpm/project@1", name: "Operations" }) }),
      ]));
      const draft = await app.inject({ method: "POST", url: "/api/drafts", payload: { draft_id: "DRF-REAL-REPOSITORY" } });
      expect(draft.statusCode).toBe(201);
      await expect(stat(path.join(fixture.data, "source"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await app.close();
    }
  });
});

describe("repository mode selection", () => {
  it("defaults to direct mode and clones a normal checkout with .git under the data directory", async () => {
    const fixture = await fixtureRepository();
    vi.stubEnv("GITPM_REPOSITORY_PATH", fixture.repository);
    vi.stubEnv("GITPM_DATA_DIR", fixture.data);
    vi.stubEnv("GITPM_GITLAB_CLIENT_ID", "");
    vi.stubEnv("GITPM_REPOSITORY_MODE", "");
    const app = await buildRepositoryApp();
    try {
      const session = await app.inject({ method: "GET", url: "/api/auth/session" });
      expect(session.json()).toMatchObject({
        mode: "repository",
        repository_mode: "direct",
        repository: expect.objectContaining({ branch: "main" }),
      });
      // Direct mode produces a normal checkout, not a bare repository or worktrees.
      const checkoutStat = await stat(path.join(fixture.data, "repository", ".git"));
      expect(checkoutStat.isDirectory() || checkoutStat.isFile()).toBe(true);
      await expect(stat(path.join(fixture.data, "repository.git"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(path.join(fixture.data, "worktrees"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await app.close();
    }
  });

  it("commits onto main and pushes main to origin in direct mode", async () => {
    const fixture = await fixtureRepository();
    vi.stubEnv("GITPM_REPOSITORY_PATH", fixture.repository);
    vi.stubEnv("GITPM_DATA_DIR", fixture.data);
    vi.stubEnv("GITPM_GITLAB_CLIENT_ID", "");
    vi.stubEnv("GITPM_REPOSITORY_MODE", "direct");
    const app = await buildRepositoryApp();
    try {
      const projectPath = path.join(fixture.data, "repository", "projects", "P-26-MGP84K", "project.yaml");
      const original = await readFile(projectPath, "utf8");
      await writeFile(projectPath, original.replace("name: GitPM launch", "name: Direct launch"), "utf8");
      const commit = await app.inject({
        method: "POST",
        url: "/api/drafts/DRF-LOCAL/commit",
        payload: { message: "direct server commit" },
      });
      expect(commit.statusCode).toBe(200);
      expect(commit.json()).toMatchObject({ branch: "main" });
      // HEAD of the managed checkout advanced onto main.
      expect(await git(path.join(fixture.data, "repository"), "log", "-1", "--format=%s")).toBe("direct server commit");
    } finally {
      await app.close();
    }
  });

  it("switches to worktree mode (bare repository + worktrees) when configured", async () => {
    const fixture = await fixtureRepository();
    vi.stubEnv("GITPM_REPOSITORY_PATH", fixture.repository);
    vi.stubEnv("GITPM_DATA_DIR", fixture.data);
    vi.stubEnv("GITPM_GITLAB_CLIENT_ID", "");
    vi.stubEnv("GITPM_REPOSITORY_MODE", "worktree");
    const app = await buildRepositoryApp();
    try {
      const session = await app.inject({ method: "GET", url: "/api/auth/session" });
      expect(session.json()).toMatchObject({ repository_mode: "worktree" });
      // Worktree mode builds the bare repository and a draft worktree.
      await expect(stat(path.join(fixture.data, "repository.git"))).resolves.toBeDefined();
      await expect(stat(path.join(fixture.data, "worktrees"))).resolves.toBeDefined();
    } finally {
      await app.close();
    }
  });

  it("rejects an unknown repository mode with a clear error", async () => {
    const fixture = await fixtureRepository();
    vi.stubEnv("GITPM_REPOSITORY_PATH", fixture.repository);
    vi.stubEnv("GITPM_DATA_DIR", fixture.data);
    vi.stubEnv("GITPM_REPOSITORY_MODE", "bare");
    await expect(buildRepositoryApp()).rejects.toThrow(/Unknown repository mode/u);
  });
});
