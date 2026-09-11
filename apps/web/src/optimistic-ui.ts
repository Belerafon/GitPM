import { useLayoutEffect, useRef } from "react";
import type { EntityResult } from "./types.js";

export function upsertEntity(items: readonly EntityResult[], result: EntityResult): readonly EntityResult[] {
  return items.some((item) => item.document.id === result.document.id)
    ? items.map((item) => item.document.id === result.document.id ? result : item)
    : [...items, result];
}

const FLIP_ANIMATION_ID = "gitpm-flip";
const FLIP_EPSILON_PX = 1;

/** Animates keyed elements from their previous layout position to the new one. */
export function useFlipList<T extends HTMLElement = HTMLElement>(reducedMotion: boolean) {
  const container = useRef<T>(null);
  const positions = useRef(new Map<string, FlipPosition>());

  useLayoutEffect(() => {
    const host = container.current;
    if (host === null) return;
    // Measure each key relative to the container's content box so that scrolling the
    // container itself or any ancestor (the common cause of the "scroll jump" flicker)
    // does not register as a positional change between renders. Subtract in-flight
    // translates so a later commit cannot sample a mid-animation frame as a new layout.
    const hostRect = host.getBoundingClientRect();
    const scrollLeft = host.scrollLeft;
    const scrollTop = host.scrollTop;
    const elements = Array.from(host.querySelectorAll<HTMLElement>("[data-flip-key]"));
    const next = new Map<string, FlipPosition>();
    for (const element of elements) {
      const key = element.dataset.flipKey;
      if (key === undefined) continue;
      const rect = element.getBoundingClientRect();
      const translate = accumulatedTranslate(element, host);
      next.set(key, { x: rect.left - translate.x - hostRect.left + scrollLeft, y: rect.top - translate.y - hostRect.top + scrollTop });
    }
    if (!reducedMotion) {
      const moved = new Set<string>();
      for (const element of elements) {
        const key = element.dataset.flipKey;
        if (key === undefined) continue;
        const before = positions.current.get(key); const after = next.get(key);
        if (before !== undefined && after !== undefined && isVisibleMove(before, after)) moved.add(key);
      }
      if (moved.size > 0) {
        for (const element of elements) cancelFlipAnimations(element);
        for (const element of elements) {
          const key = element.dataset.flipKey;
          if (key === undefined) continue;
          const before = positions.current.get(key); const after = next.get(key);
          if (before === undefined || after === undefined) continue;
          const ancestor = element.parentElement?.closest<HTMLElement>("[data-flip-key]");
          if (ancestor?.dataset.flipKey !== undefined && moved.has(ancestor.dataset.flipKey)) continue;
          const x = before.x - after.x; const y = before.y - after.y;
          if ((Math.abs(x) >= FLIP_EPSILON_PX || Math.abs(y) >= FLIP_EPSILON_PX) && typeof element.animate === "function") {
            element.animate([{ transform: `translate(${x}px, ${y}px)` }, { transform: "translate(0, 0)" }], { duration: 280, easing: "cubic-bezier(.2,.8,.2,1)", id: FLIP_ANIMATION_ID });
          }
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

function isVisibleMove(before: FlipPosition, after: FlipPosition): boolean {
  return Math.abs(before.x - after.x) >= FLIP_EPSILON_PX || Math.abs(before.y - after.y) >= FLIP_EPSILON_PX;
}

function accumulatedTranslate(element: HTMLElement, host: HTMLElement): FlipPosition {
  let x = 0;
  let y = 0;
  let current: HTMLElement | null = element;
  while (current !== null && current !== host) {
    const translate = readTranslate(current);
    x += translate.x;
    y += translate.y;
    current = current.parentElement;
  }
  return { x, y };
}

function readTranslate(element: HTMLElement): FlipPosition {
  if (typeof getComputedStyle !== "function") return { x: 0, y: 0 };
  const raw = getComputedStyle(element).transform;
  if (raw === "" || raw === "none") return { x: 0, y: 0 };
  if (typeof DOMMatrixReadOnly === "function") {
    try {
      const matrix = new DOMMatrixReadOnly(raw);
      return { x: matrix.m41, y: matrix.m42 };
    } catch {
      return parseCssMatrixTranslate(raw);
    }
  }
  return parseCssMatrixTranslate(raw);
}

function parseCssMatrixTranslate(raw: string): FlipPosition {
  if (raw.startsWith("matrix3d(")) {
    const parts = raw.slice(9, -1).split(",").map((part) => Number(part.trim()));
    return { x: finiteNumber(parts[12]), y: finiteNumber(parts[13]) };
  }
  if (raw.startsWith("matrix(")) {
    const parts = raw.slice(7, -1).split(",").map((part) => Number(part.trim()));
    return { x: finiteNumber(parts[4]), y: finiteNumber(parts[5]) };
  }
  return { x: 0, y: 0 };
}

function finiteNumber(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? value : 0;
}

function cancelFlipAnimations(element: HTMLElement): void {
  if (typeof element.getAnimations !== "function") return;
  for (const animation of element.getAnimations()) {
    if (animation.id === FLIP_ANIMATION_ID) animation.cancel();
  }
}
