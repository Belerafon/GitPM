import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DraftManager, DraftMetadata, RepositoryWorkspace } from "@gitpm/drafts";
import { ProjectFileStore } from "@gitpm/domain";
import { buildApp } from "./app.js";

const projectId = "P-26-MGP84K";
const otherProjectId = "P-26-8S9HQQ";
let root: string;

function manager(owner = "42"): DraftManager {
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
    writer_mode: "ui",
    state: "open",
    fingerprint: workspace.fingerprint,
    created_at: workspace.created_at,
    updated_at: workspace.updated_at,
  };
  return {
    repositoryMode: "worktree",
    getDraft: async () => draft,
    getWorkspace: async () => workspace,
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
  await addProject(projectId);
});

afterEach(async () => rm(root, { recursive: true, force: true }));

function appFor(owner = "42", actor = "42") {
  const drafts = manager(owner);
  return buildApp({
    authenticate: () => ({ userId: actor, role: "Reporter" }),
    draftManager: drafts,
    projectFileStore: new ProjectFileStore(drafts),
  });
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
    const absentProject = await app.inject({ method: "GET", url: `/api/drafts/DRF-FILES/projects/${otherProjectId}/files` });
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
