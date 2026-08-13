import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DraftRuntimeError, type DraftManager, type DraftMetadata, type RepositoryWorkspace } from "@gitpm/drafts";
import { ProjectFileStore } from "@gitpm/domain";
import { formatYamlDocument, parseYamlDocument } from "@gitpm/repository-format";
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

  it("previews exact references for a read-only actor without exposing host paths", async () => {
    const project = path.join(root, "projects", projectId);
    const files = path.join(project, "files");
    await mkdir(files);
    await writeFile(path.join(files, "spec.txt"), "bytes", "utf8");
    await writeFile(path.join(project, "project.yaml"), `schema: gitpm/project@2\nid: ${projectId}\ndescription_markdown: '[[file:spec.txt]]'\n`, "utf8");
    const app = appFor("42", "42", "Reporter");
    const response = await app.inject({ method: "GET", url: `/api/drafts/DRF-FILES/projects/${projectId}/files/spec.txt/references` });
    await app.close();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ project_id: projectId, file_name: "spec.txt", status: "checked", count: 1, draft_fingerprint: "f".repeat(64) });
    expect(JSON.stringify(response.json())).not.toContain(root);
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

  it("returns checked references only for explicit exact replacement", async () => {
    const project = path.join(root, "projects", projectId);
    const files = path.join(project, "files");
    await mkdir(files);
    await writeFile(path.join(files, "contract.txt"), "old", "utf8");
    const projectFile = path.join(project, "project.yaml");
    await writeFile(projectFile, formatYamlDocument({ ...parseYamlDocument(await readFile(projectFile, "utf8")), description_markdown: "[[file:contract.txt]]" }), "utf8");
    let app = appFor("42", "42", "Developer");
    const checked = await app.inject({ method: "POST", url: `/api/drafts/DRF-FILES/projects/${projectId}/files/upload`, headers: uploadHeaders("contract.txt", Buffer.from("new"), { "x-gitpm-upload-mode": "replace", "x-gitpm-reference-mode": "preserve_checked" }), payload: Buffer.from("new") });
    await app.close();
    expect(checked.json()).toMatchObject({ operation: "replaced", references: { status: "checked", action: "preserved", before_count: 1, remaining_count: 1 } });
    app = appFor("42", "42", "Developer");
    const legacy = await app.inject({ method: "POST", url: `/api/drafts/DRF-FILES/projects/${projectId}/files/upload`, headers: uploadHeaders("contract.txt", Buffer.from("new"), { "x-gitpm-upload-mode": "replace" }), payload: Buffer.from("new") });
    expect(legacy.json()).toMatchObject({ references: { status: "not_checked" } });
    const invalidCreate = await app.inject({ method: "POST", url: `/api/drafts/DRF-FILES/projects/${projectId}/files/upload`, headers: uploadHeaders("created.txt", Buffer.from("new"), { "x-gitpm-reference-mode": "preserve_checked", "x-gitpm-expected-fingerprint": "e".repeat(64) }), payload: Buffer.from("new") });
    await app.close();
    expect(invalidCreate.statusCode).toBe(409);
    expect(invalidCreate.json()).toMatchObject({ error: { code: "PROJECT_FILE_REFERENCES_UNSUPPORTED" } });
  });

  it("atomically replaces a selected file with a differently named upload and updates references", async () => {
    const project = path.join(root, "projects", projectId);
    const files = path.join(project, "files");
    await mkdir(files);
    await writeFile(path.join(files, "old.txt"), "old", "utf8");
    const projectFile = path.join(project, "project.yaml");
    await writeFile(projectFile, formatYamlDocument({ ...parseYamlDocument(await readFile(projectFile, "utf8")), description_markdown: "[[file:old.txt]]" }), "utf8");
    const app = appFor("42", "42", "Developer");
    const bytes = Buffer.from("new bytes");
    const response = await app.inject({
      method: "POST", url: `/api/drafts/DRF-FILES/projects/${projectId}/files/old.txt/replace`,
      headers: uploadHeaders("new.txt", bytes), payload: bytes,
    });
    await app.close();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ operation: "replaced", previous_name: "old.txt", item: { name: "new.txt" }, references: { action: "updated", before_count: 1, affected_count: 1, remaining_count: 0 } });
    await expect(readFile(path.join(files, "old.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(files, "new.txt"), "utf8")).resolves.toBe("new bytes");
    expect(await readFile(projectFile, "utf8")).toContain("[[file:new.txt]]");
  });

  it.each([
    ["Reporter", "42", "42", "f".repeat(64), 403, "DRAFT_FORBIDDEN"],
    ["Developer", "99", "42", "f".repeat(64), 403, "DRAFT_FORBIDDEN"],
    ["Developer", "42", "42", "a".repeat(64), 409, "DRAFT_CHANGED_EXTERNALLY"],
  ] as const)("rejects selected replacement for role/owner/fingerprint policy %#", async (role, owner, actor, fingerprint, status, code) => {
    const files = path.join(root, "projects", projectId, "files");
    await mkdir(files);
    await writeFile(path.join(files, "old.txt"), "old", "utf8");
    const bytes = Buffer.from("new");
    const app = appFor(owner, actor, role);
    const response = await app.inject({ method: "POST", url: `/api/drafts/DRF-FILES/projects/${projectId}/files/old.txt/replace`, headers: uploadHeaders("new.txt", bytes, { "x-gitpm-expected-fingerprint": fingerprint }), payload: bytes });
    await app.close();
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ error: { code } });
    await expect(readFile(path.join(files, "old.txt"), "utf8")).resolves.toBe("old");
  });

  it("does not widen selected replacement to another Project", async () => {
    const otherFiles = path.join(root, "projects", otherProjectId, "files");
    await mkdir(otherFiles);
    await writeFile(path.join(otherFiles, "old.txt"), "other", "utf8");
    const bytes = Buffer.from("new");
    const app = appFor("42", "42", "Developer");
    const response = await app.inject({ method: "POST", url: `/api/drafts/DRF-FILES/projects/${projectId}/files/old.txt/replace`, headers: uploadHeaders("new.txt", bytes), payload: bytes });
    await app.close();
    expect(response.statusCode).toBe(404);
    await expect(readFile(path.join(otherFiles, "old.txt"), "utf8")).resolves.toBe("other");
  });

  it("requires exact new-name confirmation for a selected replacement above 50 MiB", async () => {
    const files = path.join(root, "projects", projectId, "files");
    await mkdir(files);
    await writeFile(path.join(files, "old.bin"), "old", "utf8");
    const app = appFor("42", "42", "Developer");
    const response = await app.inject({ method: "POST", url: `/api/drafts/DRF-FILES/projects/${projectId}/files/old.bin/replace`, headers: uploadHeaders("new.bin", Buffer.alloc(0), { "x-gitpm-upload-size": String(50 * 1024 * 1024 + 1) }), payload: Buffer.alloc(0) });
    await app.close();
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "PROJECT_FILE_LARGE_CONFIRMATION_REQUIRED" } });
    await expect(readFile(path.join(files, "old.bin"), "utf8")).resolves.toBe("old");
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

describe("Project files rename and delete API", () => {
  it("updates, keeps, restricts and unlinks references through explicit wire policies", async () => {
    const project = path.join(root, "projects", projectId);
    const files = path.join(project, "files");
    await mkdir(files, { recursive: true });
    await writeFile(path.join(files, "old.txt"), "bytes", "utf8");
    const projectFile = path.join(project, "project.yaml");
    await writeFile(projectFile, formatYamlDocument({ ...parseYamlDocument(await readFile(projectFile, "utf8")), description_markdown: "[[file:old.txt]]" }), "utf8");
    let app = appFor("42", "42", "Developer");
    const updated = await app.inject({ method: "POST", url: `/api/drafts/DRF-FILES/projects/${projectId}/files/old.txt/rename`, payload: { expected_fingerprint: "f".repeat(64), new_name: "new.txt", reference_mode: "update" } });
    await app.close();
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ references: { status: "checked", action: "updated", before_count: 1, affected_count: 1, remaining_count: 0 } });
    expect(await readFile(path.join(project, "project.yaml"), "utf8")).toContain("[[file:new.txt]]");

    app = appFor("42", "42", "Developer");
    const kept = await app.inject({ method: "POST", url: `/api/drafts/DRF-FILES/projects/${projectId}/files/new.txt/rename`, payload: { expected_fingerprint: "f".repeat(64), new_name: "kept.txt", reference_mode: "keep" } });
    await app.close();
    expect(kept.json()).toMatchObject({ references: { action: "kept", before_count: 1, affected_count: 0, remaining_count: 1 } });
    await writeFile(projectFile, formatYamlDocument({ ...parseYamlDocument(await readFile(projectFile, "utf8")), description_markdown: "[[file:kept.txt]]" }), "utf8");
    app = appFor("42", "42", "Developer");
    const restricted = await app.inject({ method: "DELETE", url: `/api/drafts/DRF-FILES/projects/${projectId}/files/kept.txt`, payload: { expected_fingerprint: "f".repeat(64), confirmation_name: "kept.txt", reference_mode: "restrict" } });
    expect(restricted.statusCode).toBe(409);
    expect(restricted.json()).toMatchObject({ error: { code: "PROJECT_FILE_DELETE_REFERENCED" } });
    const unlinked = await app.inject({ method: "DELETE", url: `/api/drafts/DRF-FILES/projects/${projectId}/files/kept.txt`, payload: { expected_fingerprint: "f".repeat(64), confirmation_name: "kept.txt", reference_mode: "unlink" } });
    await app.close();
    expect(unlinked.json()).toMatchObject({ references: { action: "unlinked", before_count: 1, affected_count: 1, remaining_count: 0 }, secure_erase: false });
    expect(await readFile(path.join(project, "project.yaml"), "utf8")).toContain("kept.txt");
  });
  it("returns 404 for rename and delete when the optional files directory is absent", async () => {
    const app = appFor("42", "42", "Developer");
    const rename = await app.inject({
      method: "POST",
      url: `/api/drafts/DRF-FILES/projects/${projectId}/files/missing.txt/rename`,
      payload: { expected_fingerprint: "f".repeat(64), new_name: "new.txt", reference_mode: "ignore_unchecked" },
    });
    const deletion = await app.inject({
      method: "DELETE",
      url: `/api/drafts/DRF-FILES/projects/${projectId}/files/missing.txt`,
      payload: { expected_fingerprint: "f".repeat(64), confirmation_name: "missing.txt", reference_mode: "ignore_unchecked" },
    });
    await app.close();
    expect(rename.statusCode).toBe(404);
    expect(rename.json()).toMatchObject({ error: { code: "PROJECT_FILE_NOT_FOUND" } });
    expect(deletion.statusCode).toBe(404);
    expect(deletion.json()).toMatchObject({ error: { code: "PROJECT_FILE_NOT_FOUND" } });
  });

  it("renames and deletes Unicode files with explicit reference and erase semantics", async () => {
    const files = path.join(root, "projects", projectId, "files");
    await mkdir(files);
    await writeFile(path.join(files, "ТЗ v3.docx"), "document", "utf8");
    const app = appFor("42", "42", "Developer");

    const renamed = await app.inject({
      method: "POST",
      url: `/api/drafts/DRF-FILES/projects/${projectId}/files/${encodeURIComponent("ТЗ v3.docx")}/rename`,
      payload: {
        expected_fingerprint: "f".repeat(64),
        new_name: "ТЗ v4.docx",
        reference_mode: "ignore_unchecked",
      },
    });
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/drafts/DRF-FILES/projects/${projectId}/files/${encodeURIComponent("ТЗ v4.docx")}`,
      payload: {
        expected_fingerprint: "e".repeat(64),
        confirmation_name: "ТЗ v4.docx",
        reference_mode: "ignore_unchecked",
      },
    });
    await app.close();

    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({
      operation: "renamed",
      previous_name: "ТЗ v3.docx",
      item: { name: "ТЗ v4.docx" },
      references: { status: "not_checked" },
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({
      project_id: projectId,
      operation: "deleted",
      name: "ТЗ v4.docx",
      path: `projects/${projectId}/files/ТЗ v4.docx`,
      size_bytes: 8,
      references: { status: "not_checked" },
      secure_erase: false,
      draft_fingerprint: "e".repeat(64),
    });
    await expect(readFile(path.join(files, "ТЗ v4.docx"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["read-only role", "42", "42", "Reporter", "ui", "f".repeat(64), 403, "DRAFT_FORBIDDEN"],
    ["another owner", "99", "42", "Developer", "ui", "f".repeat(64), 403, "DRAFT_FORBIDDEN"],
    ["external writer mode", "42", "42", "Developer", "external", "f".repeat(64), 409, "DRAFT_READ_ONLY"],
    ["stale fingerprint", "42", "42", "Maintainer", "ui", "a".repeat(64), 409, "DRAFT_CHANGED_EXTERNALLY"],
  ] as const)("rejects rename for %s", async (_label, owner, actor, role, writerMode, fingerprint, status, code) => {
    const files = path.join(root, "projects", projectId, "files");
    await mkdir(files);
    await writeFile(path.join(files, "blocked.txt"), "content", "utf8");
    const app = appFor(owner, actor, role, writerMode);
    const response = await app.inject({
      method: "POST",
      url: `/api/drafts/DRF-FILES/projects/${projectId}/files/blocked.txt/rename`,
      payload: { expected_fingerprint: fingerprint, new_name: "changed.txt", reference_mode: "ignore_unchecked" },
    });
    await app.close();
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ error: { code } });
    await expect(readFile(path.join(files, "blocked.txt"), "utf8")).resolves.toBe("content");
  });

  it("requires exact deletion confirmation and an explicitly unsupported reference mode", async () => {
    const files = path.join(root, "projects", projectId, "files");
    await mkdir(files);
    await writeFile(path.join(files, "Contract.pdf"), "content", "utf8");
    const app = appFor("42", "42", "Developer");
    const wrongConfirmation = await app.inject({
      method: "DELETE",
      url: `/api/drafts/DRF-FILES/projects/${projectId}/files/Contract.pdf`,
      payload: {
        expected_fingerprint: "f".repeat(64),
        confirmation_name: "contract.pdf",
        reference_mode: "ignore_unchecked",
      },
    });
    const unsupportedReferences = await app.inject({
      method: "POST",
      url: `/api/drafts/DRF-FILES/projects/${projectId}/files/Contract.pdf/rename`,
      payload: { expected_fingerprint: "f".repeat(64), new_name: "renamed.pdf", reference_mode: "future" },
    });
    await app.close();

    expect(wrongConfirmation.statusCode).toBe(409);
    expect(wrongConfirmation.json()).toMatchObject({ error: { code: "PROJECT_FILE_DELETE_CONFIRMATION_REQUIRED" } });
    expect(unsupportedReferences.statusCode).toBe(400);
    await expect(readFile(path.join(files, "Contract.pdf"), "utf8")).resolves.toBe("content");
  });

  it("does not expose the delete mutation to a read-only role", async () => {
    const files = path.join(root, "projects", projectId, "files");
    await mkdir(files);
    await writeFile(path.join(files, "readonly.txt"), "content", "utf8");
    const app = appFor("42", "42", "Reporter");
    const response = await app.inject({
      method: "DELETE",
      url: `/api/drafts/DRF-FILES/projects/${projectId}/files/readonly.txt`,
      payload: {
        expected_fingerprint: "f".repeat(64),
        confirmation_name: "readonly.txt",
        reference_mode: "ignore_unchecked",
      },
    });
    await app.close();
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "DRAFT_FORBIDDEN" } });
    await expect(readFile(path.join(files, "readonly.txt"), "utf8")).resolves.toBe("content");
  });

  it("requires reference_mode and rejects unknown mutation fields", async () => {
    const files = path.join(root, "projects", projectId, "files");
    await mkdir(files);
    await writeFile(path.join(files, "schema.txt"), "content", "utf8");
    const app = appFor("42", "42", "Developer");
    const missingMode = await app.inject({
      method: "POST",
      url: `/api/drafts/DRF-FILES/projects/${projectId}/files/schema.txt/rename`,
      payload: { expected_fingerprint: "f".repeat(64), new_name: "new.txt" },
    });
    const unknownField = await app.inject({
      method: "DELETE",
      url: `/api/drafts/DRF-FILES/projects/${projectId}/files/schema.txt`,
      payload: {
        expected_fingerprint: "f".repeat(64),
        confirmation_name: "schema.txt",
        reference_mode: "ignore_unchecked",
        secure_erase: true,
      },
    });
    await app.close();
    expect(missingMode.statusCode).toBe(400);
    expect(missingMode.json()).toMatchObject({ error: { code: "REQUEST_CONTRACT_INVALID" } });
    expect(unknownField.statusCode).toBe(400);
    expect(unknownField.json()).toMatchObject({ error: { code: "REQUEST_CONTRACT_INVALID" } });
    await expect(readFile(path.join(files, "schema.txt"), "utf8")).resolves.toBe("content");
  });

  it("returns stable missing, conflict and hostile-name errors without widening Project scope", async () => {
    const firstFiles = path.join(root, "projects", projectId, "files");
    const secondFiles = path.join(await addProject(otherProjectId), "files");
    await Promise.all([mkdir(firstFiles), mkdir(secondFiles)]);
    await writeFile(path.join(firstFiles, "Contract.pdf"), "first", "utf8");
    await writeFile(path.join(firstFiles, "spec.pdf"), "spec", "utf8");
    await writeFile(path.join(secondFiles, "Contract.pdf"), "second", "utf8");
    const app = appFor("42", "42", "Developer");
    const missing = await app.inject({
      method: "DELETE",
      url: `/api/drafts/DRF-FILES/projects/${projectId}/files/missing.pdf`,
      payload: { expected_fingerprint: "f".repeat(64), confirmation_name: "missing.pdf", reference_mode: "ignore_unchecked" },
    });
    const conflict = await app.inject({
      method: "POST",
      url: `/api/drafts/DRF-FILES/projects/${projectId}/files/Contract.pdf/rename`,
      payload: { expected_fingerprint: "f".repeat(64), new_name: "SPEC.pdf", reference_mode: "ignore_unchecked" },
    });
    const hostile = await app.inject({
      method: "POST",
      url: `/api/drafts/DRF-FILES/projects/${projectId}/files/Contract.pdf/rename`,
      payload: { expected_fingerprint: "f".repeat(64), new_name: "..\\escape.pdf", reference_mode: "ignore_unchecked" },
    });
    await app.close();

    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: "PROJECT_FILE_NOT_FOUND" } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: "PROJECT_FILE_NAME_CONFLICT" } });
    expect(hostile.statusCode).toBe(400);
    expect(hostile.json()).toMatchObject({ error: { code: "PROJECT_FILE_NAME_INVALID" } });
    await expect(readFile(path.join(secondFiles, "Contract.pdf"), "utf8")).resolves.toBe("second");
  });
});
