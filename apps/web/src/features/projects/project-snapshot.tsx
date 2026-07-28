import { formatDateOnly, type Locale } from "../../i18n.js";
import type { EntityDocument } from "../../types.js";

const DAY_MS = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

function finishOf(document: EntityDocument, track: string | undefined): string | undefined {
  if (track === undefined) return undefined;
  const finish = (document.schedules as Readonly<Record<string, { readonly finish?: string }>> | undefined)?.[track]?.finish;
  return typeof finish === "string" && ISO_DATE.test(finish) ? finish : undefined;
}

function varianceDays(primary: string, comparison: string): number {
  return Math.round((Date.parse(`${primary}T00:00:00Z`) - Date.parse(`${comparison}T00:00:00Z`)) / DAY_MS);
}

export function ProjectSnapshot({ project, locale, comparisonTrack }: { readonly project: EntityDocument; readonly locale: Locale; readonly comparisonTrack?: string }) {
  const planning = project.planning as { readonly primary_track?: string; readonly comparison_track?: string } | undefined;
  const primaryTrack = planning?.primary_track ?? "plan";
  const comparison = comparisonTrack ?? planning?.comparison_track;
  const primaryFinish = finishOf(project, primaryTrack);
  const comparisonFinish = finishOf(project, comparison);
  if (primaryFinish === undefined && comparisonFinish === undefined) return null;
  const variance = primaryFinish !== undefined && comparisonFinish !== undefined ? varianceDays(primaryFinish, comparisonFinish) : undefined;
  return (
    <section className="card project-snapshot">
      <h3>Project snapshot</h3>
      <dl>
        <div><dt>Primary finish</dt><dd>{primaryFinish ? formatDateOnly(locale, primaryFinish) : "—"}</dd></div>
        {comparison !== undefined && <div><dt>Comparison finish</dt><dd>{comparisonFinish ? formatDateOnly(locale, comparisonFinish) : "—"}</dd></div>}
        {variance !== undefined && <div><dt>Variance</dt><dd data-variance={variance}>{variance === 0 ? "on time" : variance > 0 ? `+${variance} d` : `${variance} d`}</dd></div>}
      </dl>
    </section>
  );
}
