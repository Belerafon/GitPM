export type TimeEntryState = "active" | "voided";

export interface TimeEntryRecord {
  readonly id: string;
  readonly project: string;
  readonly task: string;
  readonly person: string;
  readonly performed_on: string;
  readonly hours: number;
  readonly category: string;
  readonly state?: TimeEntryState;
}

export interface ActualWindow {
  readonly start?: string;
  readonly finish?: string;
  readonly effort_hours: number;
  readonly activity_by_date: Readonly<Record<string, number>>;
}

export interface TimeEntryIssue {
  readonly code:
    | "TIME_ENTRY_HOURS_INVALID"
    | "TIME_ENTRY_DATE_INVALID"
    | "TIME_ENTRY_CATEGORY_UNKNOWN"
    | "TIME_ENTRY_TASK_UNKNOWN"
    | "TIME_ENTRY_PERSON_UNKNOWN"
    | "TIME_ENTRY_PROJECT_UNKNOWN";
  readonly field: string;
  readonly message: string;
}

export interface EntryValidationContext {
  readonly categories: ReadonlySet<string>;
  readonly tasks: ReadonlySet<string>;
  readonly people: ReadonlySet<string>;
  readonly projects: ReadonlySet<string>;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const DAY_MS = 86_400_000;
const round = (value: number): number => Math.round((value + Number.EPSILON) * 10_000) / 10_000;

function isCalendarDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= lengths[month - 1]!;
}

export function isActive(entry: TimeEntryRecord): boolean {
  return entry.state !== "voided";
}

export function activeEntries(entries: readonly TimeEntryRecord[]): readonly TimeEntryRecord[] {
  return entries.filter(isActive);
}

export function sumHours(entries: readonly TimeEntryRecord[]): number {
  return round(activeEntries(entries).reduce((total, entry) => total + entry.hours, 0));
}

function addHours(map: Map<string, number>, key: string, hours: number): void {
  map.set(key, round((map.get(key) ?? 0) + hours));
}

export function groupByDate(entries: readonly TimeEntryRecord[]): ReadonlyMap<string, number> {
  const map = new Map<string, number>();
  for (const entry of activeEntries(entries)) addHours(map, entry.performed_on, entry.hours);
  return map;
}

export function groupByPerson(entries: readonly TimeEntryRecord[]): ReadonlyMap<string, number> {
  const map = new Map<string, number>();
  for (const entry of activeEntries(entries)) addHours(map, entry.person, entry.hours);
  return map;
}

export function groupByCategory(entries: readonly TimeEntryRecord[]): ReadonlyMap<string, number> {
  const map = new Map<string, number>();
  for (const entry of activeEntries(entries)) addHours(map, entry.category, entry.hours);
  return map;
}

export function groupByTask(entries: readonly TimeEntryRecord[]): ReadonlyMap<string, number> {
  const map = new Map<string, number>();
  for (const entry of activeEntries(entries)) addHours(map, entry.task, entry.hours);
  return map;
}

export function groupByProject(entries: readonly TimeEntryRecord[]): ReadonlyMap<string, number> {
  const map = new Map<string, number>();
  for (const entry of activeEntries(entries)) addHours(map, entry.project, entry.hours);
  return map;
}

export function isoWeekStart(date: string): string {
  if (!isCalendarDate(date)) throw new Error(`performed_on must be an ISO calendar date: ${date}`);
  const time = Date.parse(`${date}T00:00:00Z`);
  const weekday = new Date(time).getUTCDay();
  const offset = (weekday + 6) % 7;
  return formatDate(new Date(time - offset * DAY_MS));
}

function formatDate(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

export function groupByWeek(entries: readonly TimeEntryRecord[]): ReadonlyMap<string, number> {
  const map = new Map<string, number>();
  for (const entry of activeEntries(entries)) addHours(map, isoWeekStart(entry.performed_on), entry.hours);
  return map;
}

export function actualWindow(entries: readonly TimeEntryRecord[]): ActualWindow | undefined {
  const active = activeEntries(entries);
  if (active.length === 0) return undefined;
  const byDate = groupByDate(active);
  const dates = [...byDate.keys()].sort();
  return {
    start: dates[0],
    finish: dates[dates.length - 1],
    effort_hours: sumHours(active),
    activity_by_date: Object.fromEntries(byDate.entries()),
  };
}

export function hoursAfterDate(entries: readonly TimeEntryRecord[], cutoff: string): number {
  if (!isCalendarDate(cutoff)) throw new Error(`cutoff must be an ISO calendar date: ${cutoff}`);
  return round(activeEntries(entries).filter((entry) => entry.performed_on > cutoff).reduce((total, entry) => total + entry.hours, 0));
}

export function validateEntry(entry: TimeEntryRecord, context: EntryValidationContext): readonly TimeEntryIssue[] {
  const issues: TimeEntryIssue[] = [];
  if (!Number.isFinite(entry.hours) || entry.hours <= 0 || Math.round(entry.hours * 4) / 4 !== entry.hours) {
    issues.push({ code: "TIME_ENTRY_HOURS_INVALID", field: "hours", message: "hours must be positive and a multiple of 0.25" });
  }
  if (!isCalendarDate(entry.performed_on)) {
    issues.push({ code: "TIME_ENTRY_DATE_INVALID", field: "performed_on", message: "performed_on must be an ISO calendar date" });
  }
  if (context.categories.size > 0 && !context.categories.has(entry.category)) {
    issues.push({ code: "TIME_ENTRY_CATEGORY_UNKNOWN", field: "category", message: `Unknown category ${entry.category}` });
  }
  if (context.projects.size > 0 && !context.projects.has(entry.project)) {
    issues.push({ code: "TIME_ENTRY_PROJECT_UNKNOWN", field: "project", message: `Unknown project ${entry.project}` });
  }
  if (context.tasks.size > 0 && !context.tasks.has(entry.task)) {
    issues.push({ code: "TIME_ENTRY_TASK_UNKNOWN", field: "task", message: `Unknown task ${entry.task}` });
  }
  if (context.people.size > 0 && !context.people.has(entry.person)) {
    issues.push({ code: "TIME_ENTRY_PERSON_UNKNOWN", field: "person", message: `Unknown person ${entry.person}` });
  }
  return issues;
}

export interface ActualSegment {
  readonly date: string;
  readonly hours: number;
}

export function actualSegments(entries: readonly TimeEntryRecord[]): readonly ActualSegment[] {
  return [...groupByDate(entries).entries()].map(([date, hours]) => ({ date, hours })).sort((left, right) => left.date.localeCompare(right.date));
}
