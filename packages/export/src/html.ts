import type { GanttModel } from "@gitpm/scheduling";
import { localizedNumber } from "./documents.js";
import type { ExportReportModel, ProjectPlanReport } from "./model.js";

function escapeHtml(value: unknown): string {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function renderGanttHtml(model: GanttModel | undefined, titles: ReadonlyMap<string, string>, scheduleById: ReadonlyMap<string, string>): string {
  if (model === undefined) return "";
  const dated = model.rows.filter((row) => row.bars.some((bar) => /^\d{4}-\d{2}-\d{2}$/u.test(bar.start) && /^\d{4}-\d{2}-\d{2}$/u.test(bar.finish)));
  if (dated.length === 0) return "";
  const day = (value: string) => Math.floor(Date.parse(`${value}T00:00:00Z`) / 86_400_000);
  const first = Math.min(...dated.flatMap((row) => row.bars.map((bar) => day(bar.start))));
  const last = Math.max(...dated.flatMap((row) => row.bars.map((bar) => day(bar.finish))));
  const span = Math.max(1, last - first + 1);
  return `<div class="gantt">${dated.map((row) => {
    const bars = row.bars.map((bar, index) => {
      const left = ((day(bar.start) - first) / span) * 100;
      const width = Math.max(1.5, ((day(bar.finish) - day(bar.start) + 1) / span) * 100);
      return `<i class="track-${escapeHtml(bar.track)}" title="${escapeHtml(bar.track)}: ${bar.start} - ${bar.finish}" style="left:${left.toFixed(3)}%;width:${width.toFixed(3)}%;top:${4 + index * 7}px"></i>`;
    }).join("");
    const actual = row.actual.map((segment) => `${segment.date}: ${segment.hours}h`).join(", ");
    return `<div class="gantt-row"><span>${escapeHtml(titles.get(row.id) ?? row.id)}</span><div class="gantt-track">${bars}</div><small>${escapeHtml(scheduleById.get(row.id) ?? "")}${actual === "" ? "" : `<br>${escapeHtml(actual)}`}</small></div>`;
  }).join("")}</div>`;
}

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) return "";
  return `<div class="table-wrap"><table><thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell, index) => index === 0 ? `<th>${escapeHtml(cell)}</th>` : `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

function projectSection(plan: ProjectPlanReport, model: ExportReportModel): string {
  const t = model.labels;
  const board = plan.board.map((column) => `<section><h4>${escapeHtml(column.status)}</h4>${column.titles.map((title) => `<article><strong>${escapeHtml(title)}</strong></article>`).join("")}</section>`).join("");
  const titles = new Map(plan.tasks.map((task) => [task.id, task.title.trim()]));
  const schedules = new Map(plan.tasks.map((task) => [task.id, task.schedule]));
  return `<section class="page project-detail" id="project-${escapeHtml(plan.id)}"><header><span>${escapeHtml(plan.id)}</span><h2>${escapeHtml(plan.name)}</h2><p>${escapeHtml(plan.description)}</p></header><h3>${escapeHtml(t.milestones)}</h3><ul>${plan.milestones.map((milestone) => `<li><strong>${escapeHtml(milestone.name)}</strong> · ${escapeHtml(milestone.finish)}</li>`).join("") || `<li>${escapeHtml(t.noData)}</li>`}</ul><h3>${escapeHtml(t.tasks)}</h3>${table([t.tasks, t.status, t.assignees, t.schedule, t.actual], plan.tasks.map((task) => [task.title, task.statusTitle, task.assignees, task.schedule, task.actual]))}<h3>${escapeHtml(t.board)}</h3><div class="board">${board}</div><h3>${escapeHtml(t.gantt)}</h3>${renderGanttHtml(plan.gantt, titles, schedules) || `<p>${escapeHtml(t.noData)}</p>`}</section>`;
}

export function renderHtml(model: ExportReportModel): Buffer {
  const t = model.labels;
  const locale = model.options.locale;
  const navigation: readonly (readonly [string, string])[] = [
    ...(model.portfolio !== undefined ? [["projects", t.projects], ["people", t.people]] as const : []),
    ...(model.workload !== undefined ? [["workload", t.workload]] as const : []),
    ...(model.vacations !== undefined ? [["vacations", t.vacations]] as const : []),
    ...(model.planFacts.length > 0 ? [["plan-fact", t.planFact]] as const : []),
    ...(model.profiles.length > 0 ? [["profiles", t.personProfile]] as const : []),
    ...(model.audit !== undefined ? [["audit", t.audit]] as const : []),
    ...model.projectPlans.map((plan) => [`project-${plan.id}`, plan.name] as const),
  ];
  const projectCards = model.portfolio?.groups.flatMap((group) => group.projects.map((project) => `<article><h3><a href="#project-${escapeHtml(project.id)}">${escapeHtml(project.name)}</a></h3><dl><div><dt>${escapeHtml(t.status)}</dt><dd>${escapeHtml(project.statusTitle)}</dd></div><div><dt>${escapeHtml(t.owner)}</dt><dd>${escapeHtml(project.ownerName)}</dd></div></dl><p>${escapeHtml(project.description)}</p></article>`)).join("") ?? "";
  const peopleHeaders = model.options.includeEmail
    ? [t.people, t.email, t.hoursPerWeek, t.projects]
    : [t.people, t.hoursPerWeek, t.projects];
  const peopleRows = (model.portfolio?.people ?? []).map((person) => (
    model.options.includeEmail
      ? [person.name, person.email || "—", person.capacity, person.projects]
      : [person.name, person.capacity, person.projects]
  ));
  const hours = (value: number | undefined) => value === undefined ? "—" : localizedNumber(locale, value);
  const html = `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(model.options.reportTitle)}</title><style>
*{box-sizing:border-box}body{margin:0;background:#f4f5f1;color:#27322c;font:14px/1.5 system-ui,sans-serif}a{color:#245c42}aside{position:fixed;inset:0 auto 0 0;width:230px;overflow:auto;background:#173d2d;color:#fff;padding:24px 18px}aside h1{font-size:20px}aside a{display:block;color:#dce9e1;text-decoration:none;padding:7px 0}main{margin-left:230px;padding:32px;max-width:1500px}.meta{color:#647068}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:16px}article,.page,table,.board section{background:#fff;border:1px solid #d9ddd6;border-radius:10px;padding:16px}dl div{display:flex;gap:8px}dt{font-weight:700}.table-wrap{width:100%;overflow:auto}table{width:100%;border-collapse:collapse;margin:12px 0;min-width:480px}th,td{text-align:left;border-bottom:1px solid #e3e6e0;padding:8px}.page{margin:28px 0}.board{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}.board article{margin:8px 0;padding:10px}.board small{display:block}.gantt{overflow:auto}.gantt-row{display:grid;grid-template-columns:minmax(8rem,12rem) minmax(16rem,1fr) minmax(8rem,12rem);align-items:center;gap:10px;margin:8px 0}.gantt-track{position:relative;height:26px;background:repeating-linear-gradient(90deg,#edf0ea 0,#edf0ea calc(10% - 1px),#d7ddd5 10%)}.gantt-track i{position:absolute;top:4px;height:18px;border-radius:5px;background:#327454}@media(max-width:760px){aside{position:static;width:auto}main{margin:0;padding:18px}.gantt-row{grid-template-columns:minmax(6rem,8rem) minmax(12rem,1fr) minmax(6rem,8rem)}table{min-width:100%}}@media print{aside{display:none}main{margin:0;padding:0}.page{break-before:page}}
</style></head><body><aside><h1>${escapeHtml(model.options.reportTitle)}</h1>${navigation.map(([id, label]) => `<a href="#${escapeHtml(id)}">${escapeHtml(label)}</a>`).join("")}<p>${escapeHtml(t.commit)}: <code>${escapeHtml(model.snapshot.shortCommit)}</code></p></aside><main><header><h1>${escapeHtml(model.options.reportTitle)}</h1><p class="meta">${escapeHtml(t.commit)}: ${escapeHtml(model.snapshot.commit)} · ${escapeHtml(t.generated)}: ${escapeHtml(model.snapshot.generatedAt)}</p></header>
${model.portfolio !== undefined ? `<section id="projects"><h2>${escapeHtml(t.projects)}</h2><div class="grid">${projectCards || `<p>${escapeHtml(t.noData)}</p>`}</div></section><section id="people"><h2>${escapeHtml(t.people)}</h2>${table(peopleHeaders, peopleRows)}</section>` : ""}
${model.workload !== undefined ? `<section id="workload" class="page"><h2>${escapeHtml(t.workload)}</h2>${table([t.person, t.week, t.allocated, t.available], model.workload.rows.map((row) => [row.person_name, row.week, hours(row.allocated_hours), hours(row.capacity_hours)]))}</section>` : ""}
${model.vacations !== undefined ? `<section id="vacations" class="page"><h2>${escapeHtml(t.vacations)}</h2><p>${escapeHtml(t.absentToday)}: ${model.vacations.summary.absentToday} · ${escapeHtml(t.leavingSoon)}: ${model.vacations.summary.leavingSoon} · ${escapeHtml(t.overlap)}: ${model.vacations.summary.maxOverlap}</p>${table([t.person, t.kind, t.state, t.schedule], model.vacations.events.map((event) => [event.person, event.kind, event.state, `${event.start} - ${event.finish}`]))}${table([t.person, t.taken, t.planned, t.remaining, t.allowance], model.vacations.balances.map((row) => [row.person, String(row.taken), String(row.planned), String(row.remaining), String(row.allowance)]))}</section>` : ""}
${model.planFacts.length > 0 ? `<section id="plan-fact" class="page"><h2>${escapeHtml(t.planFact)}</h2>${model.planFacts.map((report) => `<article><h3>${escapeHtml(report.projectName)}</h3><p>${escapeHtml(t.track)}: ${escapeHtml(report.trackTitle)} · ${escapeHtml(t.plan)}: ${hours(report.plan)} · ${escapeHtml(t.actual)}: ${hours(report.actual)}</p>${table([t.tasks, t.plan, t.actual, t.variance], report.rows.map((row) => [row.title, hours(row.plan), hours(row.actual), hours(row.variance)]))}</article>`).join("")}</section>` : ""}
${model.profiles.length > 0 ? `<section id="profiles" class="page"><h2>${escapeHtml(t.personProfile)}</h2>${model.profiles.map((profile) => `<article><h3>${escapeHtml(profile.name)}</h3><p>${escapeHtml(t.teams)}: ${escapeHtml(profile.teams)} · ${escapeHtml(profile.capacity)}</p>${table([t.tasks, t.projects, t.schedule], profile.tasks.map((task) => [task.title, task.project, task.schedule]))}</article>`).join("")}</section>` : ""}
${model.audit !== undefined ? `<section id="audit" class="page"><h2>${escapeHtml(t.audit)}</h2>${table([t.history, t.author, t.subject], model.audit.history.map((item) => [item.commit, item.author, item.subject]))}</section>` : ""}
${model.projectPlans.map((plan) => projectSection(plan, model)).join("")}
</main></body></html>`;
  return Buffer.from(html, "utf8");
}
