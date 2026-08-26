import { createZip, type ZipEntry } from "./zip.js";
import type { ExportReportModel } from "./model.js";

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function sheetXml(rows: readonly (readonly unknown[])[]): string {
  const cells = rows.map((row, rowIndex) => {
    const items = row.map((value, columnIndex) => {
      const ref = `${String.fromCharCode(65 + columnIndex)}${rowIndex + 1}`;
      if (typeof value === "number" && Number.isFinite(value)) return `<c r="${ref}"><v>${value}</v></c>`;
      return `<c r="${ref}" t="inlineStr"><is><t>${xml(String(value ?? ""))}</t></is></c>`;
    }).join("");
    return `<row r="${rowIndex + 1}">${items}</row>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${cells}</sheetData></worksheet>`;
}

export function renderXlsx(model: ExportReportModel): Buffer {
  const sheets: { readonly name: string; readonly rows: readonly (readonly unknown[])[] }[] = [];
  if (model.portfolio !== undefined) {
    sheets.push({
      name: "Portfolio",
      rows: [
        ["group", "id", "name", "status", "owner", "tasks", "milestones", "finish", "risk"],
        ...model.portfolio.groups.flatMap((group) => group.projects.map((project) => [group.title, project.id, project.name, project.statusTitle, project.ownerName, project.taskCount, project.milestoneCount, project.finish, project.riskLabel])),
      ],
    });
    sheets.push({
      name: "People",
      rows: [["id", "name", "projects", "teams", "capacity", "calendar"], ...model.portfolio.people.map((person) => [person.id, person.name, person.projects, person.teams, person.capacity, person.calendar])],
    });
  }
  if (model.planFacts.length > 0) {
    sheets.push({
      name: "Plan-fact",
      rows: [
        ["project", "task", "plan", "actual", "variance"],
        ...model.planFacts.flatMap((report) => report.rows.map((row) => [report.projectName, row.title.trim(), row.plan ?? "", row.actual, row.variance ?? ""])),
      ],
    });
  }
  if (model.workload !== undefined) {
    sheets.push({
      name: "Workload",
      rows: [["person", "week", "allocated", "capacity", "overload"], ...model.workload.rows.map((row) => [row.person_name, row.week, row.allocated_hours, row.capacity_hours, Math.max(0, row.allocated_hours - row.capacity_hours)])],
    });
  }
  if (model.vacations !== undefined) {
    sheets.push({
      name: "Vacations",
      rows: [["person", "kind", "state", "start", "finish"], ...model.vacations.events.map((event) => [event.person, event.kind, event.state, event.start, event.finish])],
    });
  }
  if (sheets.length === 0) sheets.push({ name: "Export", rows: [["report"], [model.options.reportTitle]] });
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((sheet, index) => `<sheet name="${xml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}</sheets></workbook>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("")}</Relationships>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`;
  const entries: ZipEntry[] = [
    { name: "[Content_Types].xml", content: Buffer.from(contentTypes, "utf8") },
    { name: "_rels/.rels", content: Buffer.from(rootRels, "utf8") },
    { name: "xl/workbook.xml", content: Buffer.from(workbook, "utf8") },
    { name: "xl/_rels/workbook.xml.rels", content: Buffer.from(rels, "utf8") },
    ...sheets.map((sheet, index) => ({ name: `xl/worksheets/sheet${index + 1}.xml`, content: Buffer.from(sheetXml(sheet.rows), "utf8") })),
  ];
  return createZip(entries);
}
