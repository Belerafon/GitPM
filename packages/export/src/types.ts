export const EXPORT_FORMATS = ["pdf", "html", "csv", "xlsx", "repository"] as const;
export const EXPORT_REPORTS = [
  "portfolio",
  "project-plan",
  "plan-fact",
  "workload",
  "vacations",
  "person-profile",
  "audit",
] as const;
export const EXPORT_LEGACY_SECTIONS = ["projects", "people", "project-details", "gantt"] as const;
export const EXPORT_SECTIONS = [...EXPORT_REPORTS, ...EXPORT_LEGACY_SECTIONS] as const;
export const EXPORT_SCOPES = ["portfolio", "project", "person", "team"] as const;
export const EXPORT_LIFECYCLES = ["active", "archived", "all"] as const;
export const EXPORT_TIME_ENTRY_STATES = ["active", "voided", "all"] as const;
export const EXPORT_PAGE_SIZES = ["A4", "Letter"] as const;
export const EXPORT_DENSITIES = ["compact", "detailed"] as const;

export type ExportFormat = (typeof EXPORT_FORMATS)[number];
export type ExportReport = (typeof EXPORT_REPORTS)[number];
export type ExportSection = (typeof EXPORT_SECTIONS)[number];
export type ExportLocale = "en" | "ru";
export type ExportScope = (typeof EXPORT_SCOPES)[number];
export type ExportLifecycle = (typeof EXPORT_LIFECYCLES)[number];
export type ExportTimeEntryState = (typeof EXPORT_TIME_ENTRY_STATES)[number];
export type ExportPageSize = (typeof EXPORT_PAGE_SIZES)[number];
export type ExportDensity = (typeof EXPORT_DENSITIES)[number];

export interface ExportRequest {
  readonly format: ExportFormat;
  readonly locale?: ExportLocale;
  readonly sections?: readonly ExportSection[];
  readonly include_git?: boolean;
  readonly scope?: ExportScope;
  readonly project?: string;
  readonly person?: string;
  readonly team?: string;
  readonly as_of?: string;
  readonly period_start?: string;
  readonly period_finish?: string;
  readonly lifecycle?: ExportLifecycle;
  readonly time_entry_state?: ExportTimeEntryState;
  readonly include_ids?: boolean;
  readonly include_email?: boolean;
  readonly include_notes?: boolean;
  readonly include_comments?: boolean;
  readonly hide_personal_data?: boolean;
  readonly page_size?: ExportPageSize;
  readonly density?: ExportDensity;
  readonly report_title?: string;
}

export interface ExportArtifact {
  readonly content: Buffer;
  readonly content_type: string;
  readonly filename: string;
}

export interface ExportProvider {
  create(draftId: string, request: ExportRequest): Promise<ExportArtifact>;
}

export class ExportError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ExportError";
  }
}

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

export function isExportFormat(value: string): value is ExportFormat {
  return (EXPORT_FORMATS as readonly string[]).includes(value);
}

export function isExportSection(value: string): value is ExportSection {
  return (EXPORT_SECTIONS as readonly string[]).includes(value);
}

export function isExportScope(value: string): value is ExportScope {
  return (EXPORT_SCOPES as readonly string[]).includes(value);
}

export function isExportLifecycle(value: string): value is ExportLifecycle {
  return (EXPORT_LIFECYCLES as readonly string[]).includes(value);
}

export function isExportTimeEntryState(value: string): value is ExportTimeEntryState {
  return (EXPORT_TIME_ENTRY_STATES as readonly string[]).includes(value);
}

export function isExportPageSize(value: string): value is ExportPageSize {
  return (EXPORT_PAGE_SIZES as readonly string[]).includes(value);
}

export function isExportDensity(value: string): value is ExportDensity {
  return (EXPORT_DENSITIES as readonly string[]).includes(value);
}
