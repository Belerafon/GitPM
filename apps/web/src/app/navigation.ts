import type { MessageKey } from "../i18n.js";
import type { WorkspaceDestination } from "../workspace-navigation.js";
import type { AppRouteName } from "./router.js";
import type { NavigationGroup } from "./AppShell.js";

export const navigationGroups: readonly NavigationGroup[] = [
  { label: "nav.groupWork", items: ["nav.projects"] },
  { label: "nav.groupTeam", items: ["nav.team"] },
  { label: "nav.groupGit", items: ["nav.repository"] },
  { label: "nav.groupSettings", items: ["nav.settings"] },
];

export const routeViews: Readonly<Record<AppRouteName, MessageKey>> = {
  workspaces: "nav.drafts", portfolio: "nav.portfolio", projects: "nav.projects", stages: "core.milestones", tasks: "nav.tasks", board: "nav.board",
  people: "nav.people", calendars: "nav.calendar", settings: "nav.settings", workload: "nav.workload", gantt: "nav.gantt",
  changes: "nav.changes", files: "nav.files", history: "nav.history",
};

export const navigationDestinations: Readonly<Partial<Record<MessageKey, WorkspaceDestination | "workspaces">>> = {
  "nav.team": "workload", "nav.repository": "workspaces", "nav.projects": "projects", "nav.settings": "settings",
};
