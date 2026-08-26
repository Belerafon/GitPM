export type WorkspaceDestination = "projects" | "stages" | "tasks" | "board" | "effort" | "people" | "calendar" | "settings" | "workload" | "vacations" | "gantt" | "changes" | "files" | "history" | "connection";

export interface WorkspaceSelection {
  readonly projectId?: string;
  readonly stageId?: string;
  readonly taskId?: string;
  readonly personId?: string;
  readonly calendarId?: string;
  readonly commit?: string;
  readonly query?: Readonly<Record<string, readonly string[]>>;
}

export type WorkspaceNavigate = (destination: WorkspaceDestination, selection?: WorkspaceSelection) => void;
