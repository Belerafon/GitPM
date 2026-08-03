import type { OverflowWarning } from "@gitpm/scheduling";
import { formatDateOnly, message, type Locale } from "./i18n.js";

export function SchedulingOverflowWarnings({ warnings, locale, trackTitle, onOpenGantt }: {
  readonly warnings: readonly OverflowWarning[];
  readonly locale: Locale;
  readonly trackTitle: (track: string) => string;
  readonly onOpenGantt?: () => void;
}) {
  if (warnings.length === 0) return null;
  return <section className="schedule-overflow-warnings" role="status">
    <h4>{message(locale, "scheduling.overflowHeading")}</h4>
    <ul>{warnings.map((warning) => {
      const text = message(locale, "scheduling.overflowWarning", {
        track: trackTitle(warning.track),
        field: warning.field === "start" ? message(locale, "projectPlan.start") : message(locale, "core.due"),
        declared: formatDateOnly(locale, warning.declared),
        rolled: formatDateOnly(locale, warning.rolled),
      });
      return <li key={`${warning.track}:${warning.field}`}>
        {onOpenGantt === undefined
          ? text
          : <button type="button" className="schedule-overflow-link" onClick={onOpenGantt}>{text}</button>}
      </li>;
    })}</ul>
  </section>;
}
