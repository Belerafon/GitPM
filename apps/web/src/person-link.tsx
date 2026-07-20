import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import type { EntityResult } from "./types.js";

export function PersonLink({ personId, name, onOpen, className = "" }: { readonly personId: string; readonly name: string; readonly onOpen?: (personId: string) => void; readonly className?: string }) {
  if (onOpen === undefined || personId === "") return <span className={className}>{name}</span>;
  const open = () => onOpen(personId);
  const click = (event: MouseEvent<HTMLSpanElement>) => { event.preventDefault(); event.stopPropagation(); open(); };
  const keyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault(); event.stopPropagation(); open();
  };
  return <span className={`person-link ${className}`.trim()} onClick={click} onKeyDown={keyDown} role="link" tabIndex={0}>{name}</span>;
}

export function PersonLinks({ personIds, people, onOpen, empty }: { readonly personIds: readonly string[]; readonly people: readonly EntityResult[]; readonly onOpen?: (personId: string) => void; readonly empty: ReactNode }) {
  if (personIds.length === 0) return <>{empty}</>;
  return <span className="person-links">{personIds.map((personId, index) => {
    const person = people.find((item) => item.document.id === personId);
    const name = typeof person?.document.name === "string" && person.document.name !== "" ? person.document.name : personId;
    return <span key={personId}>{index > 0 && <span aria-hidden="true">, </span>}<PersonLink name={name} onOpen={onOpen} personId={personId} /></span>;
  })}</span>;
}
