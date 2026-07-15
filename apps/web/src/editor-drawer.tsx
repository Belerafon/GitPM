import { useEffect, useId, useRef, type ReactNode } from "react";

export function EditorDrawer({ open, title, closeLabel, onClose, children }: {
  readonly open: boolean;
  readonly title: string;
  readonly closeLabel: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const titleId = useId();
  const closeButton = useRef<HTMLButtonElement>(null);
  const drawer = useRef<HTMLElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const closeHandler = useRef(onClose);
  closeHandler.current = onClose;

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeHandler.current();
      if (event.key !== "Tab" || drawer.current === null) return;
      const focusable = Array.from(drawer.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'));
      if (focusable.length === 0) { event.preventDefault(); return; }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKeyDown);
    const firstField = drawer.current?.querySelector<HTMLElement>(".editor-drawer-body input:not([disabled]), .editor-drawer-body select:not([disabled]), .editor-drawer-body textarea:not([disabled])");
    (firstField ?? closeButton.current)?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
      if (returnFocus.current?.isConnected) returnFocus.current.focus();
    };
  }, [open]);

  if (!open) return null;
  return <div className="editor-drawer-layer">
    <button aria-label={closeLabel} className="editor-drawer-backdrop" onClick={onClose} type="button" />
    <aside aria-labelledby={titleId} aria-modal="true" className="editor-drawer" ref={drawer} role="dialog">
      <header className="editor-drawer-header">
        <h2 id={titleId}>{title}</h2>
        <button aria-label={closeLabel} className="editor-drawer-close" onClick={onClose} ref={closeButton} type="button">×</button>
      </header>
      <div className="editor-drawer-body">{children}</div>
    </aside>
  </div>;
}
