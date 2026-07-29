import { useEffect, useState } from "react";
import { actualWindow, hoursAfterDate, sumHours } from "@gitpm/time-entries";
import { formatDateOnly, message, type Locale, type MessageKey } from "../../i18n.js";
import type { GitPmApi } from "../../api.js";
import type { DraftStatus, EntityDocument, EntityResult } from "../../types.js";
import type { ScheduleResolver } from "../../schedules.js";

const DAY_MS = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

function finishOf(document: EntityDocument, track: string | undefined): string | undefined {
  if (track === undefined || track === "") return undefined;
  const finish = (document.schedules as Readonly<Record<string, { readonly finish?: string }>> | undefined)?.[track]?.finish;
  return typeof finish === "string" && ISO_DATE.test(finish) ? finish : undefined;
}

function varianceDays(primary: string, comparison: string): number {
  return Math.round((Date.parse(`${primary}T00:00:00Z`) - Date.parse(`${comparison}T00:00:00Z`)) / DAY_MS);
}

export function ProjectSnapshot({ project, locale, api, draft, tasks, scheduling, comparisonTrack }: { readonly project: EntityDocument; readonly locale: Locale; readonly api?: GitPmApi; readonly draft?: DraftStatus; readonly tasks?: readonly EntityResult[]; readonly scheduling: ScheduleResolver; readonly comparisonTrack?: string }) {
  const primaryTrack = scheduling.primaryTrack(project.planning);
  const comparison = comparisonTrack ?? scheduling.comparisonTrack(project.planning);
  const primaryFinish = finishOf(project, primaryTrack);
  const comparisonFinish = finishOf(project, comparison);
  const [actual, setActual] = useState<{ total: number; lastActivity?: string; hoursAfter?: number } | null>(null);

  useEffect(() => {
    if (api === undefined || draft === undefined || tasks === undefined || tasks.length === 0) { setActual(null); return; }
    let active = true;
    void (async () => {
      try {
        const records = (await Promise.all(tasks.map(async (task) => (await api.listTimeEntries(draft.draft_id, String(project.id), String(task.document.id))).map((entry) => ({
          id: entry.document.id, project: String(project.id), task: String(task.document.id), person: entry.document.person,
          performed_on: entry.document.performed_on, hours: entry.document.hours, category: entry.document.category, state: entry.document.state,
        }))))).flat();
        if (!active) return;
        const window = actualWindow(records);
        setActual({
          total: sumHours(records),
          lastActivity: window?.finish,
          hoursAfter: comparisonFinish !== undefined ? hoursAfterDate(records, comparisonFinish) : undefined,
        });
      } catch {
        if (active) setActual(null);
      }
    })();
    return () => { active = false; };
  }, [api, draft, project.id, tasks, comparisonFinish]);

  if (primaryFinish === undefined && comparisonFinish === undefined && actual === null) return null;
  const variance = primaryFinish !== undefined && comparisonFinish !== undefined ? varianceDays(primaryFinish, comparisonFinish) : undefined;
  const t = (key: MessageKey, values?: Readonly<Record<string, string | number>>) => message(locale, key, values);
  return (
    <section className="card project-snapshot">
      <h3>{t("snapshot.heading")}</h3>
      <dl>
        {primaryFinish !== undefined && <div><dt>{t("snapshot.primaryFinish")}</dt><dd>{formatDateOnly(locale, primaryFinish)}</dd></div>}
        {comparison !== undefined && comparisonFinish !== undefined && <div><dt>{t("snapshot.comparisonFinish")}</dt><dd>{formatDateOnly(locale, comparisonFinish)}</dd></div>}
        {variance !== undefined && <div><dt>{t("snapshot.variance")}</dt><dd data-variance={variance}>{variance === 0 ? t("snapshot.onTime") : variance > 0 ? `+${variance} d` : `${variance} d`}</dd></div>}
        {actual !== null && <>
          <div><dt>{t("snapshot.actualHours")}</dt><dd>{actual.total || "—"}</dd></div>
          {actual.lastActivity !== undefined && <div><dt>{t("timeEffort.lastActivity")}</dt><dd>{formatDateOnly(locale, actual.lastActivity)}</dd></div>}
          {actual.hoursAfter !== undefined && comparisonFinish !== undefined && <div><dt>{t("snapshot.hoursAfter", { date: comparisonFinish })}</dt><dd>{actual.hoursAfter}</dd></div>}
        </>}
      </dl>
    </section>
  );
}
