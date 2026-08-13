import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DraftRuntimeError, type DraftManager, type DraftMetadata, type RepositoryWorkspace } from "@gitpm/drafts";
import { ProjectFileStore } from "@gitpm/domain";
import { buildApp } from "./app.js";

const projectId = "P-26-MGP84K";
const otherProjectId = "P-26-8S9HQQ";
const absentProjectId = "P-26-ABCDEF";
let root: string;

function manager(owner = "42", writerMode: "ui" | "external" = "ui"): DraftManager {
  const workspace: RepositoryWorkspace = {
    workspace_id: "DRF-FILES",
    owner_id: owner,
    branch: "draft/files",
    base_commit: "a".repeat(40),
    worktree_path: root,
    fingerprint: "f".repeat(64),
    created_at: "2026-08-13T10:00:00.000Z",
    updated_at: "2026-08-13T10:00:00.000Z",
  };
  const draft: DraftMetadata = {
    version: 1,
    draft_id: workspace.workspace_id,
    owner_gitlab_user_id: owner,
    branch: workspace.branch,
    base_commit: workspace.base_commit,
    worktree_path: workspace.worktree_path,
    writer_mode: writerMode,
    state: "open",
    fingerprint: workspace.fingerprint,
    created_at: workspace.created_at,
    updated_at: workspace.updated_at,
  };
  return {
    repositoryMode: "worktree",
    getDraft: async () => draft,
    getWorkspace: async () => ({ ...workspace, fingerprint: draft.fingerprint }),
    withUiMutation: async (_draftId: string, mutationOwner: string, expectedFingerprint: string, mutation: (metadata: DraftMetadata) => Promise<unknown>) => {
      if (mutationOwner !== draft.owner_gitlab_user_id) throw new DraftRuntimeError("DRAFT_FORBIDDEN", "Draft owner mismatch");
      if (draft.writer_mode !== "ui") throw new DraftRuntimeError("DRAFT_READ_ONLY", "UI is read-only in external writer mode");
      if (expectedFingerprint !== draft.fingerprint) throw new DraftRuntimeError("DRAFT_CHANGED_EXTERNALLY", "Draft changed externally");
      const result = await mutation(draft);
      const next = { ...draft, fingerprint: "e".repeat(64) };
      Object.assign(draft, next);
      return { result, metadata: next };
    },
  } as unknown as DraftManager;
}

async function addProject(id: string): Promise<string> {
  const project = path.join(root, "projects", id);
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, "project.yaml"), `schema: gitpm/project@2\nid: ${id}\n`, "utf8");
  return project;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "gitpm-project-files-api-"));
  await cp(path.join(process.cwd(), "fixtures", "schema-v1", "demo"), root, { recursive: true });
});

afterEach(async () => rm(root, { recursive: true, force: true }));

function appFor(owner = "42", actor = "42", role: "Reporter" | "Developer" | "Maintainer" = "Reporter", writerMode: "ui" | "external" = "ui") {
  const drafts = manager(owner, writerMode);
  return buildApp({
    authenticate: () => ({ userId: actor, role }),
    draftManager: drafts,
    projectFileStore: new ProjectFileStore(drafts),
  });
}

function uploadHeaders(name: string, bytes: Buffer, overrides: Readonly<Record<string, string>> = {}): Readonly<Record<string, string>> {
  return {
    "content-type": "application/octet-stream",
    "x-gitpm-file-name": encodeURIComponent(name),
    "x-gitpm-upload-size": String(bytes.byteLength),
    "x-gitpm-expected-fingerprint": "f".repeat(64),
    "x-gitpm-upload-mode": "create",
    ...overrides,
  };
}

describe("Project files read API", () => {
  it("returns an empty list with a stable shared DTO", async () => {
    const app = appFor();
    const response = await app.inject({ method: "GET", url: `/api/drafts/DRF-FILES/projects/${projectId}/files` });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      project_id: projectId,
      count: 0,
      total_size_bytes: 0,
      items: [],
      draft_fingerprint: "f".repeat(64),
    });
  });

  it("lists Unicode files and streams safe previews with RFC 5987 names", async () => {
    const files = path.join(root, "projects", projectId, "files");
    await mkdir(files);
    await writeFile(path.join(files, "ТЗ v3.pdf"), Buffer.from([0x25, 0x50, 0x44, 0x46]));
    const app = appFor();

    const listing = await app.inject({ method: "GET", url: `/api/drafts/DRF-FILES/projects/${projectId}/files` });
    const content = await app.inject({
      method: "GET",
      url: `/api/drafts/DRF-FILES/projects/${projectId}/files/${encodeURIComponent("ТЗ v3.pdf")}/content`,
    });
    await app.close();

    expect(listing.json()).toMatchObject({ count: 1, total_size_bytes: 4, items: [{ name: "ТЗ v3.pdf", disposition: "inline" }] });
    expect(content.statusCode).toBe(200);
    expect(content.headers["content-type"]).toBe("application/pdf");
    expect(content.headers["content-disposition"]).toMatch(/^inline; filename="__ v3\.pdf"; filename\*=UTF-8''/u);
    expect(content.headers["x-content-type-options"]).toBe("nosniff");
    expect(content.headers["cache-control"]).toBe("no-store");
    expect(content.rawPayload).toEqual(Buffer.from([0x25, 0x50, 0x44, 0x46]));
  });

  it("forces download and never renders Office, SVG or unknown content inline", async () => {
    const files = path.join(root, "projects", projectId, "files");
    await mkdir(files);
    await Promise.all([
      writeFile(path.join(files, "contract.docx"), "office", "utf8"),
      writeFile(path.join(files, "drawing.svg"), "<svg onload='alert(1)'></svg>", "utf8"),
      writeFile(path.join(files, "readme.txt"), "text", "utf8"),
    ]);
    const app = appFor();

    const office = await app.inject({ method: "GET", url: `/api/drafts/DRF-FILES/projects/${projectId}/files/contract.docx/content` });
    const svg = await app.inject({ method: "GET", url: `/api/drafts/DRF-FILES/projects/${projectId}/files/drawing.svg/content` });
    const forced = await app.inject({ method: "GET", url: `/api/drafts/DRF-FILES/projects/${projectId}/files/readme.txt/download` });
    await app.close();

    expect(office.headers["content-type"]).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(office.headers["content-disposition"]).toMatch(/^attachment;/u);
    expect(svg.headers["content-type"]).toBe("application/octet-stream");
    expect(svg.headers["content-disposition"]).toMatch(/^attachment;/u);
    expect(forced.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(forced.headers["content-disposition"]).toMatch(/^attachment;/u);
  });

  it("returns stable errors for missing files, hostile names, absent Projects and another owner", async () => {
    const app = appFor();
    const missing = await app.inject({ method: "GET", url: `/api/drafts/DRF-FILES/projects/${projectId}/files/missing.pdf/content` });
    const hostile = await app.inject({ method: "GET", url: `/api/drafts/DRF-FILES/projects/${projectId}/files/${encodeURIComponent("..\\secret.txt")}/content` });
    const encodedSlash = await app.inject({ method: "GET", url: `/api/drafts/DRF-FILES/projects/${projectId}/files/folder%2Fsecret.txt/content` });
    const absentProject = await app.inject({ method: "GET", url: `/api/drafts/DRF-FILES/projects/${absentProjectId}/files` });
    await app.close();
    const forbiddenApp = appFor("99", "42");
    const forbidden = await forbiddenApp.inject({ method: "GET", url: `/api/drafts/DRF-FILES/projects/${projectId}/files` });
    await forbiddenApp.close();

    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: "PROJECT_FILE_NOT_FOUND" } });
    expect(hostile.statusCode).toBe(400);
    expect(hostile.json()).toMatchObject({ error: { code: "PROJECT_FILE_NAME_INVALID" } });
    expect(encodedSlash.statusCode).toBe(400);
    expect(encodedSlash.json()).toMatchObject({ error: { code: "PROJECT_FILE_NAME_INVALID" } });
    expect(absentProject.statusCode).toBe(404);
    expect(absentProject.json()).toMatchObject({ error: { code: "ENTITY_NOT_FOUND" } });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toMatchObject({ error: { code: "DRAFT_FORBIDDEN" } });
  });

  it("never reads a same-named file from another Project", async () => {
    const first = path.join(root, "projects", projectId, "files");
    const second = path.join(await addProject(otherProjectId), "files");
    await Promise.all([mkdir(first), mkdir(second)]);
    await Promise.all([
      writeFile(path.join(first, "contract.txt"), "first", "utf8"),
      writeFile(path.join(second, "contract.txt"), "second", "utf8"),
    ]);
    const app = appFor();

    const response = await app.inject({ method: "GET", url: `/api/drafts/DRF-FILES/projects/${projectId}/files/contract.txt/content` });
    await app.close();

    expect(response.body).toBe("first");
  });
});

describe("Project files upload API", () => {
  it("streams exact binary bytes, Unicode names and zero-byte files without base64", async () => {
    const app = appFor("42", "42", "Developer");
    const bytes = Buffer.from([0, 255, 1, 254, 2]);
    const uploaded = await app.inject({
      method: "POST",
      url: `/api/drafts/DRF-FILES/projects/${projectId}/files/upload`,
      headers: uploadHeaders("Договор.bin", bytes),
      payload: bytes,
    });
    const empty = Buffer.alloc(0);
    const zero = await app.inject({
      method: "POST",
      url: `/api/drafts/DRF-FILES/projects/${projectId}/files/upload`,
      headers: uploadHeaders("empty.txt", empty, { "x-gitpm-expected-fingerprint": "e".repeat(64) }),
      payload: empty,
    });
    await app.close();

    expect(uploaded.statusCode).toBe(201);
    expect(uploaded.json()).toMatchObject({ operation: "created", item: { name: "Договор.bin", size_bytes: bytes.byteLength }, draft_fingerprint: "e".repeat(64) });
    expect(await readFile(path.join(root, "projects", projectId, "files", "Договор.bin"))).toEqual(bytes);
    expect(zero.statusCode).toBe(201);
    expect(await readFile(path.join(root, "projects", projectId, "files", "empty.txt"))).toEqual(empty);
  });

  it("never overwrites implicitly and replaces only in explicit mode", async () => {
    const files = path.join(root, "projects", projectId, "files");
    await mkdir(files);
    await writeFile(path.join(files, "contract.txt"), "old", "utf8");
    const app = appFor("42", "42", "Developer");
    const bytes = Buffer.from("new");
    const conflict = await app.inject({
      method: "POST", url: `/api/drafts/DRF-FILES/projects/${projectId}/files/upload`,
      headers: uploadHeaders("contract.txt", bytes), payload: bytes,
    });
    const replaced = await app.inject({
      method: "POST", url: `/api/drafts/DRF-FILES/projects/${projectId}/files/upload`,
      headers: uploadHeaders("contract.txt", bytes, { "x-gitpm-upload-mode": "replace" }), payload: bytes,
    });
    await app.close();

    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: "PROJECT_FILE_EXISTS" } });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.json()).toMatchObject({ operation: "replaced" });
    await expect(readFile(path.join(files, "contract.txt"), "utf8")).resolves.toBe("new");
  });

  it.each([
    ["read-only role", "42", "42", "Reporter", "ui", "f".repeat(64), 403, "DRAFT_FORBIDDEN"],
    ["another owner", "99", "42", "Developer", "ui", "f".repeat(64), 403, "DRAFT_FORBIDDEN"],
    ["external writer mode", "42", "42", "Developer", "external", "f".repeat(64), 409, "DRAFT_READ_ONLY"],
    ["stale fingerprint", "42", "42", "Developer", "ui", "a".repeat(64), 409, "DRAFT_CHANGED_EXTERNALLY"],
  ] as const)("rejects %s before mutation", async (_label, owner, actor, role, writerMode, fingerprint, status, code) => {
    const app = appFor(owner, actor, role, writerMode);
    const bytes = Buffer.from("data");
    const response = await app.inject({
      method: "POST", url: `/api/drafts/DRF-FILES/projects/${projectId}/files/upload`,
      headers: uploadHeaders("blocked.bin", bytes, { "x-gitpm-expected-fingerprint": fingerprint }), payload: bytes,
    });
    await app.close();
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ error: { code } });
    await expect(readFile(path.join(root, "projects", projectId, "files", "blocked.bin"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("validates declared stream size and upload metadata with stable codes", async () => {
    const app = appFor("42", "42", "Developer");
    const bytes = Buffer.from("three");
    const mismatch = await app.inject({
      method: "POST", url: `/api/drafts/DRF-FILES/projects/${projectId}/files/upload`,
      headers: uploadHeaders("wrong.bin", bytes, { "x-gitpm-upload-size": "2" }), payload: bytes,
    });
    const missingNameHeaders = { ...uploadHeaders("unused.bin", bytes) } as Record<string, string>;
    delete missingNameHeaders["x-gitpm-file-name"];
    const missingName = await app.inject({
      method: "POST", url: `/api/drafts/DRF-FILES/projects/${projectId}/files/upload`,
      headers: missingNameHeaders, payload: bytes,
    });
    const hostile = await app.inject({
      method: "POST", url: `/api/drafts/DRF-FILES/projects/${projectId}/files/upload`,
      headers: uploadHeaders("..\\escape.bin", bytes), payload: bytes,
    });
    const wrongContentType = await app.inject({
      method: "POST", url: `/api/drafts/DRF-FILES/projects/${projectId}/files/upload`,
      headers: { ...uploadHeaders("plain.bin", bytes), "content-type": "text/plain" }, payload: bytes,
    });
    await app.close();
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json()).toMatchObject({ error: { code: "PROJECT_FILE_UPLOAD_SIZE_MISMATCH" } });
    expect(missingName.statusCode).toBe(400);
    expect(missingName.json()).toMatchObject({ error: { code: "PROJECT_FILE_UPLOAD_METADATA_INVALID" } });
    expect(hostile.statusCode).toBe(400);
    expect(hostile.json()).toMatchObject({ error: { code: "PROJECT_FILE_NAME_INVALID" } });
    expect(wrongContentType.statusCode).toBe(415);
    expect(wrongContentType.json()).toMatchObject({ error: { code: "PROJECT_FILE_UPLOAD_CONTENT_TYPE_REQUIRED" } });
  });

  it("requires exact encoded file-name confirmation above 50 MiB", async () => {
    const app = appFor("42", "42", "Developer");
    const declared = String(50 * 1024 * 1024 + 1);
    const headers = uploadHeaders("Большой.bin", Buffer.alloc(0), { "x-gitpm-upload-size": declared });
    const missing = await app.inject({ method: "POST", url: `/api/drafts/DRF-FILES/projects/${projectId}/files/upload`, headers, payload: Buffer.alloc(0) });
    const wrong = await app.inject({
      method: "POST", url: `/api/drafts/DRF-FILES/projects/${projectId}/files/upload`,
      headers: { ...headers, "x-gitpm-large-file-confirmation": encodeURIComponent("большой.bin") }, payload: Buffer.alloc(0),
    });
    await app.close();
    expect(missing.statusCode).toBe(409);
    expect(missing.json()).toMatchObject({ error: { code: "PROJECT_FILE_LARGE_CONFIRMATION_REQUIRED" } });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json()).toMatchObject({ error: { code: "PROJECT_FILE_LARGE_CONFIRMATION_REQUIRED" } });
  });

  it("checks draft ownership before exposing large-file confirmation requirements", async () => {
    const app = appFor("99", "42", "Developer");
    const response = await app.inject({
      method: "POST",
      url: `/api/drafts/DRF-FILES/projects/${projectId}/files/upload`,
      headers: uploadHeaders("large.bin", Buffer.alloc(0), { "x-gitpm-upload-size": String(50 * 1024 * 1024 + 1) }),
      payload: Buffer.alloc(0),
    });
    await app.close();
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "DRAFT_FORBIDDEN" } });
  });
});
