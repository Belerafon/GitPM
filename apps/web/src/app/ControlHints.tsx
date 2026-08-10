import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { MessageKey } from "../i18n.js";

const CONTROL_SELECTOR = 'button:not([aria-hidden="true"]), [role="button"]:not([aria-hidden="true"]), summary:not([aria-hidden="true"])';
const TOOLTIP_ID = "gitpm-control-hint";

interface HintState {
  readonly below: boolean;
  readonly left: number;
  readonly text: string;
  readonly top: number;
}

function normalized(value: string | null | undefined): string {
  return value?.replace(/\s+/gu, " ").trim() ?? "";
}

function controlFor(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>(CONTROL_SELECTOR) : null;
}

function positionFor(target: HTMLElement, text: string): HintState {
  const rect = target.getBoundingClientRect();
  const viewportWidth = window.innerWidth || 1024;
  const horizontalMargin = Math.min(180, Math.max(16, viewportWidth / 2));
  const center = rect.left + rect.width / 2;
  const left = Math.min(Math.max(center, horizontalMargin), Math.max(horizontalMargin, viewportWidth - horizontalMargin));
  const below = rect.top < 76;
  return { below, left, text, top: below ? rect.bottom : rect.top };
}

export function ControlHints({ t }: {
  readonly t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string;
}) {
  const [hint, setHint] = useState<HintState | null>(null);
  const hovered = useRef<HTMLElement | null>(null);
  const focused = useRef<HTMLElement | null>(null);
  const described = useRef<{ readonly target: HTMLElement; readonly previous: string | null } | null>(null);
  const suspendedTitle = useRef<{ readonly target: HTMLElement; readonly title: string } | null>(null);

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

  useEffect(() => {
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
    const hintText = (target: HTMLElement): string => {
      const explicit = normalized(target.dataset.controlHint);
      if (explicit !== "") return explicit;
      const ariaLabel = normalized(target.getAttribute("aria-label"));
      const visibleLabel = normalized(target.textContent);
      const common = commonHints.get(ariaLabel) ?? commonHints.get(visibleLabel);
      if (common !== undefined) return common;
      const nativeTitle = normalized(target.getAttribute("title") ?? (suspendedTitle.current?.target === target ? suspendedTitle.current.title : null));
      if (nativeTitle !== "") return nativeTitle;
      const fallback = ariaLabel || visibleLabel;
      return fallback.length > 180 ? `${fallback.slice(0, 177).trimEnd()}…` : fallback;
    };
    const show = (target: HTMLElement) => {
      const text = hintText(target);
      if (text === "") { hide(); return; }
      restoreDescription();
      if (suspendedTitle.current?.target !== target) restoreTitle();
      const title = target.getAttribute("title");
      if (title !== null) {
        suspendedTitle.current = { target, title };
        target.removeAttribute("title");
      }
      const previous = target.getAttribute("aria-describedby");
      target.setAttribute("aria-describedby", normalized(`${previous ?? ""} ${TOOLTIP_ID}`));
      described.current = { target, previous };
      setHint(positionFor(target, text));
    };
    const showCurrent = () => {
      const target = hovered.current ?? focused.current;
      if (target === null) hide(); else show(target);
    };
    const onMouseOver = (event: MouseEvent) => {
      const target = controlFor(event.target);
      if (target === null) return;
      const related = event.relatedTarget;
      if (related instanceof Node && target.contains(related)) return;
      hovered.current = target;
      show(target);
    };
    const onMouseOut = (event: MouseEvent) => {
      const target = controlFor(event.target);
      if (target === null || hovered.current !== target) return;
      const related = event.relatedTarget;
      if (related instanceof Node && target.contains(related)) return;
      hovered.current = null;
      showCurrent();
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = controlFor(event.target);
      if (target === null) return;
      focused.current = target;
      show(target);
    };
    const onFocusOut = (event: FocusEvent) => {
      const target = controlFor(event.target);
      if (target === null || focused.current !== target) return;
      const related = event.relatedTarget;
      if (related instanceof Node && target.contains(related)) return;
      focused.current = null;
      showCurrent();
    };
    const dismiss = () => {
      hovered.current = null;
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
      restoreDescription();
      restoreTitle();
    };
  }, [commonHints]);

  if (hint === null || typeof document === "undefined") return null;
  return createPortal(<div
    className={`control-hint${hint.below ? " below" : ""}`}
    id={TOOLTIP_ID}
    role="tooltip"
    style={{ left: `${hint.left}px`, top: `${hint.top}px` }}
  >{hint.text}</div>, document.body);
}
