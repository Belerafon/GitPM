import type { MessageKey } from "./i18n.js";

export type LifecycleFilterValue = "active" | "archived" | "all";

export function LifecycleFilter({ value, onChange, t }: {
  readonly value: LifecycleFilterValue;
  readonly onChange: (value: LifecycleFilterValue) => void;
  readonly t: (key: MessageKey) => string;
}) {
  return <label className="lifecycle-filter">{t("core.lifecycleFilter")}<select aria-label={t("core.lifecycleFilter")} onChange={(event) => onChange(event.currentTarget.value as LifecycleFilterValue)} value={value}><option value="active">{t("core.lifecycleActive")}</option><option value="archived">{t("core.lifecycleArchived")}</option><option value="all">{t("core.lifecycleAll")}</option></select></label>;
}

export function matchesLifecycleFilter(lifecycle: "active" | "archived", filter: LifecycleFilterValue): boolean {
  return filter === "all" || filter === lifecycle;
}
