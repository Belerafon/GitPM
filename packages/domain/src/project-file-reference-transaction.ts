import { randomUUID } from "node:crypto";
import { type Stats } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import type {
  ProjectFileReferenceLocation,
  ProjectFileReferencePreview,
  ProjectFileReferencesChecked,
} from "@gitpm/contracts";
import { formatYamlDocument, parseYamlDocument, referenceLabelsForDocuments, type GitPmDocument } from "@gitpm/repository-format";
import { atomicWriteDomainFile, resolveDomainPath } from "@gitpm/security";
import { discoverRepositoryFiles } from "@gitpm/validation";
import { ProjectFileOperationError } from "./project-file-operation-error.js";
import { searchProjectFileReferences } from "./project-file-reference-search.js";

export interface ProjectFileWorkspace {
  readonly worktree_path: string;
  readonly fingerprint: string;
}

export interface ProjectFileReferenceTransactionHooks {
  readonly beforeReferenceWriteForTest?: () => Promise<void>;
  readonly afterReferenceWriteForTest?: () => Promise<void>;
  readonly beforeReferenceRecoveryWriteForTest?: () => Promise<void>;
}

interface LoadedDocument {
  readonly absolute: string;
  readonly relative: string;
  readonly original: string;
  readonly identity: Stats;
  readonly document: GitPmDocument;
}

export interface ProjectFileReferenceJournalEntry {
  readonly relative: string;
  readonly original: string;
  readonly written: string;
  readonly identity: Stats;
}

export interface CheckedProjectFileReferences {
  readonly documents: readonly LoadedDocument[];
  readonly preview: Omit<ProjectFileReferencePreview, "draft_fingerprint">;
}

export interface ProjectFileReferenceMutation {
  readonly references: ProjectFileReferencesChecked;
  readonly journal: readonly ProjectFileReferenceJournalEntry[];
}

function normalize(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function sameIdentity(
  left: { readonly dev: number; readonly ino: number },
  right: { readonly dev: number; readonly ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function loadRepositoryDocuments(root: string): Promise<readonly LoadedDocument[]> {
  const discovery = await discoverRepositoryFiles(root);
  if (discovery.issues.length > 0) {
    const issue = discovery.issues[0]!;
    throw new ProjectFileOperationError(issue.code, issue.message);
  }
  return await Promise.all(discovery.files.map(async (absolute) => {
    const relative = normalize(path.relative(root, absolute));
    const identity = await lstat(absolute);
    if (identity.isSymbolicLink() || !identity.isFile()) {
      throw new ProjectFileOperationError("PROJECT_FILE_REFERENCES_CHANGED", "Repository document is not a regular file");
    }
    const original = await readFile(absolute, "utf8");
    const after = await lstat(absolute);
    if (!sameIdentity(identity, after)) {
      throw new ProjectFileOperationError("PROJECT_FILE_REFERENCES_CHANGED", "Repository document changed while references were loaded");
    }
    return { absolute, relative, original, identity: after, document: parseYamlDocument(original, relative) };
  }));
}

function replaceAtOffsets(source: string, locations: readonly ProjectFileReferenceLocation[], replacement: string): string {
  let result = source;
  for (const location of [...locations].sort((left, right) => right.start - left.start || right.end - left.end)) {
    result = `${result.slice(0, location.start)}${replacement}${result.slice(location.end)}`;
  }
  return result;
}

function rewriteDocument(
  document: GitPmDocument,
  locations: readonly ProjectFileReferenceLocation[],
  replacement: string,
): GitPmDocument {
  const next = { ...document } as Record<string, unknown>;
  const byField = new Map<string, ProjectFileReferenceLocation[]>();
  for (const location of locations) {
    const key = `${location.field}:${location.value_index ?? ""}`;
    const entries = byField.get(key) ?? [];
    entries.push(location);
    byField.set(key, entries);
  }
  for (const entries of byField.values()) {
    const first = entries[0]!;
    if (first.field === "acceptance_criteria_markdown") {
      const values = Array.isArray(next[first.field]) ? [...next[first.field] as unknown[]] : [];
      const index = first.value_index;
      if (index === undefined || typeof values[index] !== "string") {
        throw new ProjectFileOperationError("PROJECT_FILE_REFERENCES_CHANGED", "Project file reference field changed during mutation");
      }
      values[index] = replaceAtOffsets(values[index] as string, entries, replacement);
      next[first.field] = values;
    } else {
      const value = next[first.field];
      if (typeof value !== "string") {
        throw new ProjectFileOperationError("PROJECT_FILE_REFERENCES_CHANGED", "Project file reference field changed during mutation");
      }
      next[first.field] = replaceAtOffsets(value, entries, replacement);
    }
  }
  return next as GitPmDocument;
}

export class ProjectFileReferenceTransaction {
  constructor(private readonly hooks: ProjectFileReferenceTransactionHooks = {}) {}

  async check(workspace: ProjectFileWorkspace, projectId: string, fileName: string): Promise<CheckedProjectFileReferences> {
    const documents = await loadRepositoryDocuments(workspace.worktree_path);
    const found = searchProjectFileReferences({ projectId, fileName, documents: documents.map((item) => item.document) });
    return {
      documents,
      preview: { project_id: projectId, file_name: fileName, status: "checked", count: found.count, locations: found.locations },
    };
  }

  async write(
    workspace: ProjectFileWorkspace,
    projectId: string,
    fileName: string,
    replacement: string,
    action: "updated" | "unlinked",
    loaded?: CheckedProjectFileReferences,
  ): Promise<ProjectFileReferenceMutation> {
    const checked = loaded ?? await this.check(workspace, projectId, fileName);
    const locationsByPath = new Map<string, ProjectFileReferenceLocation[]>();
    for (const location of checked.preview.locations) {
      const entries = locationsByPath.get(location.path) ?? [];
      entries.push(location);
      locationsByPath.set(location.path, entries);
    }
    const updated = new Map<string, GitPmDocument>();
    for (const item of checked.documents) {
      const locations = locationsByPath.get(item.relative);
      if (locations !== undefined) updated.set(item.relative, rewriteDocument(item.document, locations, replacement));
    }
    const labels = referenceLabelsForDocuments(checked.documents.map((item) => updated.get(item.relative) ?? item.document));
    const journal: ProjectFileReferenceJournalEntry[] = [];
    try {
      await this.hooks.beforeReferenceWriteForTest?.();
      for (const item of checked.documents.filter((candidate) => updated.has(candidate.relative))) {
        const written = formatYamlDocument(updated.get(item.relative)!, labels);
        const identity = await atomicWriteDomainFile(workspace.worktree_path, item.relative, written, {
          beforeRenameForTest: async () => {
            const current = await lstat(item.absolute);
            const content = current.isFile() && !current.isSymbolicLink() ? await readFile(item.absolute, "utf8") : undefined;
            if (!sameIdentity(current, item.identity) || content !== item.original) {
              throw new ProjectFileOperationError("PROJECT_FILE_REFERENCES_CHANGED", "Repository document changed before reference update");
            }
          },
        });
        journal.push({ relative: item.relative, original: item.original, written, identity });
        await this.hooks.afterReferenceWriteForTest?.();
      }
      const after = await this.check(workspace, projectId, fileName);
      if (after.preview.count !== 0) {
        throw new ProjectFileOperationError("PROJECT_FILE_REFERENCES_CHANGED", "Project file references changed during mutation");
      }
      return {
        references: {
          status: "checked",
          action,
          before_count: checked.preview.count,
          affected_count: checked.preview.count,
          remaining_count: 0,
          locations: checked.preview.locations,
        },
        journal,
      };
    } catch (error) {
      await this.rollback(workspace, projectId, journal);
      throw error;
    }
  }

  async rollback(
    workspace: ProjectFileWorkspace,
    projectId: string,
    journal: readonly ProjectFileReferenceJournalEntry[],
  ): Promise<void> {
    const recoveries: string[] = [];
    let recoveryWriteFailures = 0;
    for (const entry of [...journal].reverse()) {
      const absolute = await resolveDomainPath(workspace.worktree_path, entry.relative);
      try {
        await atomicWriteDomainFile(workspace.worktree_path, entry.relative, entry.original, {
          beforeRenameForTest: async () => {
            const current = await lstat(absolute);
            const content = current.isFile() && !current.isSymbolicLink() ? await readFile(absolute, "utf8") : undefined;
            if (!current.isFile() || current.isSymbolicLink() || !sameIdentity(current, entry.identity) || content !== entry.written) {
              throw new ProjectFileOperationError("PROJECT_FILE_REFERENCES_CHANGED", "Repository document changed before reference rollback");
            }
          },
        });
      } catch {
        const recoveryName = `.gitpm-project-file-${randomUUID()}.references-recovery`;
        const recoveryPath = `projects/${projectId}/files/${recoveryName}`;
        try {
          await this.hooks.beforeReferenceRecoveryWriteForTest?.();
          await atomicWriteDomainFile(workspace.worktree_path, recoveryPath, entry.original);
          recoveries.push(recoveryPath);
        } catch {
          recoveryWriteFailures += 1;
        }
      }
    }
    if (recoveries.length > 0 || recoveryWriteFailures > 0) {
      const created = recoveries.length === 0 ? "" : `; recovery copies: ${recoveries.join(", ")}`;
      const failed = recoveryWriteFailures === 0 ? "" : `; ${recoveryWriteFailures} recovery copy could not be created`;
      throw new ProjectFileOperationError("PROJECT_FILE_ROLLBACK_FAILED", `Project file reference rollback was incomplete${created}${failed}`);
    }
  }
}
