import type { GitPmDocument } from "@gitpm/repository-format";
import { ENTITY_ID_PREFIX, isEntityId, tokenizeProjectFileReferences } from "@gitpm/shared";

export type ProjectFileReferenceEntityType = "project" | "milestone" | "task" | "comment" | "time_entry";
export type ProjectFileReferenceField =
  | "description_markdown"
  | "acceptance_criteria_markdown"
  | "body_markdown"
  | "note_markdown";

export interface ProjectFileReferenceLocation {
  readonly entity_type: ProjectFileReferenceEntityType;
  readonly entity_id: string;
  readonly path: string;
  readonly field: ProjectFileReferenceField;
  /** Present only for an item in Task acceptance_criteria_markdown. */
  readonly value_index?: number;
  /** UTF-16 offsets inside the field value, not the YAML file. */
  readonly start: number;
  readonly end: number;
}

export interface ProjectFileReferenceSearchResult {
  readonly project_id: string;
  readonly file_name: string;
  readonly count: number;
  readonly locations: readonly ProjectFileReferenceLocation[];
}

interface MarkdownValue {
  readonly field: ProjectFileReferenceField;
  readonly value: string;
  readonly value_index?: number;
}

interface ScopedDocument {
  readonly entity_type: ProjectFileReferenceEntityType;
  readonly entity_id: string;
  readonly path: string;
  readonly markdown: readonly MarkdownValue[];
}

function stringValue(document: GitPmDocument, field: string): string | undefined {
  const value = document[field];
  return typeof value === "string" ? value : undefined;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function scopedDocument(projectId: string, document: GitPmDocument): ScopedDocument | undefined {
  const id = stringValue(document, "id");
  if (id === undefined) return undefined;
  const description = stringValue(document, "description_markdown");
  if (document.schema === "gitpm/project@2" && id === projectId && isEntityId(id, ENTITY_ID_PREFIX.project)) {
    return {
      entity_type: "project",
      entity_id: id,
      path: `projects/${id}/project.yaml`,
      markdown: description === undefined ? [] : [{ field: "description_markdown", value: description }],
    };
  }
  if (document.project !== projectId) return undefined;
  if (document.schema === "gitpm/milestone@2" && isEntityId(id, ENTITY_ID_PREFIX.milestone)) {
    return {
      entity_type: "milestone",
      entity_id: id,
      path: `projects/${projectId}/milestones/${id}.yaml`,
      markdown: description === undefined ? [] : [{ field: "description_markdown", value: description }],
    };
  }
  if (document.schema === "gitpm/task@2" && isEntityId(id, ENTITY_ID_PREFIX.task)) {
    const criteria = Array.isArray(document.acceptance_criteria_markdown)
      ? document.acceptance_criteria_markdown.flatMap((value, valueIndex): MarkdownValue[] => (
        typeof value === "string" ? [{ field: "acceptance_criteria_markdown", value, value_index: valueIndex }] : []
      ))
      : [];
    return {
      entity_type: "task",
      entity_id: id,
      path: `projects/${projectId}/tasks/${id}.yaml`,
      markdown: [...(description === undefined ? [] : [{ field: "description_markdown" as const, value: description }]), ...criteria],
    };
  }
  const task = stringValue(document, "task");
  if (task === undefined || !isEntityId(task, ENTITY_ID_PREFIX.task)) return undefined;
  if (document.schema === "gitpm/comment@1" && isEntityId(id, ENTITY_ID_PREFIX.comment)) {
    const body = document.state === "active" ? stringValue(document, "body_markdown") : undefined;
    return {
      entity_type: "comment",
      entity_id: id,
      path: `projects/${projectId}/comments/${task}/${id}.yaml`,
      markdown: body === undefined ? [] : [{ field: "body_markdown", value: body }],
    };
  }
  if (document.schema === "gitpm/time-entry@1" && isEntityId(id, ENTITY_ID_PREFIX.entry)) {
    const note = stringValue(document, "note_markdown");
    return {
      entity_type: "time_entry",
      entity_id: id,
      path: `projects/${projectId}/time-entries/${task}/${id}.yaml`,
      markdown: note === undefined ? [] : [{ field: "note_markdown", value: note }],
    };
  }
  return undefined;
}

/** Finds every exact-name usage in supported Markdown fields of one Project. */
export function searchProjectFileReferences(input: {
  readonly projectId: string;
  readonly fileName: string;
  readonly documents: readonly GitPmDocument[];
}): ProjectFileReferenceSearchResult {
  if (!isEntityId(input.projectId, ENTITY_ID_PREFIX.project)) {
    return { project_id: input.projectId, file_name: input.fileName, count: 0, locations: [] };
  }
  const locations = input.documents.flatMap((document): readonly ProjectFileReferenceLocation[] => {
    const scoped = scopedDocument(input.projectId, document);
    if (scoped === undefined) return [];
    return scoped.markdown.flatMap((markdown) => tokenizeProjectFileReferences(markdown.value).flatMap((token) => (
      token.kind === "file_reference" && token.name === input.fileName
        ? [{
          entity_type: scoped.entity_type,
          entity_id: scoped.entity_id,
          path: scoped.path,
          field: markdown.field,
          ...(markdown.value_index === undefined ? {} : { value_index: markdown.value_index }),
          start: token.start,
          end: token.end,
        }]
        : []
    )));
  }).sort((left, right) => compareText(left.path, right.path)
    || compareText(left.field, right.field)
    || (left.value_index ?? -1) - (right.value_index ?? -1)
    || left.start - right.start
    || left.end - right.end);
  return {
    project_id: input.projectId,
    file_name: input.fileName,
    count: locations.length,
    locations,
  };
}
