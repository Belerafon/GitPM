import type { MessageKey } from "../i18n.js";
import type { WorkspaceDestination } from "../workspace-navigation.js";

export interface SectionTab {
  readonly destination: WorkspaceDestination | "workspaces";
  readonly label: MessageKey;
}

export function SectionTabs({ active, ariaLabel, items, onNavigate, t }: {
  readonly active: MessageKey;
  readonly ariaLabel: string;
  readonly items: readonly SectionTab[];
  readonly onNavigate: (destination: WorkspaceDestination | "workspaces") => void;
  readonly t: (key: MessageKey) => string;
}) {
  return <nav aria-label={ariaLabel} className="section-tabs">
    {items.map((item) => <button aria-current={active === item.label ? "page" : undefined} className={active === item.label ? "active" : ""} key={item.label} onClick={() => onNavigate(item.destination)} type="button">{t(item.label)}</button>)}
  </nav>;
}
