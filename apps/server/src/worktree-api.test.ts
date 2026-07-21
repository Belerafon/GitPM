import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DraftManager, DraftMetadata } from "@gitpm/drafts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";

let root = "";
let app: ReturnType<typeof buildApp>;

function manager(worktreePath: string): DraftManager {
  const metadata: DraftMetadata = {
    version: 1,
    draft_id: "DRF-TREE",
    owner_gitlab_user_id: "42",
    branch: "gitpm/42/DRF-TREE",
    base_commit: "a".repeat(40),
    worktree_path: worktreePath,
    writer_mode: "ui",
    state: "open",
    fingerprint: "b".repeat(64),
    created_at: "2026-07-21T00:00:00.000Z",
    updated_at: "2026-07-21T00:00:00.000Z",
  };
  return {
    getDraft: vi.fn(async () => metadata),
    listDrafts: vi.fn(async () => [metadata]),
  } as unknown as DraftManager;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "gitpm-worktree-api-"));
  const worktree = path.join(root, "worktree");
  await mkdir(path.join(worktree, "docs"), { recursive: true });
  await mkdir(path.join(worktree, ".agents", "skills", "gitpm"), { recursive: true });
  await mkdir(path.join(worktree, ".git"), { recursive: true });
  await writeFile(path.join(worktree, "AGENTS.md"), "# GitPM draft agent instructions\n", "utf8");
  await writeFile(path.join(worktree, ".agents", "skills", "gitpm", "SKILL.md"), "---\nname: gitpm\n---\n", "utf8");
  await writeFile(path.join(worktree, "README.md"), "# Привет\n", "utf8");
  await writeFile(path.join(worktree, "docs", "guide.txt"), "Guide", "utf8");
  await writeFile(path.join(worktree, "binary.bin"), Buffer.from([0, 1, 2, 3]));
  await writeFile(path.join(worktree, "large.txt"), Buffer.alloc(1_048_577, 65));
  await writeFile(path.join(worktree, ".git", "config"), "secret", "utf8");
  const outside = path.join(root, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
  await symlink(outside, path.join(worktree, "outside-link"), process.platform === "win32" ? "junction" : "dir");
  app = buildApp({ authenticate: () => ({ userId: "42", role: "Reporter" }), draftManager: manager(worktree) });
});

afterEach(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});

describe("read-only working tree API", () => {
  it("lists directories lazily, hides Git metadata, and returns UTF-8 text", async () => {
    const listing = await app.inject({ method: "GET", url: "/api/drafts/DRF-TREE/worktree" });
    expect(listing.statusCode).toBe(200);
    expect(listing.json()).toEqual({
      path: "",
      entries: [
        { name: ".agents", path: ".agents", type: "directory" },
        { name: "docs", path: "docs", type: "directory" },
        { name: "AGENTS.md", path: "AGENTS.md", type: "file", size: Buffer.byteLength("# GitPM draft agent instructions\n") },
        { name: "README.md", path: "README.md", type: "file", size: Buffer.byteLength("# Привет\n") },
        { name: "binary.bin", path: "binary.bin", type: "file", size: 4 },
        { name: "large.txt", path: "large.txt", type: "file", size: 1_048_577 },
        { name: "outside-link", path: "outside-link", type: "symlink" },
      ],
    });
    expect(listing.body).not.toContain(".git");

    const nested = await app.inject({ method: "GET", url: "/api/drafts/DRF-TREE/worktree?path=docs" });
    expect(nested.json()).toMatchObject({ path: "docs", entries: [{ path: "docs/guide.txt", type: "file" }] });
    const skill = await app.inject({ method: "GET", url: "/api/drafts/DRF-TREE/worktree?path=.agents%2Fskills%2Fgitpm" });
    expect(skill.json()).toMatchObject({ path: ".agents/skills/gitpm", entries: [{ path: ".agents/skills/gitpm/SKILL.md", type: "file" }] });
    const file = await app.inject({ method: "GET", url: "/api/drafts/DRF-TREE/worktree/file?path=README.md" });
    expect(file.statusCode).toBe(200);
    expect(file.json()).toEqual({ path: "README.md", size: Buffer.byteLength("# Привет\n"), content: "# Привет\n" });
  });

  it.each([
    ["/api/drafts/DRF-TREE/worktree?path=..%2Foutside", 403, "WORKTREE_PATH_FORBIDDEN"],
    ["/api/drafts/DRF-TREE/worktree?path=.git", 403, "WORKTREE_PATH_FORBIDDEN"],
    ["/api/drafts/DRF-TREE/worktree?path=outside-link", 403, "WORKTREE_PATH_FORBIDDEN"],
    ["/api/drafts/DRF-TREE/worktree/file?path=binary.bin", 415, "WORKTREE_FILE_BINARY"],
    ["/api/drafts/DRF-TREE/worktree/file?path=large.txt", 413, "WORKTREE_FILE_TOO_LARGE"],
    ["/api/drafts/DRF-TREE/worktree/file?path=missing.txt", 404, "WORKTREE_ENTRY_NOT_FOUND"],
  ])("rejects unsafe or unavailable preview %s", async (url, status, code) => {
    const response = await app.inject({ method: "GET", url });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ error: { code } });
    expect(response.body).not.toContain(root);
  });

  it("applies normal draft ownership checks to repository reads", async () => {
    await app.close();
    app = buildApp({ authenticate: () => ({ userId: "99", role: "Reporter" }), draftManager: manager(path.join(root, "worktree")) });
    const response = await app.inject({ method: "GET", url: "/api/drafts/DRF-TREE/worktree" });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "DRAFT_FORBIDDEN" } });
  });
});
