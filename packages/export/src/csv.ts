import { SCHEMA_FILE_NAMES, type ExportDocument } from "./documents.js";
import type { ExportReportModel } from "./model.js";
import { createZip, type ZipEntry } from "./zip.js";

function csvValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  const raw = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]/u.test(raw) ? `"${raw.replaceAll('"', '""')}"` : raw;
}

function renderRawCsv(documents: readonly ExportDocument[]): string {
  const fields = [...new Set(documents.flatMap((item) => Object.keys(item.document)))].sort((left, right) => {
    const order = ["schema", "id", "project", "name", "title", "lifecycle"];
    const leftIndex = order.indexOf(left);
    const rightIndex = order.indexOf(right);
    return (leftIndex < 0 ? order.length : leftIndex) - (rightIndex < 0 ? order.length : rightIndex) || left.localeCompare(right);
  });
  return `\uFEFF${fields.map(csvValue).join(",")}\r\n${documents.map((item) => fields.map((field) => csvValue(item.document[field])).join(",")).join("\r\n")}\r\n`;
}

function renderRows(headers: readonly string[], rows: readonly (readonly unknown[])[]): string {
  return `\uFEFF${headers.map(csvValue).join(",")}\r\n${rows.map((row) => row.map(csvValue).join(",")).join("\r\n")}\r\n`;
}

export function renderCsvZip(model: ExportReportModel): Buffer {
  const grouped = new Map<string, ExportDocument[]>();
  for (const document of model.snapshot.documents) {
    (grouped.get(document.document.schema) ?? grouped.set(document.document.schema, []).get(document.document.schema)!).push(document);
  }
  const entries: ZipEntry[] = [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([schema, documents]) => ({
    name: `${SCHEMA_FILE_NAMES[schema] ?? schema.replaceAll(/[^a-z0-9-]+/giu, "-")}.csv`,
    content: Buffer.from(renderRawCsv(documents), "utf8"),
  }));
  if (model.portfolio !== undefined) {
    entries.push({
      name: "report-portfolio.csv",
      content: Buffer.from(renderRows(
        ["group", "id", "name", "status", "owner", "tasks", "milestones", "finish", "risk"],
        model.portfolio.groups.flatMap((group) => group.projects.map((project) => [group.title, project.id, project.name, project.statusTitle, project.ownerName, project.taskCount, project.milestoneCount, project.finish, project.riskLabel])),
      ), "utf8"),
    });
  }
  if (model.planFacts.length > 0) {
    entries.push({
      name: "report-plan-fact.csv",
      content: Buffer.from(renderRows(
        ["project", "task", "plan", "actual", "variance"],
        model.planFacts.flatMap((report) => report.rows.map((row) => [report.projectName, row.title.trim(), row.plan ?? "", row.actual, row.variance ?? ""])),
      ), "utf8"),
    });
  }
  if (model.workload !== undefined) {
    entries.push({
      name: "report-workload.csv",
      content: Buffer.from(renderRows(
        ["person", "week", "allocated_hours", "capacity_hours", "overload"],
        model.workload.rows.map((row) => [row.person_name, row.week, row.allocated_hours, row.capacity_hours, Math.max(0, row.allocated_hours - row.capacity_hours)]),
      ), "utf8"),
    });
  }
  if (model.vacations !== undefined) {
    entries.push({
      name: "report-vacations.csv",
      content: Buffer.from(renderRows(
        ["person", "kind", "state", "start", "finish"],
        model.vacations.events.map((event) => [event.person, event.kind, event.state, event.start, event.finish]),
      ), "utf8"),
    });
  }
  return createZip(entries);
}
