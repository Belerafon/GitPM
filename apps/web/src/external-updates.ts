import { useCallback, useEffect, useRef, useState } from "react";
import type { EntityResult } from "./types.js";

export const EXTERNAL_HIGHLIGHT_MS = 1_800;
export type ExternalHighlights = Readonly<Record<string, readonly string[]>>;

function equal(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }

export function changedEntityFields(previous: readonly EntityResult[], next: readonly EntityResult[]): ExternalHighlights {
  if (previous.length === 0) return {};
  const before = new Map(previous.map((item) => [item.document.id, item.document]));
  const after = new Map(next.map((item) => [item.document.id, item.document]));
  const result: Record<string, readonly string[]> = {};
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const left = before.get(id); const right = after.get(id);
    if (left === undefined || right === undefined) { result[id] = ["$entity"]; continue; }
    const fields = [...new Set([...Object.keys(left), ...Object.keys(right)])].filter((field) => !equal(left[field], right[field])).sort();
    if (fields.length > 0) result[id] = fields;
  }
  return result;
}

export function useExternalHighlights(durationMs = EXTERNAL_HIGHLIGHT_MS) {
  const [highlights, setHighlights] = useState<ExternalHighlights>({});
  const timers = useRef(new Map<string, number>());
  const mark = useCallback((changes: ExternalHighlights) => {
    if (Object.keys(changes).length === 0) return;
    setHighlights((current) => {
      const next = { ...current };
      for (const [id, fields] of Object.entries(changes)) next[id] = [...new Set([...(current[id] ?? []), ...fields])].sort();
      return next;
    });
    for (const id of Object.keys(changes)) {
      const existing = timers.current.get(id); if (existing !== undefined) window.clearTimeout(existing);
      timers.current.set(id, window.setTimeout(() => {
        setHighlights((current) => { const next = { ...current }; delete next[id]; return next; }); timers.current.delete(id);
      }, durationMs));
    }
  }, [durationMs]);
  useEffect(() => () => { for (const timer of timers.current.values()) window.clearTimeout(timer); timers.current.clear(); }, []);
  return { highlights, mark };
}

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true);
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)"); if (media === undefined) return;
    const change = () => setReduced(media.matches); media.addEventListener?.("change", change); return () => media.removeEventListener?.("change", change);
  }, []);
  return reduced;
}
