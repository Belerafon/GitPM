import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import type { EntityResult } from "./types.js";

export function ProjectLink({ projectId, name, onOpen, className = "" }: { readonly projectId: string; readonly name: string; readonly onOpen?: (projectId: string) => void; readonly className?: string }) {
  if (onOpen === undefined || projectId === "") return <span className={className}>{name}</span>;
  const open = () => onOpen(projectId);
  const click = (event: MouseEvent<HTMLSpanElement>) => { event.preventDefault(); event.stopPropagation(); open(); };
  const keyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault(); event.stopPropagation(); open();
  };
  return <span className={`project-link ${className}`.trim()} onClick={click} onKeyDown={keyDown} role="link" tabIndex={0}>{name}</span>;
}

export function ProjectLinks({ projectIds, projects, onOpen, empty }: { readonly projectIds: readonly string[]; readonly projects: readonly EntityResult[]; readonly onOpen?: (projectId: string) => void; readonly empty: ReactNode }) {
  if (projectIds.length === 0) return <>{empty}</>;
  return <span className="project-links">{projectIds.map((projectId, index) => {
    const project = projects.find((item) => item.document.id === projectId);
    const name = typeof project?.document.name === "string" && project.document.name !== "" ? project.document.name : projectId;
    return <span key={projectId}>{index > 0 && <span aria-hidden="true">, </span>}<ProjectLink name={name} onOpen={onOpen} projectId={projectId} /></span>;
  })}</span>;
}
