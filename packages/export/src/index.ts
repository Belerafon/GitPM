import { spawn } from "node:child_process";
import { lstat, mkdtemp, readFile, readdir, readlink, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DraftManager } from "@gitpm/drafts";
import type { GitClient } from "@gitpm/git-client";
import { parseYamlDocument, type GitPmDocument } from "@gitpm/repository-format";
import { discoverRepositoryFiles, validateRepository } from "@gitpm/validation";
import pdfMake from "pdfmake/build/pdfmake.js";
import pdfFonts from "pdfmake/build/vfs_fonts.js";
import { createZip, type ZipEntry } from "./zip.js";

export const EXPORT_FORMATS = ["pdf", "html", "csv", "repository"] as const;
export const EXPORT_SECTIONS = ["projects", "people", "project-details", "gantt"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
export type ExportSection = (typeof EXPORT_SECTIONS)[number];
export type ExportLocale = "en" | "ru";

export interface ExportRequest {
  readonly format: ExportFormat;
  readonly locale?: ExportLocale;
  readonly sections?: readonly ExportSection[];
  readonly include_git?: boolean;
}

export interface ExportArtifact {
  readonly content: Buffer;
  readonly content_type: string;
  readonly filename: string;
}

export interface ExportProvider {
  create(draftId: string, request: ExportRequest): Promise<ExportArtifact>;
}

interface ExportDocument {
  readonly path: string;
  readonly document: GitPmDocument;
}

interface ExportSnapshot {
  readonly commit: string;
  readonly shortCommit: string;
  readonly commitDate: string;
  readonly generatedAt: string;
  readonly root: string;
  readonly documents: readonly ExportDocument[];
}

interface CopyText {
  readonly title: string;
  readonly projects: string;
  readonly people: string;
  readonly person: string;
  readonly projectDetails: string;
  readonly gantt: string;
  readonly tasks: string;
  readonly milestones: string;
  readonly teams: string;
  readonly calendars: string;
  readonly calendar: string;
  readonly capacity: string;
  readonly status: string;
  readonly owner: string;
  readonly due: string;
  readonly risk: string;
  readonly riskOnTrack: string;
  readonly riskNear: string;
  readonly riskOverdue: string;
  readonly riskUnknown: string;
  readonly unassigned: string;
  readonly ungrouped: string;
  readonly activeProjects: string;
  readonly activeTasks: string;
  readonly activeMilestones: string;
  readonly completedTasks: string;
  readonly assignees: string;
  readonly schedule: string;
  readonly noData: string;
  readonly generated: string;
  readonly commit: string;
  readonly board: string;
}

const COPY: Readonly<Record<ExportLocale, CopyText>> = {
  en: {
    title: "GitPM portfolio", projects: "Projects", people: "People", person: "Person", projectDetails: "Project details", gantt: "Gantt",
    tasks: "Tasks", milestones: "Milestones", teams: "Teams", calendars: "Calendars", calendar: "Calendar",
    capacity: "Weekly capacity (hours)", status: "Status", owner: "Project owner", due: "Due date", risk: "Risk",
    riskOnTrack: "On track", riskNear: "Due soon", riskOverdue: "Overdue", riskUnknown: "No due date",
    unassigned: "Unassigned", ungrouped: "Ungrouped", activeProjects: "Active projects", activeTasks: "Active tasks",
    activeMilestones: "Active milestones", completedTasks: "Completed tasks",
    assignees: "Assignees", schedule: "Schedule", noData: "No data", generated: "Generated", commit: "Commit", board: "Board",
  },
  ru: {
    title: "Портфель GitPM", projects: "Проекты", people: "Люди", person: "Сотрудник", projectDetails: "Подробности проектов", gantt: "Гант",
    tasks: "Задачи", milestones: "Этапы", teams: "Команды", calendars: "Календари", calendar: "Календарь",
    capacity: "Недельная ёмкость (часы)", status: "Статус", owner: "Ответственный за проект", due: "Срок", risk: "Риск",
    riskOnTrack: "По плану", riskNear: "Срок близко", riskOverdue: "Просрочен", riskUnknown: "Без срока",
    unassigned: "Не назначен", ungrouped: "Без группы", activeProjects: "Активных проектов", activeTasks: "Активных задач",
    activeMilestones: "Активных этапов", completedTasks: "Завершённых задач",
    assignees: "Исполнители", schedule: "Сроки", noData: "Нет данных", generated: "Сформировано", commit: "Коммит", board: "Доска",
  },
};

const schemaFileNames: Readonly<Record<string, string>> = {
  "gitpm/repository@1": "repository",
  "gitpm/statuses@2": "statuses",
  "gitpm/issue-types@1": "issue-types",
  "gitpm/project@2": "projects",
  "gitpm/task@2": "tasks",
  "gitpm/milestone@2": "milestones",
  "gitpm/person@1": "people",
  "gitpm/team@1": "teams",
  "gitpm/calendar@1": "calendars",
  "gitpm/saved-view@1": "saved-views",
  "gitpm/comment@1": "comments",
};

export class ExportError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ExportError";
  }
}

function text(document: GitPmDocument, key: string): string {
  return typeof document[key] === "string" ? String(document[key]) : "";
}

function scheduleWindow(document: GitPmDocument): Readonly<Record<string, unknown>> | undefined {
  const schedules = document.schedules;
  if (schedules === undefined || typeof schedules !== "object" || Array.isArray(schedules)) return undefined;
  const map = schedules as Record<string, unknown>;
  const preferred = map.plan;
  if (preferred !== undefined && preferred !== null && typeof preferred === "object" && !Array.isArray(preferred)) {
    return preferred as Readonly<Record<string, unknown>>;
  }
  for (const value of Object.values(map)) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as Readonly<Record<string, unknown>>;
  }
  return undefined;
}

function windowField(document: GitPmDocument, field: string): string {
  const value = scheduleWindow(document)?.[field];
  return typeof value === "string" ? value : "";
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function number(document: GitPmDocument, key: string): number | undefined {
  return typeof document[key] === "number" ? document[key] : undefined;
}

function active(documents: readonly GitPmDocument[]): readonly GitPmDocument[] {
  return documents.filter((document) => text(document, "lifecycle") === "active");
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function slugDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) throw new ExportError("EXPORT_COMMIT_METADATA_INVALID", "Commit date is invalid");
  return date.toISOString().slice(0, 10).replaceAll("-", "");
}

function sections(request: ExportRequest): ReadonlySet<ExportSection> {
  return new Set(request.sections?.length ? request.sections : ["projects", "people"]);
}

function documentGroups(snapshot: ExportSnapshot) {
  const bySchema = (schema: string) => snapshot.documents.filter((item) => item.document.schema === schema).map((item) => item.document);
  const projects = bySchema("gitpm/project@2");
  const people = bySchema("gitpm/person@1");
  const tasks = bySchema("gitpm/task@2");
  const milestones = bySchema("gitpm/milestone@2");
  const teams = bySchema("gitpm/team@1");
  const calendars = bySchema("gitpm/calendar@1");
  const statuses = bySchema("gitpm/statuses@2");
  return { projects, people, tasks, milestones, teams, calendars, statuses };
}

function namesById(documents: readonly GitPmDocument[]): ReadonlyMap<string, string> {
  return new Map(documents.map((document) => [text(document, "id"), text(document, "name") || text(document, "title") || text(document, "id")]));
}

function csvValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  const raw = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]/u.test(raw) ? `"${raw.replaceAll('"', '""')}"` : raw;
}

function renderCsv(documents: readonly ExportDocument[]): string {
  const fields = [...new Set(documents.flatMap((item) => Object.keys(item.document)))].sort((left, right) => {
    const order = ["schema", "id", "project", "name", "title", "lifecycle"];
    const leftIndex = order.indexOf(left);
    const rightIndex = order.indexOf(right);
    return (leftIndex < 0 ? order.length : leftIndex) - (rightIndex < 0 ? order.length : rightIndex) || left.localeCompare(right);
  });
  return `\uFEFF${fields.map(csvValue).join(",")}\r\n${documents.map((item) => fields.map((field) => csvValue(item.document[field])).join(",")).join("\r\n")}\r\n`;
}

function taskSchedule(task: GitPmDocument): string {
  const start = windowField(task, "start");
  const finish = windowField(task, "finish");
  return start && finish ? `${start} - ${finish}` : start || finish || "-";
}

function renderGanttHtml(tasks: readonly GitPmDocument[]): string {
  const dated = tasks.filter((task) => /^\d{4}-\d{2}-\d{2}$/u.test(windowField(task, "start")) && /^\d{4}-\d{2}-\d{2}$/u.test(windowField(task, "finish")));
  if (dated.length === 0) return "";
  const day = (value: string) => Math.floor(Date.parse(`${value}T00:00:00Z`) / 86_400_000);
  const first = Math.min(...dated.map((task) => day(windowField(task, "start"))));
  const last = Math.max(...dated.map((task) => day(windowField(task, "finish"))));
  const span = Math.max(1, last - first + 1);
  return `<div class="gantt">${dated.map((task) => {
    const left = ((day(windowField(task, "start")) - first) / span) * 100;
    const width = Math.max(1.5, ((day(windowField(task, "finish")) - day(windowField(task, "start")) + 1) / span) * 100);
    return `<div class="gantt-row"><span>${escapeHtml(text(task, "title"))}</span><div class="gantt-track"><i style="left:${left.toFixed(3)}%;width:${width.toFixed(3)}%"></i></div><small>${escapeHtml(taskSchedule(task))}</small></div>`;
  }).join("")}</div>`;
}

function renderHtml(snapshot: ExportSnapshot, locale: ExportLocale): Buffer {
  const t = COPY[locale];
  const { projects, people, tasks, milestones, teams, calendars } = documentGroups(snapshot);
  const peopleNames = namesById(people);
  const projectNames = namesById(projects);
  const navigation = [
    ["projects", t.projects], ["people", t.people], ["teams", t.teams], ["calendars", t.calendars],
    ...projects.map((project) => [`project-${text(project, "id")}`, text(project, "name")]),
  ];
  const projectCards = projects.map((project) => `<article><h3><a href="#project-${escapeHtml(text(project, "id"))}">${escapeHtml(text(project, "name"))}</a></h3><dl><div><dt>${t.status}</dt><dd>${escapeHtml(text(project, "status"))}</dd></div><div><dt>${t.owner}</dt><dd>${escapeHtml((peopleNames.get(text(project, "owner")) ?? text(project, "owner")) || "—")}</dd></div></dl><p>${escapeHtml(text(project, "description_markdown"))}</p></article>`).join("");
  const peopleRows = people.map((person) => {
    const personProjects = new Set(projects.filter((project) => text(project, "owner") === text(person, "id")).map((project) => text(project, "id")));
    for (const task of tasks) if (strings(task.assignees).includes(text(person, "id"))) personProjects.add(text(task, "project"));
    return `<tr><th>${escapeHtml(text(person, "name"))}</th><td>${escapeHtml(text(person, "email") || "—")}</td><td>${escapeHtml(String(person.weekly_capacity_hours ?? "—"))}</td><td>${[...personProjects].map((id) => escapeHtml(projectNames.get(id) ?? id)).join(", ") || "—"}</td></tr>`;
  }).join("");
  const details = projects.map((project) => {
    const id = text(project, "id");
    const projectTasks = tasks.filter((task) => text(task, "project") === id);
    const projectMilestones = milestones.filter((milestone) => text(milestone, "project") === id);
    const statuses = [...new Set(projectTasks.map((task) => text(task, "status")))];
    const board = statuses.map((status) => `<section><h4>${escapeHtml(status || "—")}</h4>${projectTasks.filter((task) => text(task, "status") === status).map((task) => `<article><strong>${escapeHtml(text(task, "title"))}</strong><small>${escapeHtml(taskSchedule(task))}</small></article>`).join("")}</section>`).join("");
    return `<section class="page project-detail" id="project-${escapeHtml(id)}"><header><span>${escapeHtml(id)}</span><h2>${escapeHtml(text(project, "name"))}</h2><p>${escapeHtml(text(project, "description_markdown"))}</p></header><h3>${t.milestones}</h3><ul>${projectMilestones.map((milestone) => `<li><strong>${escapeHtml(text(milestone, "name"))}</strong> · ${escapeHtml(windowField(milestone, "finish") || "—")}</li>`).join("") || `<li>${t.noData}</li>`}</ul><h3>${t.tasks}</h3><table><thead><tr><th>${t.tasks}</th><th>${t.status}</th><th>${t.assignees}</th><th>${t.schedule}</th></tr></thead><tbody>${projectTasks.map((task) => `<tr><th>${escapeHtml(text(task, "title"))}</th><td>${escapeHtml(text(task, "status"))}</td><td>${strings(task.assignees).map((id) => escapeHtml(peopleNames.get(id) ?? id)).join(", ") || "—"}</td><td>${escapeHtml(taskSchedule(task))}</td></tr>`).join("")}</tbody></table><h3>${t.board}</h3><div class="board">${board}</div><h3>${t.gantt}</h3>${renderGanttHtml(projectTasks) || `<p>${t.noData}</p>`}</section>`;
  }).join("");
  const html = `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${t.title}</title><style>
*{box-sizing:border-box}body{margin:0;background:#f4f5f1;color:#27322c;font:14px/1.5 system-ui,sans-serif}a{color:#245c42}aside{position:fixed;inset:0 auto 0 0;width:230px;overflow:auto;background:#173d2d;color:#fff;padding:24px 18px}aside h1{font-size:20px}aside a{display:block;color:#dce9e1;text-decoration:none;padding:7px 0}main{margin-left:230px;padding:32px;max-width:1500px}.meta{color:#647068}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:16px}article,.page,table,.board section{background:#fff;border:1px solid #d9ddd6;border-radius:10px;padding:16px}dl div{display:flex;gap:8px}dt{font-weight:700}table{width:100%;border-collapse:collapse;margin:12px 0}th,td{text-align:left;border-bottom:1px solid #e3e6e0;padding:8px}.page{margin:28px 0}.board{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}.board article{margin:8px 0;padding:10px}.board small{display:block}.gantt{overflow:auto}.gantt-row{display:grid;grid-template-columns:180px minmax(420px,1fr) 190px;align-items:center;gap:10px;margin:8px 0}.gantt-track{position:relative;height:26px;background:repeating-linear-gradient(90deg,#edf0ea 0,#edf0ea calc(10% - 1px),#d7ddd5 10%)}.gantt-track i{position:absolute;top:4px;height:18px;border-radius:5px;background:#327454}@media(max-width:760px){aside{position:static;width:auto}main{margin:0;padding:18px}.gantt-row{grid-template-columns:130px 420px 170px}}@media print{aside{display:none}main{margin:0;padding:0}.page{break-before:page}}
</style></head><body><aside><h1>${t.title}</h1>${navigation.map(([id, label]) => `<a href="#${escapeHtml(id)}">${escapeHtml(label)}</a>`).join("")}<p>${t.commit}: <code>${snapshot.shortCommit}</code></p></aside><main><header><h1>${t.title}</h1><p class="meta">${t.commit}: ${snapshot.commit} · ${t.generated}: ${escapeHtml(snapshot.generatedAt)}</p></header><section id="projects"><h2>${t.projects}</h2><div class="grid">${projectCards || `<p>${t.noData}</p>`}</div></section><section id="people"><h2>${t.people}</h2><table><thead><tr><th>${t.people}</th><th>Email</th><th>h/week</th><th>${t.projects}</th></tr></thead><tbody>${peopleRows}</tbody></table></section><section id="teams"><h2>${t.teams}</h2><div class="grid">${teams.map((team) => `<article><h3>${escapeHtml(text(team, "name"))}</h3><p>${strings(team.members).map((id) => escapeHtml(peopleNames.get(id) ?? id)).join(", ") || "—"}</p></article>`).join("") || `<p>${t.noData}</p>`}</div></section><section id="calendars"><h2>${t.calendars}</h2><div class="grid">${calendars.map((calendar) => `<article><h3>${escapeHtml(text(calendar, "name"))}</h3><p>${escapeHtml(Array.isArray(calendar.working_weekdays) ? calendar.working_weekdays.join(", ") : "")}</p></article>`).join("") || `<p>${t.noData}</p>`}</div></section>${details}</main></body></html>`;
  return Buffer.from(html, "utf8");
}

type PdfTableCell = string | Readonly<Record<string, unknown>>;

function pdfTable(
  header: readonly string[],
  rows: readonly (readonly PdfTableCell[])[],
  widths: readonly (number | string)[] = header.map(() => "*"),
): unknown {
  return {
    layout: "lightHorizontalLines",
    table: {
      headerRows: 1,
      widths,
      body: [header.map((value) => ({ text: value, bold: true, color: "#33443b", fillColor: "#edf2ee" })), ...rows],
    },
    margin: [0, 8, 0, 16],
  };
}

function localizedDate(locale: ExportLocale, value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return "-";
  return new Intl.DateTimeFormat(locale === "ru" ? "ru-RU" : "en-US", { dateStyle: "medium", timeZone: "UTC" })
    .format(new Date(`${value}T00:00:00.000Z`));
}

function localizedNumber(locale: ExportLocale, value: number): string {
  return new Intl.NumberFormat(locale === "ru" ? "ru-RU" : "en-US", { maximumFractionDigits: 2 }).format(value);
}

function statusTitles(statusDocuments: readonly GitPmDocument[]): ReadonlyMap<string, string> {
  const values = statusDocuments.flatMap((document) => Array.isArray(document.statuses) ? document.statuses : []);
  return new Map(values.flatMap((value) => {
    if (typeof value !== "object" || value === null) return [];
    const candidate = value as Readonly<Record<string, unknown>>;
    return candidate.active === true && typeof candidate.slug === "string" && typeof candidate.title === "string"
      ? [[candidate.slug, candidate.title] as const]
      : [];
  }));
}

function completedStatusSlugs(statusDocuments: readonly GitPmDocument[]): ReadonlySet<string> {
  const values = statusDocuments.flatMap((document) => Array.isArray(document.statuses) ? document.statuses : []);
  return new Set(values.flatMap((value) => {
    if (typeof value !== "object" || value === null) return [];
    const candidate = value as Readonly<Record<string, unknown>>;
    return candidate.category === "done" && typeof candidate.slug === "string" ? [candidate.slug] : [];
  }));
}

function projectRisk(project: GitPmDocument, generatedAt: string): "onTrack" | "near" | "overdue" | "unknown" {
  const due = windowField(project, "finish");
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(due)) return "unknown";
  const days = Math.ceil((Date.parse(`${due}T00:00:00Z`) - Date.parse(generatedAt)) / 86_400_000);
  return days < 0 ? "overdue" : days <= 14 ? "near" : "onTrack";
}

function compactDescription(document: GitPmDocument): string {
  const value = text(document, "description_markdown").replace(/\s+/gu, " ").trim();
  return value.length <= 120 ? value : `${value.slice(0, 117).trimEnd()}...`;
}

function projectGroups(projects: readonly GitPmDocument[], locale: ExportLocale, ungrouped: string) {
  const named = new Map<string, GitPmDocument[]>();
  const withoutGroup: GitPmDocument[] = [];
  for (const project of projects) {
    const group = text(project, "group").trim();
    if (group === "") withoutGroup.push(project);
    else named.set(group, [...(named.get(group) ?? []), project]);
  }
  const byName = (left: GitPmDocument, right: GitPmDocument) =>
    text(left, "name").localeCompare(text(right, "name"), locale);
  const groups = [...named.entries()]
    .sort(([left], [right]) => left.localeCompare(right, locale))
    .map(([title, items]) => ({ title, projects: [...items].sort(byName) }));
  if (withoutGroup.length > 0) groups.push({ title: ungrouped, projects: [...withoutGroup].sort(byName) });
  return groups;
}

function summaryMetrics(items: readonly { readonly label: string; readonly value: number }[]): unknown {
  return {
    columns: items.map((item) => ({
      width: "*",
      stack: [
        { text: String(item.value), fontSize: 18, bold: true, color: "#173d2d" },
        { text: item.label, fontSize: 7, color: "#647068" },
      ],
      margin: [8, 7, 8, 7],
    })),
    columnGap: 8,
    margin: [0, 0, 0, 10],
  };
}

function renderGanttPdf(tasks: readonly GitPmDocument[], noData: string): unknown {
  const dated = tasks.filter((task) =>
    /^\d{4}-\d{2}-\d{2}$/u.test(windowField(task, "start"))
    && /^\d{4}-\d{2}-\d{2}$/u.test(windowField(task, "finish"))
    && Date.parse(`${windowField(task, "start")}T00:00:00Z`) <= Date.parse(`${windowField(task, "finish")}T00:00:00Z`),
  );
  if (dated.length === 0) return { text: noData };
  const day = (value: string) => Math.floor(Date.parse(`${value}T00:00:00Z`) / 86_400_000);
  const first = Math.min(...dated.map((task) => day(windowField(task, "start"))));
  const last = Math.max(...dated.map((task) => day(windowField(task, "finish"))));
  const total = Math.max(1, last - first + 1);
  const chartWidth = 330;
  const isoDay = (value: number) => new Date(value * 86_400_000).toISOString().slice(0, 10);
  const rows: unknown[] = [{
    columns: [
      { text: "", width: 145 },
      { text: `${isoDay(first)} - ${isoDay(last)}`, width: chartWidth, fontSize: 8, color: "#647068" },
    ],
    margin: [0, 0, 0, 5],
  }];
  for (const task of dated) {
    const left = ((day(windowField(task, "start")) - first) / total) * chartWidth;
    const width = Math.max(3, ((day(windowField(task, "finish")) - day(windowField(task, "start")) + 1) / total) * chartWidth);
    rows.push({
      columns: [
        { text: text(task, "title"), width: 145, fontSize: 8, margin: [0, 3, 6, 0] },
        {
          width: chartWidth,
          stack: [
            { canvas: [
              { type: "rect", x: 0, y: 2, w: chartWidth, h: 12, color: "#edf0ea" },
              { type: "rect", x: left, y: 2, w: width, h: 12, r: 2, color: "#327454" },
            ] },
            { text: taskSchedule(task), fontSize: 7, color: "#647068", margin: [0, 1, 0, 0] },
          ],
        },
      ],
      margin: [0, 0, 0, 5],
    });
  }
  return { stack: rows };
}

async function renderPdf(snapshot: ExportSnapshot, locale: ExportLocale, selected: ReadonlySet<ExportSection>): Promise<Buffer> {
  pdfMake.vfs = pdfFonts;
  const t = COPY[locale];
  const groups = documentGroups(snapshot);
  const projects = active(groups.projects);
  const people = active(groups.people);
  const tasks = active(groups.tasks);
  const milestones = active(groups.milestones);
  const teams = active(groups.teams);
  const calendars = active(groups.calendars);
  const peopleNames = namesById(people);
  const projectNames = namesById(projects);
  const calendarNames = namesById(calendars);
  const titlesByStatus = statusTitles(groups.statuses);
  const doneStatusSlugs = completedStatusSlugs(groups.statuses);
  const content: unknown[] = [
    { text: t.title, style: "title" },
    { text: `${t.commit}: ${snapshot.shortCommit} · ${t.generated}: ${snapshot.generatedAt}`, style: "meta" },
  ];
  if (selected.has("projects")) {
    content.push({ text: t.projects, style: "heading", pageBreak: content.length > 2 ? "before" : undefined });
    content.push(summaryMetrics([
      { label: t.activeProjects, value: projects.length },
      { label: t.activeTasks, value: tasks.length },
      { label: t.activeMilestones, value: milestones.length },
      { label: t.completedTasks, value: tasks.filter((task) => doneStatusSlugs.has(text(task, "status"))).length },
    ]));
    const groupedProjects = projectGroups(projects, locale, t.ungrouped);
    if (groupedProjects.length === 0) content.push({ text: t.noData });
    for (const group of groupedProjects) {
      content.push({ text: `${group.title} (${group.projects.length})`, style: "tableGroup" });
      content.push(pdfTable(
        [t.projects, t.status, t.owner, t.tasks, t.milestones, t.due, t.risk],
        group.projects.map((project) => {
          const projectId = text(project, "id");
          const description = compactDescription(project);
          const risk = projectRisk(project, snapshot.generatedAt);
          const projectCell: Readonly<Record<string, unknown>> = {
            stack: [
              { text: text(project, "name"), bold: true },
              { text: projectId, fontSize: 6.5, color: "#727a75" },
              ...(description === "" ? [] : [{ text: description, fontSize: 7, color: "#647068" }]),
            ],
          };
          return [
            projectCell,
            titlesByStatus.get(text(project, "status")) ?? text(project, "status"),
            (peopleNames.get(text(project, "owner")) ?? text(project, "owner")) || t.unassigned,
            String(tasks.filter((task) => text(task, "project") === projectId).length),
            String(milestones.filter((milestone) => text(milestone, "project") === projectId).length),
            localizedDate(locale, windowField(project, "finish")),
            risk === "onTrack" ? t.riskOnTrack : risk === "near" ? t.riskNear : risk === "overdue" ? t.riskOverdue : t.riskUnknown,
          ];
        }),
        [172, 72, 105, 42, 48, 70, 68],
      ));
    }
  }
  if (selected.has("people")) {
    content.push({ text: t.people, style: "heading", pageBreak: "before" });
    content.push(pdfTable(
      [t.person, t.projects, t.teams, t.capacity, t.calendar],
      people.map((person) => {
        const personId = text(person, "id");
        const personProjectIds = new Set(
          projects.filter((project) => text(project, "owner") === personId).map((project) => text(project, "id")),
        );
        for (const task of tasks) {
          if (strings(task.assignees).includes(personId) && projectNames.has(text(task, "project"))) {
            personProjectIds.add(text(task, "project"));
          }
        }
        const personProjects = [...personProjectIds]
          .map((projectId) => projectNames.get(projectId) ?? projectId)
          .sort((left, right) => left.localeCompare(right, locale));
        const personTeams = teams
          .filter((team) => strings(team.members).includes(personId))
          .map((team) => text(team, "name"))
          .sort((left, right) => left.localeCompare(right, locale));
        const capacity = number(person, "weekly_capacity_hours");
        return [
          { stack: [
            { text: text(person, "name"), bold: true },
            { text: personId, fontSize: 6.5, color: "#727a75" },
          ] },
          personProjects.join(", ") || "-",
          personTeams.join(", ") || "-",
          capacity === undefined ? "-" : `${localizedNumber(locale, capacity)} ${locale === "ru" ? "ч/нед." : "h/week"}`,
          calendarNames.get(text(person, "calendar")) ?? "-",
        ];
      }),
      [130, 210, 110, 92, 128],
    ));
  }
  for (const project of projects) {
    const projectId = text(project, "id");
    const projectTasks = tasks.filter((task) => text(task, "project") === projectId);
    const projectMilestones = milestones.filter((milestone) => text(milestone, "project") === projectId);
    if (selected.has("project-details")) {
      content.push({ text: text(project, "name"), style: "heading", pageBreak: "before" });
      content.push({ text: text(project, "description_markdown") || "-", margin: [0, 4, 0, 12] });
      content.push({ text: t.milestones, style: "subheading" });
      content.push(pdfTable([t.milestones, t.schedule], projectMilestones.map((milestone) => [text(milestone, "name"), windowField(milestone, "finish") || "-"])));
      content.push({ text: t.tasks, style: "subheading" });
      content.push(pdfTable([t.tasks, t.status, t.assignees, t.schedule], projectTasks.map((task) => [
        text(task, "title"), text(task, "status"), strings(task.assignees).map((id) => peopleNames.get(id) ?? id).join(", ") || "-", taskSchedule(task),
      ])));
    }
    if (selected.has("gantt")) {
      content.push({ text: `${t.gantt}: ${text(project, "name")}`, style: "heading", pageBreak: "before" });
      content.push(renderGanttPdf(projectTasks, t.noData));
    }
  }
  const definition = {
    content,
    defaultStyle: { font: "Roboto", fontSize: 9 },
    pageOrientation: "landscape",
    pageMargins: [36, 42, 36, 42],
    styles: {
      title: { fontSize: 24, bold: true, color: "#173d2d", margin: [0, 0, 0, 8] },
      heading: { fontSize: 18, bold: true, color: "#245c42", margin: [0, 0, 0, 12] },
      subheading: { fontSize: 12, bold: true, margin: [0, 8, 0, 4] },
      tableGroup: { fontSize: 10, bold: true, color: "#33443b", margin: [0, 6, 0, 0] },
      meta: { fontSize: 8, color: "#647068", margin: [0, 0, 0, 18] },
    },
    footer: (currentPage: number, pageCount: number) => ({ text: `${currentPage} / ${pageCount}`, alignment: "center", fontSize: 8, color: "#647068" }),
    info: { title: t.title, subject: `GitPM ${snapshot.shortCommit}`, creationDate: new Date(snapshot.generatedAt) },
  };
  return await new Promise<Buffer>((resolve, reject) => {
    try { pdfMake.createPdf(definition).getBuffer(resolve); }
    catch (error) { reject(error); }
  });
}

async function filesystemEntries(rootInput: string, options: { readonly excludeGit: boolean; readonly prefix?: string }): Promise<ZipEntry[]> {
  const root = await realpath(rootInput);
  const entries: ZipEntry[] = [];
  const visit = async (absolute: string, relative: string): Promise<void> => {
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      if (options.excludeGit && entry.name === ".git") continue;
      const childRelative = relative === "" ? entry.name : `${relative}/${entry.name}`;
      const name = options.prefix ? `${options.prefix}/${childRelative}` : childRelative;
      const child = path.join(absolute, entry.name);
      const metadata = await lstat(child);
      if (metadata.isSymbolicLink()) {
        entries.push({ name, content: Buffer.from(await readlink(child), "utf8"), date: metadata.mtime, mode: 0o120777 });
      } else if (metadata.isDirectory()) {
        entries.push({ name, directory: true, date: metadata.mtime, mode: 0o40755 });
        await visit(child, childRelative);
      } else if (metadata.isFile()) {
        entries.push({ name, content: await readFile(child), date: metadata.mtime, mode: 0o100000 | (metadata.mode & 0o777) });
      }
    }
  };
  await visit(root, "");
  return entries;
}

async function runGit(args: readonly string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", args, {
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { if (stderr.length < 16_384) stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new ExportError("EXPORT_GIT_CLONE_FAILED", `Git exited with ${code}: ${stderr.trim()}`)));
  });
}

async function repositoryZip(root: string, includeGit: boolean): Promise<Buffer> {
  const workingEntries = await filesystemEntries(root, { excludeGit: true });
  if (!includeGit) return createZip(workingEntries);
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "gitpm-export-"));
  const clone = path.join(temporaryRoot, "repository");
  try {
    await runGit(["clone", "--no-hardlinks", "--no-checkout", "--", root, clone]);
    await runGit(["-C", clone, "read-tree", "HEAD"]);
    await runGit(["-C", clone, "remote", "remove", "origin"]);
    await rm(path.join(clone, ".git", "logs"), { recursive: true, force: true });
    const gitEntries = await filesystemEntries(path.join(clone, ".git"), { excludeGit: false, prefix: ".git" });
    return createZip([...workingEntries, { name: ".git", directory: true, mode: 0o40755 }, ...gitEntries]);
  } finally {
    const resolvedTemporaryRoot = path.resolve(temporaryRoot);
    if (resolvedTemporaryRoot.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolvedTemporaryRoot).startsWith("gitpm-export-")) {
      await rm(resolvedTemporaryRoot, { recursive: true, force: true });
    }
  }
}

export class ExportService {
  constructor(
    private readonly drafts: DraftManager,
    private readonly git: GitClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async snapshot(draftId: string, requireValidDocuments: boolean): Promise<ExportSnapshot> {
    const workspace = await this.drafts.getWorkspace(draftId);
    const history = await this.git.history(workspace.worktree_path, 1);
    const commit = history[0];
    if (commit === undefined) throw new ExportError("EXPORT_COMMIT_UNAVAILABLE", "Repository has no commit");
    let documents: readonly ExportDocument[] = [];
    if (requireValidDocuments) {
      const [discovery, validation] = await Promise.all([
        discoverRepositoryFiles(workspace.worktree_path),
        validateRepository(workspace.worktree_path),
      ]);
      const firstIssue = discovery.issues[0] ?? validation.errors[0];
      if (firstIssue !== undefined) {
        throw new ExportError("EXPORT_REPOSITORY_INVALID", `Repository validation failed: ${firstIssue.code} at ${firstIssue.path}`);
      }
      documents = await Promise.all(discovery.files.map(async (absolute): Promise<ExportDocument> => {
        const relative = path.relative(workspace.worktree_path, absolute).split(path.sep).join("/");
        return { path: relative, document: parseYamlDocument(await readFile(absolute, "utf8"), relative) };
      }));
    }
    return {
      commit: commit.commit,
      shortCommit: commit.commit.slice(0, 8),
      commitDate: commit.authored_at,
      generatedAt: this.now().toISOString(),
      root: workspace.worktree_path,
      documents,
    };
  }

  async create(draftId: string, request: ExportRequest): Promise<ExportArtifact> {
    if (!EXPORT_FORMATS.includes(request.format)) throw new ExportError("EXPORT_FORMAT_INVALID", `Unsupported export format ${String(request.format)}`);
    const locale = request.locale ?? "en";
    if (!["en", "ru"].includes(locale)) throw new ExportError("EXPORT_LOCALE_INVALID", `Unsupported export locale ${String(locale)}`);
    for (const section of request.sections ?? []) if (!EXPORT_SECTIONS.includes(section)) throw new ExportError("EXPORT_SECTION_INVALID", `Unsupported export section ${section}`);
    const snapshot = await this.snapshot(draftId, request.format !== "repository");
    const base = `gitpm-${slugDate(snapshot.commitDate)}-${snapshot.shortCommit}`;
    if (request.format === "pdf") {
      return { content: await renderPdf(snapshot, locale, sections(request)), content_type: "application/pdf", filename: `${base}-portfolio.pdf` };
    }
    if (request.format === "html") {
      return { content: renderHtml(snapshot, locale), content_type: "text/html; charset=utf-8", filename: `${base}-static.html` };
    }
    if (request.format === "csv") {
      const grouped = new Map<string, ExportDocument[]>();
      for (const document of snapshot.documents) (grouped.get(document.document.schema) ?? grouped.set(document.document.schema, []).get(document.document.schema)!).push(document);
      const entries = [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([schema, documents]) => ({
        name: `${schemaFileNames[schema] ?? schema.replaceAll(/[^a-z0-9-]+/giu, "-")}.csv`,
        content: Buffer.from(renderCsv(documents), "utf8"),
      }));
      return { content: createZip(entries), content_type: "application/zip", filename: `${base}-csv.zip` };
    }
    const includeGit = request.include_git ?? false;
    return {
      content: await repositoryZip(snapshot.root, includeGit),
      content_type: "application/zip",
      filename: `${base}-repository${includeGit ? "-with-git" : ""}.zip`,
    };
  }
}

export { createZip, type ZipEntry } from "./zip.js";
