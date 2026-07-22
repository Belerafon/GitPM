import type { DraftStatus } from "./types.js";
import { message, type Locale } from "./i18n.js";

export type DraftReadOnlyReason = "not-open" | "external-writer" | "changed-externally";

export function draftReadOnlyReason(draft: DraftStatus): DraftReadOnlyReason | null {
  if (draft.state !== "open") return "not-open";
  if (draft.writer_mode !== "ui") return "external-writer";
  if (draft.changed_externally === true) return "changed-externally";
  return null;
}

export function DraftReadOnlyAlert({ draft, locale, onAcknowledge }: {
  readonly draft: DraftStatus;
  readonly locale: Locale;
  readonly onAcknowledge?: () => void;
}) {
  const reason = draftReadOnlyReason(draft);
  if (reason === null) return null;
  const key = reason === "not-open"
    ? "readOnly.notOpen"
    : reason === "external-writer"
      ? "readOnly.externalWriter"
      : "readOnly.changedExternally";
  return <div className={`alert ${reason === "changed-externally" ? "error" : "warning"}`}>
    <span>{message(locale, key, { state: draft.state })}</span>
    {reason === "changed-externally" && onAcknowledge !== undefined
      && <button onClick={onAcknowledge} type="button">{message(locale, "readOnly.acknowledge")}</button>}
  </div>;
}
