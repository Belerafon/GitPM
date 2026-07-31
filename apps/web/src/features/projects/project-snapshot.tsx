import { useEffect, useState } from "react";
import { buildSchedulingReadModel, finishVarianceDays } from "@gitpm/scheduling";
import { actualWindow, hoursAfterDate, sumHours } from "@gitpm/time-entries";
import { formatDateOnly, message, type Locale, type MessageKey } from "../../i18n.js";
import type { GitPmApi } from "../../api.js";
import type { DraftStatus, EntityDocument, EntityResult } from "../../types.js";
import type { ScheduleResolver } from "../../schedules.js";

export function ProjectSnapshot({ project, locale, api, draft, tasks, scheduling, comparisonTrack }: { readonly project: EntityDocument; readonly locale: Locale; readonly api?: GitPmApi; readonly draft?: DraftStatus; readonly tasks?: readonly EntityResult[]; readonly scheduling: ScheduleResolver; readonly comparisonTrack?: string }) {
  const primaryTrack = scheduling.primaryTrack(project.planning);
  const comparison = comparisonTrack ?? scheduling.comparisonTrack(project.planning);
  const readModel = buildSchedulingReadModel(project, (tasks ?? []).map((task) => task.document), [...new Set([primaryTrack, comparison].filter((track): track is string => track !== undefined && track !== ""))]);
  const primaryFinish = primaryTrack === "" ? undefined : readModel.tracks.find((track) => track.track === primaryTrack)?.effective?.finish;
  const comparisonFinish = comparison === undefined ? undefined : readModel.tracks.find((track) => track.track === comparison)?.effective?.finish;
  const [actual, setActual] = useState<{ total: number; lastActivity?: string; hoursAfter?: number; byDate: readonly { readonly date: string; readonly hours: number }[] } | null>(null);

  useEffect(() => {
    if (api === undefined || draft === undefined) { setActual(null); return; }
    let active = true;
    void (async () => {
      try {
        const records = (await api.listProjectTimeEntries(draft.draft_id, String(project.id), { limit: 200 })).items.map((entry) => ({
          id: entry.document.id, project: String(project.id), task: entry.document.task, person: entry.document.person,
          performed_on: entry.document.performed_on, hours: entry.document.hours, category: entry.document.category, state: entry.document.state,
        }));
        if (!active) return;
        const window = actualWindow(records);
        const byDate = new Map<string, number>();
        for (const record of records) if (record.state === "active") byDate.set(record.performed_on, (byDate.get(record.performed_on) ?? 0) + record.hours);
        setActual({
          total: sumHours(records),
          lastActivity: window?.finish,
          hoursAfter: comparisonFinish !== undefined ? hoursAfterDate(records, comparisonFinish) : undefined,
          byDate: [...byDate.entries()].map(([date, hours]) => ({ date, hours })).sort((left, right) => right.date.localeCompare(left.date)),
        });
      } catch {
        if (active) setActual(null);
      }
    })();
    return () => { active = false; };
  }, [api, draft, project.id, comparisonFinish]);

  if (primaryFinish === undefined && comparisonFinish === undefined && actual === null) return null;
  const variance = primaryFinish !== undefined && comparisonFinish !== undefined ? finishVarianceDays(primaryFinish, comparisonFinish) : undefined;
  const t = (key: MessageKey, values?: Readonly<Record<string, string | number>>) => message(locale, key, values);
  return (
    <section className="card project-snapshot">
      <h3>{t("snapshot.heading")}</h3>
      <dl>
        {primaryFinish !== undefined && <div><dt>{t("snapshot.primaryFinish")}</dt><dd>{formatDateOnly(locale, primaryFinish)}</dd></div>}
        {comparison !== undefined && comparisonFinish !== undefined && <div><dt>{t("snapshot.comparisonFinish")}</dt><dd>{formatDateOnly(locale, comparisonFinish)}</dd></div>}
        {variance !== undefined && <div><dt>{t("snapshot.variance")}</dt><dd data-variance={variance}>{variance === 0 ? t("snapshot.onTime") : variance > 0 ? `+${variance} d` : `${variance} d`}</dd></div>}
        {actual !== null && <>
          <div><dt>{t("snapshot.actualHours")}</dt><dd>{actual.total}</dd></div>
          {actual.lastActivity !== undefined && <div><dt>{t("timeEffort.lastActivity")}</dt><dd>{formatDateOnly(locale, actual.lastActivity)}</dd></div>}
          {actual.hoursAfter !== undefined && comparisonFinish !== undefined && <div><dt>{t("snapshot.hoursAfter", { date: comparisonFinish })}</dt><dd>{actual.hoursAfter}</dd></div>}
        </>}
      </dl>
      {actual !== null && <section className="actual-hours-report"><h4>{t("snapshot.actualReport")}</h4><ul>{actual.byDate.map((item) => <li key={item.date}><time dateTime={item.date}>{formatDateOnly(locale, item.date)}</time><strong>{item.hours} h</strong></li>)}</ul></section>}
    </section>
  );
}
