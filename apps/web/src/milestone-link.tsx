import type { KeyboardEvent, MouseEvent } from "react";

export function MilestoneLink({ milestoneId, name, onOpen, className = "" }: { readonly milestoneId: string; readonly name: string; readonly onOpen?: (milestoneId: string) => void; readonly className?: string }) {
  if (onOpen === undefined || milestoneId === "") return <span className={className}>{name}</span>;
  const open = () => onOpen(milestoneId);
  const click = (event: MouseEvent<HTMLSpanElement>) => { event.preventDefault(); event.stopPropagation(); open(); };
  const keyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault(); event.stopPropagation(); open();
  };
  return <span className={`milestone-link ${className}`.trim()} onClick={click} onKeyDown={keyDown} role="link" tabIndex={0}>{name}</span>;
}
