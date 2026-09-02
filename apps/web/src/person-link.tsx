import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import type { EntityResult } from "./types.js";
import { usePersonNameFormatter } from "./person-name.js";

export function PersonLink({ personId, name, onOpen, className = "" }: { readonly personId: string; readonly name: string; readonly onOpen?: (personId: string) => void; readonly className?: string }) {
  const title = name === personId ? name : `${name} · ${personId}`;
  if (onOpen === undefined || personId === "") return <span className={className} title={title}>{name}</span>;
  const open = () => onOpen(personId);
  const click = (event: MouseEvent<HTMLSpanElement>) => { event.preventDefault(); event.stopPropagation(); open(); };
  const keyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault(); event.stopPropagation(); open();
  };
  return <span className={`person-link ${className}`.trim()} onClick={click} onKeyDown={keyDown} role="link" tabIndex={0} title={title}>{name}</span>;
}

export function PersonLinks({ personIds, people, onOpen, empty }: { readonly personIds: readonly string[]; readonly people: readonly EntityResult[]; readonly onOpen?: (personId: string) => void; readonly empty: ReactNode }) {
  const personName = usePersonNameFormatter();
  if (personIds.length === 0) return <>{empty}</>;
  return <span className="person-links">{personIds.map((personId, index) => {
    const person = people.find((item) => item.document.id === personId);
    const name = person === undefined ? personId : personName(person.document) || personId;
    return <span key={personId}>{index > 0 && <span aria-hidden="true">, </span>}<PersonLink name={name} onOpen={onOpen} personId={personId} /></span>;
  })}</span>;
}
