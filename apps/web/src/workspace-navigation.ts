export type WorkspaceDestination = "portfolio" | "projects" | "stages" | "tasks" | "board" | "people" | "calendar" | "settings" | "workload" | "gantt" | "changes" | "files" | "history" | "connection";

export interface WorkspaceSelection {
  readonly projectId?: string;
  readonly stageId?: string;
  readonly taskId?: string;
  readonly personId?: string;
  readonly commit?: string;
  readonly query?: Readonly<Record<string, readonly string[]>>;
}

export type WorkspaceNavigate = (destination: WorkspaceDestination, selection?: WorkspaceSelection) => void;
