import { Readable } from "node:stream";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DraftRuntimeError, type DraftManager, type DraftMetadata, type RepositoryWorkspace } from "@gitpm/drafts";
import { PROJECT_FILE_LARGE_THRESHOLD_BYTES, ProjectFileOperationError, ProjectFileStore, projectFilePresentation, type ProjectFileStoreOptions } from "./project-files.js";

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

async function uploadFixture(options: ProjectFileStoreOptions = {}): Promise<{ root: string; store: ProjectFileStore; metadata: DraftMetadata }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gitpm-project-files-upload-"));
  roots.push(root);
  await cp(path.join(process.cwd(), "fixtures", "schema-v1", "demo"), root, { recursive: true });
  const metadata: DraftMetadata = {
    version: 1,
    draft_id: "DRF-FILES",
    owner_gitlab_user_id: "42",
    branch: "draft/files",
    base_commit: "a".repeat(40),
    worktree_path: root,
    writer_mode: "ui",
    state: "open",
    fingerprint: "f".repeat(64),
    created_at: "2026-08-13T10:00:00.000Z",
    updated_at: "2026-08-13T10:00:00.000Z",
  };
  const drafts = {
    getWorkspace: async () => ({
      workspace_id: metadata.draft_id,
      owner_id: metadata.owner_gitlab_user_id,
      branch: metadata.branch,
      base_commit: metadata.base_commit,
      worktree_path: metadata.worktree_path,
      fingerprint: metadata.fingerprint,
      created_at: metadata.created_at,
      updated_at: metadata.updated_at,
    }),
    withUiMutation: async (_draftId: string, owner: string, expected: string, mutation: (value: DraftMetadata) => Promise<unknown>) => {
      if (owner !== metadata.owner_gitlab_user_id) throw new DraftRuntimeError("DRAFT_FORBIDDEN", "Draft owner mismatch");
      if (metadata.writer_mode !== "ui") throw new DraftRuntimeError("DRAFT_READ_ONLY", "UI is read-only in external writer mode");
      if (expected !== metadata.fingerprint) throw new DraftRuntimeError("DRAFT_CHANGED_EXTERNALLY", "Draft changed externally");
      const result = await mutation(metadata);
      const next = { ...metadata, fingerprint: "e".repeat(64) };
      Object.assign(metadata, next);
      return { result, metadata: next };
    },
  } as unknown as DraftManager;
  return { root, store: new ProjectFileStore(drafts, options), metadata };
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

describe("ProjectFileStore upload", () => {
  it("streams a Unicode file, including zero-byte content, and requires explicit replace", async () => {
    const { root, store } = await uploadFixture();
    const name = "ТЗ v4.docx";
    const created = await store.upload("DRF-FILES", "42", firstProject, "f".repeat(64), {
      name,
      sizeBytes: 0,
      mode: "create",
      content: Readable.from([]),
    });
    expect(created).toMatchObject({ project_id: firstProject, operation: "created", item: { name, size_bytes: 0 }, draft_fingerprint: "e".repeat(64) });
    await expect(readFile(path.join(root, "projects", firstProject, "files", name))).resolves.toEqual(Buffer.alloc(0));

    await expect(store.upload("DRF-FILES", "42", firstProject, "e".repeat(64), {
      name,
      sizeBytes: 3,
      mode: "create",
      content: Readable.from([Buffer.from("new")]),
    })).rejects.toMatchObject({ code: "PROJECT_FILE_EXISTS" });

    const replaced = await store.upload("DRF-FILES", "42", firstProject, "e".repeat(64), {
      name,
      sizeBytes: 3,
      mode: "replace",
      content: Readable.from([Buffer.from("new")]),
    });
    expect(replaced.operation).toBe("replaced");
    await expect(readFile(path.join(root, "projects", firstProject, "files", name), "utf8")).resolves.toBe("new");
  });

  it("rejects hostile names and case-insensitive conflicts without consuming another Project", async () => {
    const { root, store } = await uploadFixture();
    const directory = path.join(root, "projects", firstProject, "files");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "Contract.pdf"), "old", "utf8");
    await expect(store.upload("DRF-FILES", "42", firstProject, "f".repeat(64), {
      name: "contract.pdf", sizeBytes: 3, mode: "create", content: Readable.from([Buffer.from("new")]),
    })).rejects.toMatchObject({ code: "PROJECT_FILE_NAME_CONFLICT" });
    await expect(store.upload("DRF-FILES", "42", firstProject, "f".repeat(64), {
      name: "..\\secret.txt", sizeBytes: 0, mode: "create", content: Readable.from([]),
    })).rejects.toMatchObject({ code: "PROJECT_FILE_NAME_INVALID" });
    await expect(readFile(path.join(root, "projects", secondProject, "project.yaml"), "utf8")).resolves.toContain(secondProject);
  });

  it("cleans partial streams and size mismatches without publishing temp files", async () => {
    const { root, store } = await uploadFixture();
    const content = Readable.from((async function* () {
      yield Buffer.from("part");
      throw new Error("transport interrupted");
    })());
    await expect(store.upload("DRF-FILES", "42", firstProject, "f".repeat(64), {
      name: "partial.bin", sizeBytes: 8, mode: "create", content,
    })).rejects.toThrow("transport interrupted");
    await expect(store.upload("DRF-FILES", "42", firstProject, "f".repeat(64), {
      name: "wrong.bin", sizeBytes: 2, mode: "create", content: Readable.from([Buffer.from("three")]),
    })).rejects.toMatchObject({ code: "PROJECT_FILE_UPLOAD_SIZE_MISMATCH" });
    const directory = path.join(root, "projects", firstProject, "files");
    const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    expect(names).not.toContain("partial.bin");
    expect(names).not.toContain("wrong.bin");
    expect(names.some((name) => name.startsWith(".gitpm-project-file-"))).toBe(false);
  });

  it("rolls back create and replace when full repository validation fails", async () => {
    const { root, store } = await uploadFixture();
    const directory = path.join(root, "projects", firstProject, "files");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "existing.txt"), "old", "utf8");
    await writeFile(path.join(root, ".gitpm", "statuses.yaml"), "invalid: [", "utf8");

    await expect(store.upload("DRF-FILES", "42", firstProject, "f".repeat(64), {
      name: "new.txt", sizeBytes: 3, mode: "create", content: Readable.from([Buffer.from("new")]),
    })).rejects.toMatchObject({ code: "PROJECT_FILE_VALIDATION_FAILED" });
    await expect(readFile(path.join(directory, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });

    await expect(store.upload("DRF-FILES", "42", firstProject, "f".repeat(64), {
      name: "existing.txt", sizeBytes: 3, mode: "replace", content: Readable.from([Buffer.from("new")]),
    })).rejects.toMatchObject({ code: "PROJECT_FILE_VALIDATION_FAILED" });
    await expect(readFile(path.join(directory, "existing.txt"), "utf8")).resolves.toBe("old");
    expect((await readdir(directory)).some((name) => name.startsWith(".gitpm-project-file-"))).toBe(false);
  });

  it("requires the exact name above 50 MiB while keeping the threshold distinct from the hard limit", async () => {
    const { root, store } = await uploadFixture();
    const name = "large.bin";
    const sizeBytes = PROJECT_FILE_LARGE_THRESHOLD_BYTES + 1;
    await expect(store.upload("DRF-FILES", "42", firstProject, "f".repeat(64), {
      name, sizeBytes, mode: "create", content: Readable.from([]),
    })).rejects.toMatchObject({ code: "PROJECT_FILE_LARGE_CONFIRMATION_REQUIRED" });
    await expect(store.upload("DRF-FILES", "42", firstProject, "f".repeat(64), {
      name, sizeBytes, mode: "create", largeFileConfirmation: "Large.bin", content: Readable.from([]),
    })).rejects.toMatchObject({ code: "PROJECT_FILE_LARGE_CONFIRMATION_REQUIRED" });
    const created = await store.upload("DRF-FILES", "42", firstProject, "f".repeat(64), {
      name,
      sizeBytes,
      mode: "create",
      largeFileConfirmation: name,
      content: Readable.from([Buffer.alloc(sizeBytes)]),
    });
    expect(created.item.size_bytes).toBe(sizeBytes);
    await expect(readFile(path.join(root, "projects", firstProject, "files", name))).resolves.toHaveLength(sizeBytes);

    const limited = await uploadFixture({ maxUploadBytes: 2 });
    await expect(limited.store.upload("DRF-FILES", "42", firstProject, "f".repeat(64), {
      name: "three.bin", sizeBytes: 3, mode: "create", content: Readable.from([Buffer.from("123")]),
    })).rejects.toMatchObject({ code: "PROJECT_FILE_TOO_LARGE" });
  });

  it("detects a target TOCTOU change and rejects symlink storage", async () => {
    let target = "";
    const raced = await uploadFixture({ beforeFinalizeForTest: async () => { await writeFile(target, "external", "utf8"); } });
    target = path.join(raced.root, "projects", firstProject, "files", "race.txt");
    await expect(raced.store.upload("DRF-FILES", "42", firstProject, "f".repeat(64), {
      name: "race.txt", sizeBytes: 3, mode: "create", content: Readable.from([Buffer.from("new")]),
    })).rejects.toMatchObject({ code: "PROJECT_FILE_CHANGED_EXTERNALLY" });
    await expect(readFile(target, "utf8")).resolves.toBe("external");

    const linked = await uploadFixture();
    const outside = path.join(linked.root, "outside");
    await mkdir(outside);
    await symlink(outside, path.join(linked.root, "projects", firstProject, "files"), process.platform === "win32" ? "junction" : "dir");
    await expect(linked.store.upload("DRF-FILES", "42", firstProject, "f".repeat(64), {
      name: "escape.txt", sizeBytes: 0, mode: "create", content: Readable.from([]),
    })).rejects.toMatchObject({ code: "PROJECT_FILE_PATH_FORBIDDEN" });
  });

  it("does not delete a foreign file that replaces its random staging entry", async () => {
    let files = "";
    let foreign = "";
    const raced = await uploadFixture({
      beforeFinalizeForTest: async () => {
        const temporary = (await readdir(files)).find((name) => name.endsWith(".tmp"));
        if (temporary === undefined) throw new Error("expected upload staging file");
        foreign = path.join(files, temporary);
        await rm(foreign);
        await writeFile(foreign, "foreign", "utf8");
      },
    });
    files = path.join(raced.root, "projects", firstProject, "files");
    await expect(raced.store.upload("DRF-FILES", "42", firstProject, "f".repeat(64), {
      name: "race.bin", sizeBytes: 3, mode: "create", content: Readable.from([Buffer.from("new")]),
    })).rejects.toMatchObject({ code: "PROJECT_FILE_CHANGED_EXTERNALLY" });
    await expect(readFile(foreign, "utf8")).resolves.toBe("foreign");
    await expect(readFile(path.join(files, "race.bin"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("ProjectFileStore rename and delete", () => {
  it("renames Unicode files and performs a portable case-only rename", async () => {
    const { root, store } = await uploadFixture();
    const directory = path.join(root, "projects", firstProject, "files");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "ТЗ v3.docx"), "content", "utf8");

    const renamed = await store.rename(
      "DRF-FILES",
      "42",
      firstProject,
      "ТЗ v3.docx",
      "f".repeat(64),
      "ТЗ v4.docx",
      "ignore_unchecked",
    );
    expect(renamed).toMatchObject({
      project_id: firstProject,
      operation: "renamed",
      previous_name: "ТЗ v3.docx",
      item: { name: "ТЗ v4.docx", size_bytes: 7 },
      references: { status: "not_checked" },
      draft_fingerprint: "e".repeat(64),
    });
    await expect(readFile(path.join(directory, "ТЗ v3.docx"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(directory, "ТЗ v4.docx"), "utf8")).resolves.toBe("content");

    const caseOnly = await store.rename(
      "DRF-FILES",
      "42",
      firstProject,
      "ТЗ v4.docx",
      "e".repeat(64),
      "ТЗ V4.docx",
      "ignore_unchecked",
    );
    expect(caseOnly.item.name).toBe("ТЗ V4.docx");
    expect(await readdir(directory)).toContain("ТЗ V4.docx");
    await expect(readFile(path.join(directory, "ТЗ V4.docx"), "utf8")).resolves.toBe("content");
    expect((await readdir(directory)).some((entry) => entry.startsWith(".gitpm-project-file-"))).toBe(false);
  });

  it("deletes a Unicode file from the current Git version without promising secure erase", async () => {
    const { root, store } = await uploadFixture();
    const directory = path.join(root, "projects", firstProject, "files");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "Договор.pdf"), "contract", "utf8");

    const deleted = await store.delete(
      "DRF-FILES",
      "42",
      firstProject,
      "Договор.pdf",
      "f".repeat(64),
      "Договор.pdf",
      "ignore_unchecked",
    );

    expect(deleted).toEqual({
      project_id: firstProject,
      operation: "deleted",
      name: "Договор.pdf",
      path: `projects/${firstProject}/files/Договор.pdf`,
      size_bytes: 8,
      references: { status: "not_checked" },
      secure_erase: false,
      draft_fingerprint: "e".repeat(64),
    });
    await expect(readFile(path.join(directory, "Договор.pdf"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects missing, unchanged, hostile, conflicting and unchecked-reference inputs", async () => {
    const absent = await uploadFixture();
    await expect(absent.store.rename(
      "DRF-FILES", "42", firstProject, "missing.pdf", "f".repeat(64), "new.pdf", "ignore_unchecked",
    )).rejects.toMatchObject({ code: "PROJECT_FILE_NOT_FOUND" });
    await expect(absent.store.delete(
      "DRF-FILES", "42", firstProject, "missing.pdf", "f".repeat(64), "missing.pdf", "ignore_unchecked",
    )).rejects.toMatchObject({ code: "PROJECT_FILE_NOT_FOUND" });

    const { root, store } = await uploadFixture();
    const directory = path.join(root, "projects", firstProject, "files");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "Contract.pdf"), "one", "utf8");
    await writeFile(path.join(directory, "spec.pdf"), "two", "utf8");

    await expect(store.rename(
      "DRF-FILES", "42", firstProject, "missing.pdf", "f".repeat(64), "new.pdf", "ignore_unchecked",
    )).rejects.toMatchObject({ code: "PROJECT_FILE_NOT_FOUND" });
    await expect(store.rename(
      "DRF-FILES", "42", firstProject, "contract.pdf", "f".repeat(64), "new.pdf", "ignore_unchecked",
    )).rejects.toMatchObject({ code: "PROJECT_FILE_NOT_FOUND" });
    await expect(store.rename(
      "DRF-FILES", "42", firstProject, "Contract.pdf", "f".repeat(64), "Contract.pdf", "ignore_unchecked",
    )).rejects.toMatchObject({ code: "PROJECT_FILE_RENAME_NO_CHANGE" });
    await expect(store.rename(
      "DRF-FILES", "42", firstProject, "Contract.pdf", "f".repeat(64), "SPEC.pdf", "ignore_unchecked",
    )).rejects.toMatchObject({ code: "PROJECT_FILE_NAME_CONFLICT" });
    await expect(store.rename(
      "DRF-FILES", "42", firstProject, "Contract.pdf", "f".repeat(64), "..\\escape.pdf", "ignore_unchecked",
    )).rejects.toMatchObject({ code: "PROJECT_FILE_NAME_INVALID" });
    await expect(store.rename(
      "DRF-FILES", "42", firstProject, "Contract.pdf", "f".repeat(64), "new.pdf", "update" as "ignore_unchecked",
    )).rejects.toMatchObject({ code: "PROJECT_FILE_REFERENCES_UNSUPPORTED" });
    await expect(store.delete(
      "DRF-FILES", "42", firstProject, "Contract.pdf", "f".repeat(64), "contract.pdf", "ignore_unchecked",
    )).rejects.toMatchObject({ code: "PROJECT_FILE_DELETE_CONFIRMATION_REQUIRED" });
    await expect(readFile(path.join(directory, "Contract.pdf"), "utf8")).resolves.toBe("one");
  });

  it("keeps Project scope and rejects symlinks and non-regular entries", async () => {
    const { root, store } = await uploadFixture();
    const firstFiles = path.join(root, "projects", firstProject, "files");
    const secondFiles = path.join(root, "projects", secondProject, "files");
    await Promise.all([mkdir(firstFiles, { recursive: true }), mkdir(secondFiles, { recursive: true })]);
    await writeFile(path.join(firstFiles, "same.txt"), "first", "utf8");
    await writeFile(path.join(secondFiles, "same.txt"), "second", "utf8");
    await mkdir(path.join(firstFiles, "folder"));
    await expect(store.delete(
      "DRF-FILES", "42", firstProject, "folder", "f".repeat(64), "folder", "ignore_unchecked",
    )).rejects.toMatchObject({ code: "PROJECT_FILE_NOT_REGULAR" });
    await expect(store.delete(
      "DRF-FILES", "42", firstProject, "same.txt", "f".repeat(64), "same.txt", "ignore_unchecked",
    )).rejects.toMatchObject({ code: "PROJECT_FILES_LAYOUT_INVALID" });
    await rm(firstFiles, { recursive: true });
    await symlink(secondFiles, firstFiles, process.platform === "win32" ? "junction" : "dir");
    await expect(store.rename(
      "DRF-FILES", "42", firstProject, "same.txt", "f".repeat(64), "renamed.txt", "ignore_unchecked",
    )).rejects.toMatchObject({ code: "PROJECT_FILE_PATH_FORBIDDEN" });
    await expect(readFile(path.join(secondFiles, "same.txt"), "utf8")).resolves.toBe("second");
  });

  it("detects external source races without deleting the external replacement", async () => {
    let renameTarget = "";
    const renameRace = await uploadFixture({
      beforeRenameForTest: async () => {
        await rm(renameTarget);
        await writeFile(renameTarget, "external rename", "utf8");
      },
    });
    renameTarget = path.join(renameRace.root, "projects", firstProject, "files", "race.txt");
    await mkdir(path.dirname(renameTarget), { recursive: true });
    await writeFile(renameTarget, "original", "utf8");
    await expect(renameRace.store.rename(
      "DRF-FILES", "42", firstProject, "race.txt", "f".repeat(64), "renamed.txt", "ignore_unchecked",
    )).rejects.toMatchObject({ code: "PROJECT_FILE_CHANGED_EXTERNALLY" });
    await expect(readFile(renameTarget, "utf8")).resolves.toBe("external rename");

    let deleteTarget = "";
    const deleteRace = await uploadFixture({
      beforeDeleteForTest: async () => {
        await rm(deleteTarget);
        await writeFile(deleteTarget, "external delete", "utf8");
      },
    });
    deleteTarget = path.join(deleteRace.root, "projects", firstProject, "files", "race.txt");
    await mkdir(path.dirname(deleteTarget), { recursive: true });
    await writeFile(deleteTarget, "original", "utf8");
    await expect(deleteRace.store.delete(
      "DRF-FILES", "42", firstProject, "race.txt", "f".repeat(64), "race.txt", "ignore_unchecked",
    )).rejects.toMatchObject({ code: "PROJECT_FILE_CHANGED_EXTERNALLY" });
    await expect(readFile(deleteTarget, "utf8")).resolves.toBe("external delete");
  });

  it("rolls rename and delete back after full repository validation failure", async () => {
    const renameFixture = await uploadFixture({
      beforeValidationForTest: async (operation) => {
        if (operation === "rename") {
          await writeFile(path.join(renameFixture.root, ".gitpm", "statuses.yaml"), "invalid: [", "utf8");
        }
      },
    });
    const renameFiles = path.join(renameFixture.root, "projects", firstProject, "files");
    await mkdir(renameFiles, { recursive: true });
    await writeFile(path.join(renameFiles, "old.txt"), "original rename", "utf8");
    await expect(renameFixture.store.rename(
      "DRF-FILES", "42", firstProject, "old.txt", "f".repeat(64), "new.txt", "ignore_unchecked",
    )).rejects.toMatchObject({ code: "PROJECT_FILE_VALIDATION_FAILED" });
    await expect(readFile(path.join(renameFiles, "old.txt"), "utf8")).resolves.toBe("original rename");
    await expect(readFile(path.join(renameFiles, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(renameFiles)).some((entry) => entry.startsWith(".gitpm-project-file-"))).toBe(false);

    const deleteFixture = await uploadFixture({
      beforeValidationForTest: async (operation) => {
        if (operation === "delete") {
          await writeFile(
            path.join(deleteFixture.root, "projects", firstProject, "files", "external-neighbor.txt"),
            "external neighbor",
            "utf8",
          );
          await writeFile(path.join(deleteFixture.root, ".gitpm", "statuses.yaml"), "invalid: [", "utf8");
        }
      },
    });
    const deleteFiles = path.join(deleteFixture.root, "projects", firstProject, "files");
    await mkdir(deleteFiles, { recursive: true });
    await writeFile(path.join(deleteFiles, "delete.txt"), "original delete", "utf8");
    await expect(deleteFixture.store.delete(
      "DRF-FILES", "42", firstProject, "delete.txt", "f".repeat(64), "delete.txt", "ignore_unchecked",
    )).rejects.toMatchObject({ code: "PROJECT_FILE_VALIDATION_FAILED" });
    await expect(readFile(path.join(deleteFiles, "delete.txt"), "utf8")).resolves.toBe("original delete");
    await expect(readFile(path.join(deleteFiles, "external-neighbor.txt"), "utf8")).resolves.toBe("external neighbor");
    expect((await readdir(deleteFiles)).some((entry) => entry.startsWith(".gitpm-project-file-"))).toBe(false);
  });

  it("reports rollback failure and preserves an external file that occupies a deleted name", async () => {
    let target = "";
    const raced = await uploadFixture({
      beforeValidationForTest: async (operation) => {
        if (operation === "delete") await writeFile(target, "external", "utf8");
      },
    });
    target = path.join(raced.root, "projects", firstProject, "files", "occupied.txt");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "original", "utf8");
    await expect(raced.store.delete(
      "DRF-FILES", "42", firstProject, "occupied.txt", "f".repeat(64), "occupied.txt", "ignore_unchecked",
    )).rejects.toMatchObject({ code: "PROJECT_FILE_ROLLBACK_FAILED" });
    await expect(readFile(target, "utf8")).resolves.toBe("external");
    const recovery = (await readdir(path.dirname(target))).find((entry) => entry.endsWith(".delete"));
    expect(recovery).toBeDefined();
    await expect(readFile(path.join(path.dirname(target), recovery!), "utf8")).resolves.toBe("original");
  });

  it("preserves rename recovery content when an external file occupies the original name", async () => {
    let source = "";
    const raced = await uploadFixture({
      beforeValidationForTest: async (operation) => {
        if (operation === "rename") await writeFile(source, "external", "utf8");
      },
    });
    const files = path.join(raced.root, "projects", firstProject, "files");
    source = path.join(files, "original.txt");
    await mkdir(files, { recursive: true });
    await writeFile(source, "original content", "utf8");
    await expect(raced.store.rename(
      "DRF-FILES", "42", firstProject, "original.txt", "f".repeat(64), "new.txt", "ignore_unchecked",
    )).rejects.toMatchObject({ code: "PROJECT_FILE_ROLLBACK_FAILED" });
    await expect(readFile(source, "utf8")).resolves.toBe("external");
    await expect(readFile(path.join(files, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    const recovery = (await readdir(files)).find((entry) => entry.endsWith(".rename"));
    expect(recovery).toBeDefined();
    await expect(readFile(path.join(files, recovery!), "utf8")).resolves.toBe("original content");
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
