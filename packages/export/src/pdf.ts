import type { GanttModel } from "@gitpm/scheduling";
import pdfMake from "pdfmake/build/pdfmake.js";
import pdfFonts from "pdfmake/build/vfs_fonts.js";
import { localizedNumber } from "./documents.js";
import type { ExportReportModel, PlanFactReport, ProjectPlanReport } from "./model.js";

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
      dontBreakRows: true,
      keepWithHeaderRows: 1,
      widths,
      body: [header.map((value) => ({ text: value, bold: true, color: "#33443b", fillColor: "#edf2ee" })), ...rows],
    },
    margin: [0, 6, 0, 12],
  };
}

function summaryMetrics(items: readonly { readonly label: string; readonly value: number }[]): unknown {
  return {
    columns: items.map((item) => ({
      width: "*",
      stack: [
        { text: String(item.value), fontSize: 16, bold: true, color: "#173d2d" },
        { text: item.label, fontSize: 7, color: "#647068" },
      ],
      margin: [8, 6, 8, 6],
    })),
    columnGap: 8,
    margin: [0, 0, 0, 10],
  };
}

function heading(text: string, pageBreak: boolean): unknown {
  return { text, style: "heading", ...(pageBreak ? { pageBreak: "before" } : {}) };
}

function renderGanttPdf(model: GanttModel | undefined, titles: ReadonlyMap<string, string>, trackNames: ReadonlyMap<string, string>, _noData: string): unknown | undefined {
  if (model === undefined) return undefined;
  const dated = model.rows.flatMap((row) => row.bars.map((bar) => ({ ...bar, id: row.id, actual: row.actual }))).filter((bar) =>
    /^\d{4}-\d{2}-\d{2}$/u.test(bar.start)
    && /^\d{4}-\d{2}-\d{2}$/u.test(bar.finish)
    && Date.parse(`${bar.start}T00:00:00Z`) <= Date.parse(`${bar.finish}T00:00:00Z`),
  );
  if (dated.length === 0) return undefined;
  const day = (value: string) => Math.floor(Date.parse(`${value}T00:00:00Z`) / 86_400_000);
  const first = Math.min(...dated.map((bar) => day(bar.start)));
  const last = Math.max(...dated.map((bar) => day(bar.finish)));
  const total = Math.max(1, last - first + 1);
  const chartWidth = 360;
  const isoDay = (value: number) => new Date(value * 86_400_000).toISOString().slice(0, 10);
  const rows: unknown[] = [{
    columns: [
      { text: "", width: 150 },
      { text: `${isoDay(first)} - ${isoDay(last)}`, width: chartWidth, fontSize: 8, color: "#647068" },
    ],
    margin: [0, 0, 0, 5],
  }];
  const seen = new Set<string>();
  for (const bar of dated) {
    const left = ((day(bar.start) - first) / total) * chartWidth;
    const width = Math.max(3, ((day(bar.finish) - day(bar.start) + 1) / total) * chartWidth);
    const key = `${bar.id}:${bar.track}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const actualRects = bar.actual.flatMap((segment) => {
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(segment.date)) return [];
      const x = ((day(segment.date) - first) / total) * chartWidth;
      return [{ type: "rect", x, y: 2, w: Math.max(2, chartWidth / total), h: 12, color: "#c47b2b" }];
    });
    rows.push({
      unbreakable: true,
      columns: [
        { text: `${titles.get(bar.id) ?? bar.id} (${trackNames.get(bar.track) ?? bar.track})`, width: 150, fontSize: 8, margin: [0, 3, 6, 0] },
        {
          width: chartWidth,
          stack: [
            { canvas: [
              { type: "rect", x: 0, y: 2, w: chartWidth, h: 12, color: "#edf0ea" },
              { type: "rect", x: left, y: 2, w: width, h: 12, r: 2, color: "#327454" },
              ...actualRects,
            ] },
            { text: `${bar.start} - ${bar.finish}`, fontSize: 7, color: "#647068", margin: [0, 1, 0, 0] },
          ],
        },
      ],
      margin: [0, 0, 0, 5],
    });
  }
  return { stack: rows };
}

function planFactBlock(report: PlanFactReport, model: ExportReportModel): unknown[] {
  const t = model.labels;
  const locale = model.options.locale;
  const hours = (value: number | undefined) => value === undefined ? "-" : localizedNumber(locale, value);
  return [
    { text: `${t.planFact}: ${report.projectName}`, style: "subheading" },
    { text: `${t.track}: ${report.trackTitle} · ${t.plan}: ${hours(report.plan)} · ${t.actual}: ${hours(report.actual)} · ${t.variance}: ${hours(report.variance)}`, style: "meta", margin: [0, 0, 0, 6] },
    pdfTable(
      [t.tasks, t.plan, t.actual, t.variance],
      report.rows.map((row) => [row.title, hours(row.plan), hours(row.actual), hours(row.variance)]),
      [260, 80, 80, 80],
    ),
    pdfTable([t.people, t.hours], report.byPerson.map((item) => [item.label, hours(item.hours)]), [300, 80]),
    pdfTable([t.category, t.hours], report.byCategory.map((item) => [item.label, hours(item.hours)]), [300, 80]),
  ];
}

function projectPlanBlock(plan: ProjectPlanReport, model: ExportReportModel, pageBreak: boolean): unknown[] {
  const t = model.labels;
  const content: unknown[] = [
    heading(plan.name, pageBreak),
    { text: plan.description || "-", margin: [0, 4, 0, 10] },
    { text: t.milestones, style: "subheading" },
    pdfTable([t.milestones, t.schedule], plan.milestones.map((milestone) => [milestone.name, milestone.finish])),
    { text: t.tasks, style: "subheading" },
    pdfTable(
      [t.tasks, t.status, t.assignees, t.schedule, t.actual],
      plan.tasks.map((task) => [task.title, task.statusTitle, task.assignees, task.schedule, task.actual]),
    ),
  ];
  if (plan.archive.length > 0 && model.options.lifecycle !== "active") {
    content.push({ text: t.archived, style: "subheading" });
    content.push(pdfTable(
      [t.tasks, t.status, t.assignees, t.schedule, t.actual],
      plan.archive.map((task) => [task.title, task.statusTitle, task.assignees, task.schedule, task.actual]),
    ));
  }
  if (model.options.includeLegacyGantt) {
    const gantt = renderGanttPdf(
      plan.gantt,
      new Map(plan.tasks.map((task) => [task.id, task.title.trim()])),
      new Map(plan.gantt?.rows.flatMap((row) => row.bars.map((bar) => [bar.track, trackTitleFromModel(model, plan.id, bar.track)])) ?? []),
      t.noData,
    );
    if (gantt !== undefined) {
      content.push({ text: t.gantt, style: "subheading" });
      content.push(gantt);
    }
  }
  return content;
}

function trackTitleFromModel(model: ExportReportModel, projectId: string, slug: string): string {
  return slug;
}

export async function renderPdf(model: ExportReportModel): Promise<Buffer> {
  pdfMake.vfs = pdfFonts;
  const t = model.labels;
  const options = model.options;
  const content: unknown[] = [
    { text: options.reportTitle, style: "title" },
    { text: `${t.commit}: ${model.snapshot.shortCommit} · ${t.generated}: ${model.snapshot.generatedAt}`, style: "meta" },
  ];
  if (model.portfolio !== undefined) {
    if (options.includeLegacyProjects) {
      content.push(heading(t.projects, false));
      content.push(summaryMetrics(model.portfolio.metrics));
      if (model.portfolio.groups.length === 0) content.push({ text: t.noData });
      for (const group of model.portfolio.groups) {
        content.push({ text: `${group.title} (${group.projects.length})`, style: "tableGroup" });
        content.push(pdfTable(
          [t.projects, t.status, t.owner, t.tasks, t.milestones, t.due, t.risk],
          group.projects.map((project) => {
            const projectCell: Readonly<Record<string, unknown>> = {
              stack: [
                { text: project.name, bold: true },
                ...(options.includeIds ? [{ text: project.id, fontSize: 6.5, color: "#727a75" }] : []),
                ...(project.description === "" ? [] : [{ text: project.description, fontSize: 7, color: "#647068" }]),
              ],
            };
            return [projectCell, project.statusTitle, project.ownerName, String(project.taskCount), String(project.milestoneCount), project.finishLabel, project.riskLabel];
          }),
          [172, 72, 105, 42, 48, 70, 68],
        ));
      }
    }
    if (options.includeLegacyPeople) {
      content.push(heading(t.people, content.length > 3));
      content.push(pdfTable(
        [t.person, t.projects, t.teams, t.capacity, t.calendar],
        model.portfolio.people.map((person) => [
          { stack: [
            { text: person.name, bold: true },
            ...(options.includeIds ? [{ text: person.id, fontSize: 6.5, color: "#727a75" }] : []),
            ...(person.email === "" ? [] : [{ text: person.email, fontSize: 7, color: "#647068" }]),
          ] },
          person.projects,
          person.teams,
          person.capacity,
          person.calendar,
        ]),
        [130, 210, 110, 92, 128],
      ));
    }
  }
  for (const [index, plan] of model.projectPlans.entries()) {
    if (options.includeLegacyDetails) content.push(...projectPlanBlock(plan, model, true));
    else if (options.includeLegacyGantt) {
      const gantt = renderGanttPdf(plan.gantt, new Map(plan.tasks.map((task) => [task.id, task.title.trim()])), new Map(), t.noData);
      if (gantt !== undefined) {
        content.push(heading(`${t.gantt}: ${plan.name}`, index === 0 || options.includeLegacyDetails));
        content.push(gantt);
      }
    }
  }
  if (model.planFacts.length > 0) {
    content.push(heading(t.planFact, true));
    for (const report of model.planFacts) content.push(...planFactBlock(report, model));
  }
  if (model.workload !== undefined) {
    content.push(heading(t.workload, true));
    content.push(summaryMetrics([
      { label: t.tasks, value: model.workload.included_tasks },
      { label: t.archived, value: model.workload.exclusions.archived },
      { label: t.undated, value: model.workload.exclusions.undated },
      { label: t.unestimated, value: model.workload.exclusions.unestimated },
    ]));
    content.push(pdfTable(
      [t.person, t.week, t.allocated, t.available, t.overload],
      model.workload.rows.map((row) => [
        row.person_name,
        row.week,
        localizedNumber(options.locale, row.allocated_hours),
        localizedNumber(options.locale, row.capacity_hours),
        row.allocated_hours > row.capacity_hours ? localizedNumber(options.locale, row.allocated_hours - row.capacity_hours) : "-",
      ]),
    ));
  }
  if (model.vacations !== undefined) {
    content.push(heading(t.vacations, true));
    content.push(summaryMetrics([
      { label: t.absentToday, value: model.vacations.summary.absentToday },
      { label: t.leavingSoon, value: model.vacations.summary.leavingSoon },
      { label: t.overlap, value: model.vacations.summary.maxOverlap },
    ]));
    content.push(pdfTable(
      [t.person, t.kind, t.state, t.schedule, t.note],
      model.vacations.events.map((event) => [event.person, event.kind, event.state, `${event.start} - ${event.finish}`, event.note || "-"]),
    ));
    content.push(pdfTable(
      [t.person, t.taken, t.planned, t.remaining, t.allowance],
      model.vacations.balances.map((row) => [row.person, String(row.taken), String(row.planned), String(row.remaining), String(row.allowance)]),
    ));
  }
  for (const [index, profile] of model.profiles.entries()) {
    content.push(heading(`${t.personProfile}: ${profile.name}`, index === 0));
    content.push({ text: `${t.teams}: ${profile.teams} · ${t.capacity}: ${profile.capacity} · ${t.calendar}: ${profile.calendar}`, style: "meta" });
    if (profile.balance !== undefined) {
      content.push({ text: `${t.allowance}: ${profile.balance.allowance} · ${t.taken}: ${profile.balance.taken} · ${t.planned}: ${profile.balance.planned} · ${t.remaining}: ${profile.balance.remaining}`, margin: [0, 0, 0, 8] });
    }
    content.push(pdfTable([t.tasks, t.projects, t.schedule], profile.tasks.map((task) => [task.title, task.project, task.schedule])));
    content.push(pdfTable([t.kind, t.state, t.schedule], profile.absences.map((event) => [event.kind, event.state, `${event.start} - ${event.finish}`])));
  }
  if (model.audit !== undefined) {
    content.push(heading(t.audit, true));
    content.push(pdfTable([t.status, "ID", t.projects], model.audit.archived.map((item) => [item.type, item.id, item.name])));
    content.push(pdfTable([t.voided, t.tasks, t.person, t.date, t.hours], model.audit.voided.map((item) => [item.id, item.task, item.person, item.date, String(item.hours)])));
    content.push(pdfTable([t.history, t.author, t.subject], model.audit.history.map((item) => [item.commit, item.author, item.subject])));
    if (options.includeComments) {
      content.push(pdfTable([t.comments, t.tasks, t.author], model.audit.comments.map((item) => [item.body, item.task, item.author])));
    }
  }
  const definition = {
    content,
    defaultStyle: { font: "Roboto", fontSize: 9 },
    pageOrientation: "landscape",
    pageSize: options.pageSize,
    pageMargins: [36, 36, 36, 48],
    tagged: true,
    displayTitle: true,
    language: options.locale === "ru" ? "ru-RU" : "en-US",
    styles: {
      title: { fontSize: 20, bold: true, color: "#173d2d", margin: [0, 0, 0, 6] },
      heading: { fontSize: 16, bold: true, color: "#245c42", margin: [0, 0, 0, 10] },
      subheading: { fontSize: 11, bold: true, margin: [0, 8, 0, 4] },
      tableGroup: { fontSize: 10, bold: true, color: "#33443b", margin: [0, 6, 0, 0] },
      meta: { fontSize: 8, color: "#647068", margin: [0, 0, 0, 12] },
    },
    footer: (currentPage: number, pageCount: number) => ({
      margin: [36, 0, 36, 16],
      text: `${currentPage} / ${pageCount}`,
      alignment: "center",
      fontSize: 8,
      color: "#647068",
    }),
    info: { title: options.reportTitle, subject: `GitPM ${model.snapshot.shortCommit}`, creationDate: new Date(model.snapshot.generatedAt) },
  };
  return await new Promise<Buffer>((resolve, reject) => {
    try { pdfMake.createPdf(definition).getBuffer(resolve); }
    catch (error) { reject(error); }
  });
}
