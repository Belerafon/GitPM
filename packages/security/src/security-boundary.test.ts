import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertSafeBranchName,
  assertSafeRepositoryUrl,
  atomicWriteDomainFile,
  buildFetchInvocation,
  createGitProcessEnvironment,
  resolveDomainPath,
} from "./index.js";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gitpm-security-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Git process boundary", () => {
  it("rejects command, option and ref injection inputs", () => {
    const rejected = [
      "--upload-pack=evil",
      "main;calc",
      "main..evil",
      "main@{1}",
      "main lock.lock",
      "main\\evil",
      ".hidden/main",
    ];
    for (const value of rejected) {
      expect(() => assertSafeBranchName(value)).toThrowError(expect.objectContaining({ code: "GIT_REF_INVALID" }));
    }
    expect(assertSafeBranchName("feature/schema-v1")).toBe("feature/schema-v1");
  });

  it("allows only credential-free HTTPS repository URLs", () => {
    expect(assertSafeRepositoryUrl("https://gitlab.example.test/group/gitpm.git")).toBe("https://gitlab.example.test/group/gitpm.git");
    for (const value of [
      "http://gitlab.example.test/group/gitpm.git",
      "https://oauth2:secret@gitlab.example.test/group/gitpm.git",
      "file:///tmp/repo.git",
      "https://gitlab.example.test/group/gitpm.git?upload-pack=evil",
    ]) {
      expect(() => assertSafeRepositoryUrl(value)).toThrowError(expect.objectContaining({ code: "GIT_URL_INVALID" }));
    }
  });

  it("keeps credentials out of argv, URL, inherited Git config and inspection output", async () => {
    const root = await temporaryRoot();
    const token = "vfy-003-secret-token";
    const invocation = buildFetchInvocation(root, "https://gitlab.example.test/group/gitpm.git", "main");
    const environment = createGitProcessEnvironment({
      askPassPath: path.join(process.cwd(), "scripts", "git-askpass.mjs"),
      hooksPath: path.join(root, "hooks"),
      isolatedHome: path.join(root, "home"),
      token,
      baseEnvironment: { ...process.env, GIT_CONFIG_GLOBAL: "malicious.cfg" },
    });
    expect(environment.GIT_CONFIG_GLOBAL).toBeUndefined();
    expect(environment.GITPM_ASKPASS_TOKEN).toBe(token);

    const inspection = JSON.stringify({
      executable: invocation.executable,
      args: invocation.args,
      environmentKeys: Object.keys(environment).sort(),
    });
    expect(inspection).not.toContain(token);
    expect(JSON.stringify(invocation)).not.toContain(token);

    const result = spawnSync(process.execPath, [environment.GIT_ASKPASS!, "Password for Git:"], {
      encoding: "utf8",
      env: environment,
    });
    expect(result.status).toBe(0);
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    expect(digest(result.stdout)).toBe(digest(token));
    expect(result.stderr).toBe("");
  });
});

describe("filesystem boundary", () => {
  it("rejects traversal and a symlink component", async () => {
    const root = await temporaryRoot();
    const worktree = path.join(root, "worktree");
    const outside = path.join(root, "outside");
    await mkdir(worktree);
    await mkdir(outside);
    await symlink(outside, path.join(worktree, "linked"), process.platform === "win32" ? "junction" : "dir");

    await expect(resolveDomainPath(worktree, "../outside/data.yaml")).rejects.toMatchObject({ code: "FS_PATH_INVALID" });
    await expect(resolveDomainPath(worktree, "linked/data.yaml")).rejects.toMatchObject({ code: "FS_SYMLINK" });
  });

  it("writes through a same-directory temp file and atomic rename", async () => {
    const root = await temporaryRoot();
    const worktree = path.join(root, "worktree");
    await mkdir(path.join(worktree, "projects"), { recursive: true });
    await atomicWriteDomainFile(worktree, "projects/task.yaml", "schema: gitpm/task@1\n");
    expect(await readFile(path.join(worktree, "projects", "task.yaml"), "utf8")).toBe("schema: gitpm/task@1\n");
  });

  it("detects a parent symlink swap before rename and does not write outside", async () => {
    const root = await temporaryRoot();
    const worktree = path.join(root, "worktree");
    const parent = path.join(worktree, "projects");
    const movedParent = path.join(worktree, "projects-before-swap");
    const outside = path.join(root, "outside");
    await mkdir(parent, { recursive: true });
    await mkdir(outside);
    await writeFile(path.join(outside, "task.yaml"), "outside remains unchanged\n");

    await expect(atomicWriteDomainFile(worktree, "projects/task.yaml", "unsafe\n", {
      beforeRenameForTest: async () => {
        await rename(parent, movedParent);
        await symlink(outside, parent, process.platform === "win32" ? "junction" : "dir");
      },
    })).rejects.toMatchObject({ code: "FS_PARENT_CHANGED" });
    expect(await readFile(path.join(outside, "task.yaml"), "utf8")).toBe("outside remains unchanged\n");
  });
});
