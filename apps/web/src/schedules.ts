const PRIMARY_TRACK = "plan";

export interface ScheduleWindowInput {
  readonly start?: string;
  readonly finish?: string;
  readonly effort_hours?: number;
  readonly depends_on?: readonly string[];
}

type ScheduleHolder = Readonly<Record<string, unknown>>;

function isWindow(value: unknown): value is ScheduleWindowInput {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function windowOf(document: ScheduleHolder): ScheduleWindowInput | undefined {
  const schedules = document.schedules;
  if (schedules === undefined || typeof schedules !== "object" || Array.isArray(schedules)) return undefined;
  const map = schedules as Readonly<Record<string, unknown>>;
  const preferred = map[PRIMARY_TRACK];
  if (isWindow(preferred)) return preferred;
  for (const value of Object.values(map)) {
    if (isWindow(value)) return value;
  }
  return undefined;
}

export function scheduleStart(document: ScheduleHolder): string {
  const start = windowOf(document)?.start;
  return typeof start === "string" ? start : "";
}

export function scheduleFinish(document: ScheduleHolder): string {
  const finish = windowOf(document)?.finish;
  return typeof finish === "string" ? finish : "";
}

export function scheduleText(document: ScheduleHolder, key: "start" | "due"): string {
  return key === "start" ? scheduleStart(document) : scheduleFinish(document);
}

export function scheduleEffort(document: ScheduleHolder): number | undefined {
  const effort = windowOf(document)?.effort_hours;
  return typeof effort === "number" ? effort : undefined;
}

export function buildSchedule(start: string, finish: string, effort: string): Readonly<Record<string, ScheduleWindowInput>> | undefined {
  const window: { start?: string; finish?: string; effort_hours?: number } = {};
  if (start !== "") window.start = start;
  if (finish !== "") window.finish = finish;
  const effortNumber = Number(effort);
  if (effort !== "" && Number.isFinite(effortNumber)) window.effort_hours = effortNumber;
  return Object.keys(window).length === 0 ? undefined : { [PRIMARY_TRACK]: window };
}
