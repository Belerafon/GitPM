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
  const positions = useRef(new Map<string, FlipPosition>());

  useLayoutEffect(() => {
    const host = container.current;
    if (host === null) return;
    // Measure each key relative to the container's content box so that scrolling the
    // container itself or any ancestor (the common cause of the "scroll jump" flicker)
    // does not register as a positional change between renders.
    const hostRect = host.getBoundingClientRect();
    const scrollLeft = host.scrollLeft;
    const scrollTop = host.scrollTop;
    const elements = Array.from(host.querySelectorAll<HTMLElement>("[data-flip-key]"));
    const next = new Map<string, FlipPosition>();
    for (const element of elements) {
      const key = element.dataset.flipKey;
      if (key === undefined) continue;
      const rect = element.getBoundingClientRect();
      next.set(key, { x: rect.left - hostRect.left + scrollLeft, y: rect.top - hostRect.top + scrollTop });
    }
    if (!reducedMotion) {
      const moved = new Set<string>();
      for (const element of elements) {
        const key = element.dataset.flipKey;
        if (key === undefined) continue;
        const before = positions.current.get(key); const after = next.get(key);
        if (before !== undefined && after !== undefined && (before.x !== after.x || before.y !== after.y)) moved.add(key);
      }
      for (const element of elements) {
        const key = element.dataset.flipKey;
        if (key === undefined) continue;
        const before = positions.current.get(key); const after = next.get(key);
        if (before === undefined || after === undefined) continue;
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

interface FlipPosition {
  readonly x: number;
  readonly y: number;
}
