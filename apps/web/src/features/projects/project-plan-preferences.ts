import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

export type TaskField = "assignees" | "due" | "estimate" | "status";
export type TaskFieldVisibility = Readonly<Record<TaskField, boolean>>;

const TASK_FIELDS_STORAGE_KEY = "gitpm.projectPlan.taskFields";
const defaultTaskFields: TaskFieldVisibility = { assignees: true, due: true, estimate: true, status: true };

function readTaskFields(): TaskFieldVisibility {
  try {
    const stored = JSON.parse(localStorage.getItem(TASK_FIELDS_STORAGE_KEY) ?? "{}") as Partial<Record<TaskField, unknown>>;
    return { assignees: stored.assignees !== false, due: stored.due !== false, estimate: stored.estimate !== false, status: stored.status !== false };
  } catch {
    return defaultTaskFields;
  }
}

function writeTaskFields(fields: TaskFieldVisibility): void {
  try { localStorage.setItem(TASK_FIELDS_STORAGE_KEY, JSON.stringify(fields)); } catch { /* Browser storage may be unavailable. */ }
}

export function useTaskFieldVisibility() {
  const [taskFields, setTaskFields] = useState<TaskFieldVisibility>(readTaskFields);
  useEffect(() => { writeTaskFields(taskFields); }, [taskFields]);
  return [taskFields, setTaskFields] as const;
}

const INSPECTOR_WIDTH_STORAGE_KEY = "gitpm.projectPlan.inspectorWidth";
export const DEFAULT_INSPECTOR_WIDTH = 410;
export const MIN_INSPECTOR_WIDTH = 340;
export const MAX_INSPECTOR_WIDTH = 760;

function clampInspectorWidth(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_INSPECTOR_WIDTH;
  return Math.min(MAX_INSPECTOR_WIDTH, Math.max(MIN_INSPECTOR_WIDTH, Math.round(value)));
}

function readInspectorWidth(): number {
  if (typeof localStorage === "undefined") return DEFAULT_INSPECTOR_WIDTH;
  try {
    const value = Number(localStorage.getItem(INSPECTOR_WIDTH_STORAGE_KEY));
    return value === 0 ? DEFAULT_INSPECTOR_WIDTH : clampInspectorWidth(value);
  } catch {
    return DEFAULT_INSPECTOR_WIDTH;
  }
}

function writeInspectorWidth(value: number): void {
  try { localStorage.setItem(INSPECTOR_WIDTH_STORAGE_KEY, String(value)); } catch { /* Browser storage may be unavailable. */ }
}

interface InspectorResize {
  readonly pointerId: number;
  readonly startX: number;
  readonly startWidth: number;
}

export function useProjectPlanInspector() {
  const paneRef = useRef<HTMLElement | null>(null);
  const [width, setWidth] = useState(readInspectorWidth);
  const [resize, setResize] = useState<InspectorResize | null>(null);

  useEffect(() => { writeInspectorWidth(width); }, [width]);

  const beginResize = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const inspector = paneRef.current;
    if (inspector === null) return;
    const startWidth = inspector.getBoundingClientRect().width;
    if (startWidth <= 0) return;
    event.preventDefault();
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* pointer capture unavailable */ }
    setResize({ pointerId: event.pointerId, startX: event.clientX, startWidth });
  };

  const moveResize = (event: PointerEvent<HTMLElement>) => {
    if (resize === null || event.pointerId !== resize.pointerId) return;
    setWidth(clampInspectorWidth(resize.startWidth - (event.clientX - resize.startX)));
  };

  const endResize = (event: PointerEvent<HTMLElement>) => {
    if (resize === null || event.pointerId !== resize.pointerId) return;
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* pointer capture unavailable */ }
    setResize(null);
  };

  const resizeByKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const step = event.shiftKey ? 40 : 16;
      setWidth((current) => clampInspectorWidth(current + (event.key === "ArrowLeft" ? step : -step)));
    } else if (event.key === "Home") {
      event.preventDefault();
      setWidth(MIN_INSPECTOR_WIDTH);
    } else if (event.key === "End") {
      event.preventDefault();
      setWidth(MAX_INSPECTOR_WIDTH);
    } else if (event.key === "Enter") {
      event.preventDefault();
      setWidth(DEFAULT_INSPECTOR_WIDTH);
    }
  };

  return { paneRef, width, resizing: resize !== null, beginResize, moveResize, endResize, resizeByKey };
}
