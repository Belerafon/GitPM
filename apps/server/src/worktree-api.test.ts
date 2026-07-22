import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DraftManager, DraftMetadata } from "@gitpm/drafts";
import { DraftRuntimeError } from "@gitpm/drafts";
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

function mutableManager(worktreePath: string): DraftManager {
  const current: DraftMetadata = {
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
    getDraft: vi.fn(async () => current),
    listDrafts: vi.fn(async () => [current]),
    withUiMutation: vi.fn(async (_draftId: string, owner: string, expectedFingerprint: string, mutation: (meta: DraftMetadata) => Promise<unknown>) => {
      if (owner !== current.owner_gitlab_user_id) throw new DraftRuntimeError("DRAFT_FORBIDDEN", "Draft owner mismatch");
      if (expectedFingerprint !== current.fingerprint) throw new DraftRuntimeError("DRAFT_CHANGED_EXTERNALLY", "Draft worktree changed outside the UI runtime");
      const result = await mutation(current);
      const next: DraftMetadata = { ...current, fingerprint: "d".repeat(64), updated_at: "2026-07-21T01:00:00.000Z" };
      Object.assign(current, next);
      return { result, metadata: next };
    }),
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

describe("working tree file mutations", () => {
  const fingerprint = "b".repeat(64);
  const worktree = () => path.join(root, "worktree");

  beforeEach(() => {
    app = buildApp({ authenticate: () => ({ userId: "42", role: "Developer" }), draftManager: mutableManager(worktree()) });
  });

  it("creates a directory and returns the new fingerprint", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/drafts/DRF-TREE/worktree/directory",
      payload: { expected_fingerprint: fingerprint, path: "uploads" },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ path: "uploads", draft_fingerprint: "d".repeat(64) });
    await expect(stat(path.join(worktree(), "uploads"))).resolves.toBeDefined();
  });

  it("rejects creating a directory that already exists", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/drafts/DRF-TREE/worktree/directory",
      payload: { expected_fingerprint: fingerprint, path: "docs" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "WORKTREE_ENTRY_EXISTS" } });
  });

  it("uploads a binary file and writes its exact bytes", async () => {
    const bytes = Buffer.from([0, 1, 2, 3, 4, 5]);
    const response = await app.inject({
      method: "POST",
      url: "/api/drafts/DRF-TREE/worktree/file",
      payload: { expected_fingerprint: fingerprint, path: "docs/uploaded.bin", content_base64: bytes.toString("base64") },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ path: "docs/uploaded.bin", size: bytes.byteLength, draft_fingerprint: "d".repeat(64) });
    expect(await readFile(path.join(worktree(), "docs", "uploaded.bin"))).toEqual(bytes);
  });

  it("accepts an upload larger than the default 1 MiB JSON body cap", async () => {
    const bytes = Buffer.alloc(2 * 1024 * 1024, 7);
    const response = await app.inject({
      method: "POST",
      url: "/api/drafts/DRF-TREE/worktree/file",
      payload: { expected_fingerprint: fingerprint, path: "big.dat", content_base64: bytes.toString("base64") },
    });
    expect(response.statusCode).toBe(201);
    expect((await stat(path.join(worktree(), "big.dat"))).size).toBe(bytes.byteLength);
  });

  it("rejects invalid base64 upload content", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/drafts/DRF-TREE/worktree/file",
      payload: { expected_fingerprint: fingerprint, path: "docs/bad.bin", content_base64: "not!!base64" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "WORKTREE_UPLOAD_INVALID" } });
  });

  it("deletes a file and recursively deletes a directory", async () => {
    const fileResponse = await app.inject({
      method: "DELETE",
      url: "/api/drafts/DRF-TREE/worktree/entry",
      payload: { expected_fingerprint: fingerprint, path: "README.md" },
    });
    expect(fileResponse.statusCode).toBe(200);
    await expect(stat(path.join(worktree(), "README.md"))).rejects.toMatchObject({ code: "ENOENT" });

    const dirResponse = await app.inject({
      method: "DELETE",
      url: "/api/drafts/DRF-TREE/worktree/entry",
      payload: { expected_fingerprint: "d".repeat(64), path: "docs" },
    });
    expect(dirResponse.statusCode).toBe(200);
    await expect(stat(path.join(worktree(), "docs"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("renames and moves entries via the move endpoint", async () => {
    const rename = await app.inject({
      method: "POST",
      url: "/api/drafts/DRF-TREE/worktree/move",
      payload: { expected_fingerprint: fingerprint, from: "README.md", to: "renamed.md" },
    });
    expect(rename.statusCode).toBe(200);
    expect(await readFile(path.join(worktree(), "renamed.md"), "utf8")).toBe("# Привет\n");

    const move = await app.inject({
      method: "POST",
      url: "/api/drafts/DRF-TREE/worktree/move",
      payload: { expected_fingerprint: "d".repeat(64), from: "renamed.md", to: "docs/renamed.md" },
    });
    expect(move.statusCode).toBe(200);
    await expect(stat(path.join(worktree(), "renamed.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(worktree(), "docs", "renamed.md"), "utf8")).resolves.toBe("# Привет\n");
  });

  it.each([
    ["create directory outside tree", "POST", "/api/drafts/DRF-TREE/worktree/directory", { expected_fingerprint: fingerprint, path: "../outside/x" }, 403, "WORKTREE_PATH_FORBIDDEN"],
    ["upload into git metadata", "POST", "/api/drafts/DRF-TREE/worktree/file", { expected_fingerprint: fingerprint, path: ".git/evil", content_base64: "YQ==" }, 403, "WORKTREE_PATH_FORBIDDEN"],
    ["delete via symlink escape", "DELETE", "/api/drafts/DRF-TREE/worktree/entry", { expected_fingerprint: fingerprint, path: "outside-link" }, 403, "WORKTREE_PATH_FORBIDDEN"],
    ["delete empty path", "DELETE", "/api/drafts/DRF-TREE/worktree/entry", { expected_fingerprint: fingerprint, path: "" }, 400, "WORKTREE_PATH_INVALID"],
    ["move onto existing target", "POST", "/api/drafts/DRF-TREE/worktree/move", { expected_fingerprint: fingerprint, from: "README.md", to: "AGENTS.md" }, 409, "WORKTREE_ENTRY_EXISTS"],
    ["move a folder into itself", "POST", "/api/drafts/DRF-TREE/worktree/move", { expected_fingerprint: fingerprint, from: "docs", to: "docs/nested" }, 409, "WORKTREE_MOVE_INVALID"],
    ["stale fingerprint", "POST", "/api/drafts/DRF-TREE/worktree/directory", { expected_fingerprint: "0".repeat(64), path: "fresh" }, 409, "DRAFT_CHANGED_EXTERNALLY"],
  ])("rejects unsafe or invalid mutation: %s", async (_name, method, url, payload, status, code) => {
    const response = await app.inject({ method: method as "POST" | "DELETE", url, payload });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ error: { code } });
    expect(response.body).not.toContain(root);
  });

  it("forbids mutations for read-only roles", async () => {
    await app.close();
    app = buildApp({ authenticate: () => ({ userId: "42", role: "Reporter" }), draftManager: mutableManager(worktree()) });
    const response = await app.inject({
      method: "POST",
      url: "/api/drafts/DRF-TREE/worktree/directory",
      payload: { expected_fingerprint: fingerprint, path: "forbidden" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "DRAFT_FORBIDDEN" } });
  });
});
