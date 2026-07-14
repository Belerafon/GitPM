import type { MessageKey } from "../i18n.js";
import type { WorkspaceDestination } from "../workspace-navigation.js";
import type { AppRouteName } from "./router.js";
import type { NavigationGroup } from "./AppShell.js";

export const navigationGroups: readonly NavigationGroup[] = [
  { label: "nav.groupPlanning", items: ["nav.portfolio", "nav.projects", "nav.tasks", "nav.board", "nav.gantt", "nav.workload"] },
  { label: "nav.groupTeam", items: ["nav.people", "nav.calendar"] },
  { label: "nav.groupRepository", items: ["nav.drafts", "nav.changes", "nav.history", "nav.settings"] },
];

export const routeViews: Readonly<Record<AppRouteName, MessageKey>> = {
  workspaces: "nav.drafts", portfolio: "nav.portfolio", projects: "nav.projects", tasks: "nav.tasks", board: "nav.board",
  people: "nav.people", calendars: "nav.calendar", settings: "nav.settings", workload: "nav.workload", gantt: "nav.gantt",
  changes: "nav.changes", history: "nav.history",
};

export const navigationDestinations: Readonly<Partial<Record<MessageKey, WorkspaceDestination | "workspaces">>> = {
  "nav.drafts": "workspaces", "nav.portfolio": "portfolio", "nav.projects": "projects", "nav.tasks": "tasks", "nav.board": "board",
  "nav.people": "people", "nav.calendar": "calendar", "nav.settings": "settings", "nav.workload": "workload", "nav.gantt": "gantt",
  "nav.changes": "changes", "nav.history": "history",
};
