import type { MessageKey } from "../../i18n.js";
import type { WorkspaceDestination, WorkspaceNavigate, WorkspaceSelection } from "../../workspace-navigation.js";

const tabs: readonly { readonly destination: WorkspaceDestination; readonly label: MessageKey }[] = [
  { destination: "projects", label: "projectTabs.overview" },
  { destination: "board", label: "projectTabs.board" },
  { destination: "gantt", label: "projectTabs.timeline" },
];

export function ProjectTabs({ active, projectId, query, onNavigate, t }: {
  readonly active: WorkspaceDestination;
  readonly projectId: string;
  readonly query?: WorkspaceSelection["query"];
  readonly onNavigate: WorkspaceNavigate;
  readonly t: (key: MessageKey) => string;
}) {
  return <nav aria-label={t("projectTabs.navigation")} className="project-tabs">
    {tabs.map((tab) => <button
      aria-current={active === tab.destination ? "page" : undefined}
      className={active === tab.destination ? "active" : ""}
      key={tab.destination}
      onClick={() => onNavigate(tab.destination, { projectId, query })}
      type="button"
    >{t(tab.label)}</button>)}
  </nav>;
}
