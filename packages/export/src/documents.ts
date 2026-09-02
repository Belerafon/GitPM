import type { GitPmDocument } from "@gitpm/repository-format";
import type { TimeEntryRecord } from "@gitpm/time-entries";
import { ISO_DATE, type ExportLocale } from "./types.js";
import { DEFAULT_PERSON_NAME_FORMAT, formatPersonName, type PersonNameFormat } from "@gitpm/shared";

export interface ExportDocument {
  readonly path: string;
  readonly document: GitPmDocument;
}

export function text(document: GitPmDocument | undefined, key: string): string {
  return typeof document?.[key] === "string" ? String(document[key]) : "";
}

export function number(document: GitPmDocument | undefined, key: string): number | undefined {
  return typeof document?.[key] === "number" ? document[key] : undefined;
}

export function strings(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function namesById(documents: readonly GitPmDocument[], defaultPersonNameFormat: PersonNameFormat = DEFAULT_PERSON_NAME_FORMAT): ReadonlyMap<string, string> {
  return new Map(documents.map((document) => [text(document, "id"), document.schema === "gitpm/person@1" ? formatPersonName(document, defaultPersonNameFormat) : text(document, "name") || text(document, "title") || text(document, "id")]));
}

export function documentGroups(documents: readonly ExportDocument[]) {
  const bySchema = (schema: string) => documents.filter((item) => item.document.schema === schema).map((item) => item.document);
  return {
    projects: bySchema("gitpm/project@2"),
    people: bySchema("gitpm/person@1"),
    tasks: bySchema("gitpm/task@2"),
    milestones: bySchema("gitpm/milestone@2"),
    teams: bySchema("gitpm/team@1"),
    calendars: bySchema("gitpm/calendar@1"),
    statuses: bySchema("gitpm/statuses@2"),
    timeEntries: bySchema("gitpm/time-entry@1"),
    comments: bySchema("gitpm/comment@1"),
    availability: bySchema("gitpm/availability-event@1"),
    savedViews: bySchema("gitpm/saved-view@1"),
    workCategories: bySchema("gitpm/work-categories@1"),
    scheduleTracks: bySchema("gitpm/schedule-tracks@1"),
    repository: bySchema("gitpm/repository@1"),
  };
}

export function timeEntry(document: GitPmDocument): TimeEntryRecord | undefined {
  return document.schema === "gitpm/time-entry@1"
    && typeof document.id === "string"
    && typeof document.project === "string"
    && typeof document.task === "string"
    && typeof document.person === "string"
    && typeof document.performed_on === "string"
    && typeof document.hours === "number"
    && typeof document.category === "string"
    ? {
      id: document.id,
      project: document.project,
      task: document.task,
      person: document.person,
      performed_on: document.performed_on,
      hours: document.hours,
      category: document.category,
      ...(document.state === "voided" ? { state: "voided" as const } : {}),
    }
    : undefined;
}

export function statusTitles(statusDocuments: readonly GitPmDocument[]): ReadonlyMap<string, string> {
  const values = statusDocuments.flatMap((document) => Array.isArray(document.statuses) ? document.statuses : []);
  return new Map(values.flatMap((value) => {
    if (typeof value !== "object" || value === null) return [];
    const candidate = value as Readonly<Record<string, unknown>>;
    return typeof candidate.slug === "string" && typeof candidate.title === "string"
      ? [[candidate.slug, candidate.title] as const]
      : [];
  }));
}

export function completedStatusSlugs(statusDocuments: readonly GitPmDocument[]): ReadonlySet<string> {
  const values = statusDocuments.flatMap((document) => Array.isArray(document.statuses) ? document.statuses : []);
  return new Set(values.flatMap((value) => {
    if (typeof value !== "object" || value === null) return [];
    const candidate = value as Readonly<Record<string, unknown>>;
    return candidate.category === "done" && typeof candidate.slug === "string" ? [candidate.slug] : [];
  }));
}

export function categoryTitles(documents: readonly GitPmDocument[]): ReadonlyMap<string, string> {
  const values = documents.flatMap((document) => Array.isArray(document.categories) ? document.categories : []);
  return new Map(values.flatMap((value) => {
    if (typeof value !== "object" || value === null) return [];
    const candidate = value as Readonly<Record<string, unknown>>;
    return typeof candidate.slug === "string" && typeof candidate.title === "string"
      ? [[candidate.slug, candidate.title] as const]
      : [];
  }));
}

export function localizedDate(locale: ExportLocale, value: string): string {
  if (!ISO_DATE.test(value)) return "-";
  return new Intl.DateTimeFormat(locale === "ru" ? "ru-RU" : "en-US", { dateStyle: "medium", timeZone: "UTC" })
    .format(new Date(`${value}T00:00:00.000Z`));
}

export function localizedNumber(locale: ExportLocale, value: number): string {
  return new Intl.NumberFormat(locale === "ru" ? "ru-RU" : "en-US", { maximumFractionDigits: 2 }).format(value);
}

export function formatWindow(start: string, finish: string): string {
  return start && finish ? `${start} - ${finish}` : start || finish || "-";
}

export function compactDescription(document: GitPmDocument): string {
  const value = text(document, "description_markdown").replace(/\s+/gu, " ").trim();
  return value.length <= 120 ? value : `${value.slice(0, 117).trimEnd()}...`;
}

export function projectRisk(due: string, generatedAt: string): "onTrack" | "near" | "overdue" | "unknown" {
  if (!ISO_DATE.test(due)) return "unknown";
  const days = Math.ceil((Date.parse(`${due}T00:00:00Z`) - Date.parse(generatedAt)) / 86_400_000);
  return days < 0 ? "overdue" : days <= 14 ? "near" : "onTrack";
}

export const SCHEMA_FILE_NAMES: Readonly<Record<string, string>> = {
  "gitpm/repository@1": "repository",
  "gitpm/statuses@2": "statuses",
  "gitpm/issue-types@1": "issue-types",
  "gitpm/work-categories@1": "work-categories",
  "gitpm/project@2": "projects",
  "gitpm/task@2": "tasks",
  "gitpm/milestone@2": "milestones",
  "gitpm/person@1": "people",
  "gitpm/team@1": "teams",
  "gitpm/calendar@1": "calendars",
  "gitpm/availability-event@1": "availability-events",
  "gitpm/saved-view@1": "saved-views",
  "gitpm/comment@1": "comments",
  "gitpm/schedule-tracks@1": "schedule-tracks",
  "gitpm/time-entry@1": "time-entries",
};
