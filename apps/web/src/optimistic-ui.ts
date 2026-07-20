import { useLayoutEffect, useRef } from "react";
import type { EntityResult } from "./types.js";

export function upsertEntity(items: readonly EntityResult[], result: EntityResult): readonly EntityResult[] {
  return items.some((item) => item.document.id === result.document.id)
    ? items.map((item) => item.document.id === result.document.id ? result : item)
    : [...items, result];
}

/** Animates keyed elements from their previous layout position to the new one. */
export function useFlipList<T extends HTMLElement = HTMLElement>(reducedMotion: boolean) {
  const container = useRef<T>(null);
  const positions = useRef(new Map<string, DOMRect>());

  useLayoutEffect(() => {
    const elements = Array.from(container.current?.querySelectorAll<HTMLElement>("[data-flip-key]") ?? []);
    const next = new Map(elements.flatMap((element) => {
      const key = element.dataset.flipKey;
      return key === undefined ? [] : [[key, element.getBoundingClientRect()] as const];
    }));
    if (!reducedMotion) {
      const moved = new Set(elements.flatMap((element) => {
        const key = element.dataset.flipKey; const before = key === undefined ? undefined : positions.current.get(key); const after = key === undefined ? undefined : next.get(key);
        return before !== undefined && after !== undefined && (before.x !== after.x || before.y !== after.y) ? [key] : [];
      }));
      for (const element of elements) {
        const key = element.dataset.flipKey; const before = key === undefined ? undefined : positions.current.get(key); const after = key === undefined ? undefined : next.get(key);
        if (key === undefined || before === undefined || after === undefined) continue;
        const ancestor = element.parentElement?.closest<HTMLElement>("[data-flip-key]");
        if (ancestor?.dataset.flipKey !== undefined && moved.has(ancestor.dataset.flipKey)) continue;
        const x = before.x - after.x; const y = before.y - after.y;
        if ((x !== 0 || y !== 0) && typeof element.animate === "function") {
          element.animate([{ transform: `translate(${x}px, ${y}px)` }, { transform: "translate(0, 0)" }], { duration: 280, easing: "cubic-bezier(.2,.8,.2,1)" });
        }
      }
    }
    positions.current = next;
  });

  return container;
}
