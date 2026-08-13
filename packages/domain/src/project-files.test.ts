import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DraftManager, RepositoryWorkspace } from "@gitpm/drafts";
import { ProjectFileOperationError, ProjectFileStore, projectFilePresentation } from "./project-files.js";

const roots: string[] = [];
const firstProject = "P-26-MGP84K";
const secondProject = "P-26-8S9HQQ";

async function fixture(projectIds: readonly string[] = [firstProject]): Promise<{ root: string; store: ProjectFileStore }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gitpm-project-files-domain-"));
  roots.push(root);
  for (const projectId of projectIds) {
    const project = path.join(root, "projects", projectId);
    await mkdir(project, { recursive: true });
    await writeFile(path.join(project, "project.yaml"), `schema: gitpm/project@2\nid: ${projectId}\n`, "utf8");
  }
  const workspace: RepositoryWorkspace = {
    workspace_id: "DRF-FILES",
    owner_id: "42",
    branch: "draft/files",
    base_commit: "a".repeat(40),
    worktree_path: root,
    fingerprint: "f".repeat(64),
    created_at: "2026-08-13T10:00:00.000Z",
    updated_at: "2026-08-13T10:00:00.000Z",
  };
  const drafts = { getWorkspace: async () => workspace } as unknown as DraftManager;
  return { root, store: new ProjectFileStore(drafts) };
}

afterEach(async () => Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true }))));

describe("ProjectFileStore", () => {
  it("returns an empty aggregate when the optional directory is absent", async () => {
    const { store } = await fixture();
    await expect(store.list("DRF-FILES", firstProject)).resolves.toEqual({
      project_id: firstProject,
      count: 0,
      total_size_bytes: 0,
      items: [],
      draft_fingerprint: "f".repeat(64),
    });
  });

  it("lists Unicode files with sizes, working-copy timestamps and safe presentation metadata", async () => {
    const { root, store } = await fixture();
    const directory = path.join(root, "projects", firstProject, "files");
    await mkdir(directory);
    await writeFile(path.join(directory, "ТЗ v3.pdf"), "pdf", "utf8");
    await writeFile(path.join(directory, "Смета.xlsx"), "table", "utf8");

    const result = await store.list("DRF-FILES", firstProject);

    expect(result).toMatchObject({ project_id: firstProject, count: 2, total_size_bytes: 8 });
    expect(result.items).toEqual([
      expect.objectContaining({ name: "Смета.xlsx", size_bytes: 5, media_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", disposition: "attachment", modified_at_source: "working_copy_filesystem" }),
      expect.objectContaining({ name: "ТЗ v3.pdf", size_bytes: 3, media_type: "application/pdf", disposition: "inline", modified_at_source: "working_copy_filesystem" }),
    ]);
    expect(result.items.every((item) => !path.isAbsolute(item.path))).toBe(true);
  });

  it("opens only the requested Project file and reports a missing file", async () => {
    const { root, store } = await fixture([firstProject, secondProject]);
    for (const [projectId, content] of [[firstProject, "first"], [secondProject, "second"]] as const) {
      const directory = path.join(root, "projects", projectId, "files");
      await mkdir(directory);
      await writeFile(path.join(directory, "contract.txt"), content, "utf8");
    }

    const opened = await store.open("DRF-FILES", firstProject, "contract.txt");
    try {
      expect((await opened.handle.readFile("utf8"))).toBe("first");
      expect(opened.item.path).toBe(`projects/${firstProject}/files/contract.txt`);
    } finally {
      await opened.handle.close();
    }
    await expect(store.open("DRF-FILES", firstProject, "missing.txt"))
      .rejects.toMatchObject({ code: "PROJECT_FILE_NOT_FOUND" });
  });

  it.each(["../secret.txt", "folder/secret.txt", "folder\\secret.txt", "..", "bad:name.txt"])(
    "rejects hostile file name %s before resolving a path",
    async (name) => {
      const { store } = await fixture();
      await expect(store.open("DRF-FILES", firstProject, name))
        .rejects.toMatchObject({ code: "PROJECT_FILE_NAME_INVALID" });
    },
  );

  it("rejects a symbolic-link boundary and does not follow it", async () => {
    const { root, store } = await fixture();
    const outside = await mkdtemp(path.join(os.tmpdir(), "gitpm-project-files-outside-"));
    roots.push(outside);
    await writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
    const directory = path.join(root, "projects", firstProject, "files");
    await symlink(outside, directory, process.platform === "win32" ? "junction" : "dir");

    await expect(store.list("DRF-FILES", firstProject))
      .rejects.toMatchObject({ code: "PROJECT_FILE_PATH_FORBIDDEN" });
    await expect(store.open("DRF-FILES", firstProject, "secret.txt"))
      .rejects.toMatchObject({ code: "PROJECT_FILE_PATH_FORBIDDEN" });
  });

  it("rejects an invalid or absent Project without widening scope", async () => {
    const { store } = await fixture();
    await expect(store.list("DRF-FILES", "P-invalid"))
      .rejects.toMatchObject({ code: "ENTITY_PROJECT_INVALID" });
    await expect(store.list("DRF-FILES", secondProject))
      .rejects.toMatchObject({ code: "ENTITY_NOT_FOUND" });
  });
});

describe("projectFilePresentation", () => {
  it("allows inline only for passive browser-viewable formats", () => {
    expect(projectFilePresentation("scan.JPEG")).toEqual({ media_type: "image/jpeg", disposition: "inline" });
    expect(projectFilePresentation("notes.txt")).toEqual({ media_type: "text/plain; charset=utf-8", disposition: "inline" });
    expect(projectFilePresentation("diagram.svg")).toEqual({ media_type: "application/octet-stream", disposition: "attachment" });
    expect(projectFilePresentation("page.html")).toEqual({ media_type: "application/octet-stream", disposition: "attachment" });
    expect(projectFilePresentation("macro.xlsm")).toEqual({ media_type: "application/octet-stream", disposition: "attachment" });
  });
});

it("uses a dedicated domain error type", () => {
  expect(new ProjectFileOperationError("CODE", "message")).toMatchObject({ name: "ProjectFileOperationError", code: "CODE" });
});
