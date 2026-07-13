import { execFile } from "node:child_process";
import { cp, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRepositoryApp, loadRepositoryRuntimeConfiguration } from "./repository-runtime.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

async function fixtureRepository(): Promise<{ root: string; repository: string; data: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gitpm-repository-runtime-"));
  temporaryDirectories.push(root);
  const repository = path.join(root, "selected-repository");
  await cp(path.resolve("fixtures", "schema-v1", "demo"), repository, { recursive: true });
  await git(repository, "init", "-b", "main");
  await git(repository, "add", ".");
  await git(repository, "-c", "user.name=Local User", "-c", "user.email=local@example.test", "commit", "-m", "Initial data");
  return { root, repository, data: path.join(root, "runtime-data") };
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
