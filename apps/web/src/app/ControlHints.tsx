import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { MessageKey } from "../i18n.js";
import { localizedFieldHints } from "./field-hints.js";

const CONTROL_SELECTOR = 'button:not([aria-hidden="true"]), [role="button"]:not([aria-hidden="true"]), [role="link"]:not([aria-hidden="true"]), [role="separator"][tabindex], a[href], summary:not([aria-hidden="true"]), [data-control-hint]';
const FIELD_CONTROL_SELECTOR = "input:not([type=hidden]), select, textarea";
const TOOLTIP_ID = "gitpm-control-hint";
const HOVER_DELAY_MS = 1_000;

interface HintState {
  readonly anchorLeft: number;
  readonly arrowLeft: string;
  readonly below: boolean;
  readonly left: number;
  readonly text: string;
  readonly top: number;
}

function normalized(value: string | null | undefined): string {
  return value?.replace(/\s+/gu, " ").trim() ?? "";
}

interface HintTarget {
  readonly anchor: HTMLElement;
  readonly source: HTMLElement;
}

function fieldLabel(control: Element): HTMLLabelElement | null {
  if (control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement) {
    return control.labels?.item(0) ?? null;
  }
  return control.closest("label");
}

function hintTargetFor(target: EventTarget | null): HintTarget | null {
  if (!(target instanceof Element)) return null;
  const control = target.closest<HTMLElement>(CONTROL_SELECTOR);
  if (control !== null) return { anchor: control, source: control };
  const fieldControl = target.matches(FIELD_CONTROL_SELECTOR)
    ? target as HTMLElement
    : target.closest("label")?.querySelector<HTMLElement>(FIELD_CONTROL_SELECTOR) ?? null;
  if (fieldControl !== null) {
    const label = fieldLabel(fieldControl);
    if (label !== null) return { anchor: fieldControl, source: label };
    return { anchor: fieldControl, source: fieldControl };
  }
  const explanatory = target.closest<HTMLElement>("legend, [data-field-hint]");
  return explanatory === null ? null : { anchor: explanatory, source: explanatory };
}

function fieldCaption(label: HTMLElement): string {
  if (label.matches(FIELD_CONTROL_SELECTOR)) return normalized(label.getAttribute("aria-label"));
  const directText = Array.from(label.childNodes)
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent ?? "")
    .join(" ");
  if (normalized(directText) !== "") return normalized(directText);
  const caption = Array.from(label.children).find((child) => !child.matches(FIELD_CONTROL_SELECTOR) && !child.querySelector(FIELD_CONTROL_SELECTOR));
  return normalized(caption?.textContent);
}

function positionFor(target: HTMLElement, text: string): HintState {
  const rect = target.getBoundingClientRect();
  const viewportWidth = window.innerWidth || 1024;
  const tooltipWidth = Math.min(520, Math.max(0, viewportWidth - 32));
  const center = rect.left + rect.width / 2;
  const charactersPerLine = Math.max(24, Math.floor(tooltipWidth / 7));
  const estimatedHeight = Math.ceil(text.length / charactersPerLine) * 20 + 28;
  const below = rect.top < Math.min(220, estimatedHeight + 16);
  return { anchorLeft: center, arrowLeft: "50%", below, left: center, text, top: below ? rect.bottom : rect.top };
}

export function ControlHints({ t }: {
  readonly t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string;
}) {
  const [hint, setHint] = useState<HintState | null>(null);
  const hovered = useRef<HintTarget | null>(null);
  const focused = useRef<HintTarget | null>(null);
  const hoverReady = useRef(false);
  const described = useRef<{ readonly target: HTMLElement; readonly previous: string | null } | null>(null);
  const suspendedTitle = useRef<{ readonly target: HTMLElement; readonly title: string } | null>(null);
  const tooltip = useRef<HTMLDivElement | null>(null);

  const commonHints = useMemo(() => new Map<string, string>([
    [t("auth.login"), t("controlHint.login")],
    [t("auth.logoutGitLab"), t("controlHint.logout")],
    [t("status.retry"), t("controlHint.retry")],
    [t("core.save"), t("controlHint.save")],
    [t("core.cancel"), t("controlHint.cancel")],
    [t("core.edit"), t("controlHint.edit")],
    [t("core.archive"), t("controlHint.archive")],
    [t("core.restore"), t("controlHint.restore")],
    [t("core.createProject"), t("controlHint.createProject")],
    [t("core.createProjectAction"), t("controlHint.createProject")],
    [t("core.createTask"), t("controlHint.createTask")],
    [t("core.createTaskAction"), t("controlHint.createTask")],
    [t("stages.new"), t("controlHint.createMilestone")],
    [t("core.addAssignee"), t("controlHint.addAssignee")],
    [t("drafts.generateId"), t("controlHint.generateDraftId")],
    [t("drafts.create"), t("controlHint.createDraft")],
    [t("drafts.switchToUi"), t("controlHint.switchToUi")],
    [t("drafts.switchToExternal"), t("controlHint.switchToExternal")],
    [t("drafts.close"), t("controlHint.closeDraft")],
    [t("drafts.reopen"), t("controlHint.reopenDraft")],
    [t("drafts.cleanup"), t("controlHint.cleanupDraft")],
    [t("changes.discardAll"), t("controlHint.discardAll")],
    [t("changes.openCommit"), t("controlHint.openCommit")],
    [t("changes.commitAll"), t("controlHint.commitAll")],
    [t("changes.push"), t("controlHint.push")],
    [t("changes.createMr"), t("controlHint.createMr")],
    [t("worktree.refresh"), t("controlHint.refreshFiles")],
    [t("worktree.newFolder"), t("controlHint.newFolder")],
    [t("worktree.upload"), t("controlHint.uploadFiles")],
    [t("worktree.download"), t("controlHint.downloadFile")],
    [t("worktree.rename"), t("controlHint.renameFile")],
    [t("worktree.move"), t("controlHint.moveFile")],
    [t("export.download"), t("controlHint.downloadExport")],
    [t("comments.submit"), t("controlHint.submitComment")],
    [t("notifications.markAllRead"), t("controlHint.markNotificationsRead")],
  ]), [t]);
  const fieldHints = useMemo(() => localizedFieldHints(t), [t]);

  useLayoutEffect(() => {
    const element = tooltip.current;
    if (hint === null || element === null) return;
    const width = element.getBoundingClientRect().width;
    if (width <= 0) return;
    const margin = 16;
    const halfWidth = width / 2;
    const minimumLeft = margin + halfWidth;
    const maximumLeft = Math.max(minimumLeft, (window.innerWidth || 1024) - margin - halfWidth);
    const left = Math.min(Math.max(hint.anchorLeft, minimumLeft), maximumLeft);
    const arrowLeft = Math.min(Math.max(hint.anchorLeft - left + halfWidth, 12), Math.max(12, width - 12));
    const arrowPosition = `${arrowLeft}px`;
    if (left !== hint.left || arrowPosition !== hint.arrowLeft) {
      setHint({ ...hint, arrowLeft: arrowPosition, left });
    }
  }, [hint]);

  useEffect(() => {
    let hoverTimer: ReturnType<typeof setTimeout> | null = null;
    const clearHoverTimer = () => {
      if (hoverTimer !== null) clearTimeout(hoverTimer);
      hoverTimer = null;
    };
    const restoreDescription = () => {
      const current = described.current;
      if (current === null) return;
      if (current.target.isConnected) {
        if (current.previous === null) current.target.removeAttribute("aria-describedby");
        else current.target.setAttribute("aria-describedby", current.previous);
      }
      described.current = null;
    };
    const restoreTitle = () => {
      const current = suspendedTitle.current;
      if (current === null) return;
      if (current.target.isConnected && !current.target.hasAttribute("title")) current.target.setAttribute("title", current.title);
      suspendedTitle.current = null;
    };
    const hide = () => {
      restoreDescription();
      restoreTitle();
      setHint(null);
    };
    const hintText = (target: HintTarget): string => {
      const explicit = normalized(target.source.dataset.controlHint ?? target.source.dataset.fieldHint);
      if (explicit !== "") return explicit;
      if (target.source.matches(".person-link")) return t("controlHint.openPerson");
      if (target.source.matches(".project-link")) return t("controlHint.openProject");
      if (target.source.matches(".milestone-link")) return t("controlHint.openMilestone");
      const ariaLabel = normalized(target.source.getAttribute("aria-label"));
      const visibleLabel = normalized(target.source.textContent);
      const field = fieldHints.get(fieldCaption(target.source));
      if (field !== undefined) return field;
      const groupLegend = target.source.closest("fieldset")?.querySelector<HTMLElement>(":scope > legend");
      const groupField = groupLegend === undefined || groupLegend === null
        ? undefined
        : normalized(groupLegend.dataset.fieldHint) || fieldHints.get(fieldCaption(groupLegend));
      if (groupField !== undefined) return groupField;
      const common = commonHints.get(ariaLabel) ?? commonHints.get(visibleLabel);
      if (common !== undefined) return common;
      const nativeTitle = normalized(target.source.getAttribute("title") ?? (suspendedTitle.current?.target === target.source ? suspendedTitle.current.title : null));
      if (nativeTitle !== "" && nativeTitle !== visibleLabel) return nativeTitle;
      // Visible text already explains a text button. Repeating it in a tooltip adds noise and
      // can cover adjacent controls. Keep the accessible-name fallback for icon-only controls.
      const fallback = /[\p{L}\p{N}]/u.test(visibleLabel) ? "" : ariaLabel;
      return fallback.length > 180 ? `${fallback.slice(0, 177).trimEnd()}…` : fallback;
    };
    const show = (target: HintTarget) => {
      const text = hintText(target);
      if (text === "") { hide(); return; }
      restoreDescription();
      if (suspendedTitle.current?.target !== target.source) restoreTitle();
      const title = target.source.getAttribute("title");
      if (title !== null) {
        suspendedTitle.current = { target: target.source, title };
        target.source.removeAttribute("title");
      }
      const previous = target.anchor.getAttribute("aria-describedby");
      target.anchor.setAttribute("aria-describedby", normalized(`${previous ?? ""} ${TOOLTIP_ID}`));
      described.current = { target: target.anchor, previous };
      setHint(positionFor(target.anchor, text));
    };
    const showCurrent = () => {
      const target = (hoverReady.current ? hovered.current : null) ?? focused.current;
      if (target === null) hide(); else show(target);
    };
    const onMouseOver = (event: MouseEvent) => {
      const target = hintTargetFor(event.target);
      if (target === null) return;
      const related = event.relatedTarget;
      if (related instanceof Node && target.source.contains(related)) return;
      clearHoverTimer();
      hovered.current = target;
      hoverReady.current = false;
      hoverTimer = setTimeout(() => {
        hoverTimer = null;
        if (hovered.current?.source !== target.source) return;
        hoverReady.current = true;
        show(target);
      }, HOVER_DELAY_MS);
    };
    const onMouseOut = (event: MouseEvent) => {
      const target = hintTargetFor(event.target);
      if (target === null || hovered.current?.source !== target.source) return;
      const related = event.relatedTarget;
      if (related instanceof Node && target.source.contains(related)) return;
      clearHoverTimer();
      hovered.current = null;
      hoverReady.current = false;
      showCurrent();
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = hintTargetFor(event.target);
      if (target === null) return;
      clearHoverTimer();
      focused.current = target;
      if (hovered.current?.source === target.source) hoverReady.current = true;
      show(target);
    };
    const onFocusOut = (event: FocusEvent) => {
      const target = hintTargetFor(event.target);
      if (target === null || focused.current?.source !== target.source) return;
      const related = event.relatedTarget;
      if (related instanceof Node && target.source.contains(related)) return;
      focused.current = null;
      showCurrent();
    };
    const dismiss = () => {
      clearHoverTimer();
      hovered.current = null;
      hoverReady.current = false;
      focused.current = null;
      hide();
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") dismiss(); };

    document.addEventListener("mouseover", onMouseOver);
    document.addEventListener("mouseout", onMouseOut);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      document.removeEventListener("mouseover", onMouseOver);
      document.removeEventListener("mouseout", onMouseOut);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
      clearHoverTimer();
      restoreDescription();
      restoreTitle();
    };
  }, [commonHints, fieldHints, t]);

  if (hint === null || typeof document === "undefined") return null;
  return createPortal(<div
    className={`control-hint${hint.below ? " below" : ""}`}
    id={TOOLTIP_ID}
    ref={tooltip}
    role="tooltip"
    style={{ left: `${hint.left}px`, top: `${hint.top}px` }}
  >{hint.text}<span aria-hidden="true" className="control-hint-arrow" style={{ left: hint.arrowLeft }} /></div>, document.body);
}
