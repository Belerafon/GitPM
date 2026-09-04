import { useEffect, useMemo, useState } from "react";
import type { GitPmApiPort } from "./api.js";
import { formatDateTime, message, type Locale, type MessageKey } from "./i18n.js";
import type { DraftStatus, MentionNotification, NotificationsResult } from "./types.js";
import type { WorkspaceNavigate } from "./workspace-navigation.js";

export function NotificationsMenu({ api, draft, locale, namespace, onNavigate }: {
  readonly api: GitPmApiPort<"markNotificationsRead" | "notifications">;
  readonly draft?: DraftStatus;
  readonly locale: Locale;
  readonly namespace: string;
  readonly onNavigate: WorkspaceNavigate;
}) {
  const t = (key: MessageKey, values?: Readonly<Record<string, string | number>>) => message(locale, key, values);
  const storageKey = `gitpm.notifications.read:${namespace}`;
  const [result, setResult] = useState<NotificationsResult>({ items: [] });
  const [error, setError] = useState(false);
  const unread = useMemo(() => result.items.filter((item) => !item.read), [result.items]);

  useEffect(() => {
    if (draft === undefined || api.notifications === undefined) { setResult({ items: [] }); return; }
    let current = true;
    void api.notifications(draft.draft_id).then(async (next) => {
      let resolved = next;
      let migrationFailed = false;
      try {
        const stored = window.localStorage.getItem(storageKey);
        if (stored !== null) {
          let parsed: unknown = [];
          try { parsed = JSON.parse(stored); }
          catch { /* Ignore corrupt legacy browser state; the server is authoritative. */ }
          const legacy = new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []);
          const keys = next.items.filter((item) => !item.read && legacy.has(item.key)).map((item) => item.key);
          try {
            if (keys.length > 0) resolved = await api.markNotificationsRead(draft.draft_id, keys);
            window.localStorage.removeItem(storageKey);
          } catch {
            migrationFailed = true;
          }
        }
      } catch {
        // Browser storage may be unavailable; server-backed read state still works.
      }
      if (current) { setResult(resolved); setError(migrationFailed); }
    }).catch(() => { if (current) setError(true); });
    return () => { current = false; };
  }, [api, draft?.draft_id, draft?.fingerprint, draft?.external_fingerprint, storageKey]);

  const persist = async (keys: readonly string[]) => {
    if (draft === undefined || keys.length === 0) return;
    const selected = new Set(keys);
    const previous = result;
    setResult({ ...result, items: result.items.map((item) => selected.has(item.key) ? { ...item, read: true } : item) });
    try {
      setResult(await api.markNotificationsRead(draft.draft_id, keys));
      setError(false);
    } catch {
      setResult(previous);
      setError(true);
    }
  };
  const markRead = (item: MentionNotification) => { void persist([item.key]); };
  const markAll = () => { void persist(unread.map((item) => item.key)); };

  return <details className="notifications-menu">
    <summary aria-label={t("notifications.heading")} title={t("notifications.heading")}><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></svg>{unread.length > 0 && <strong>{unread.length > 99 ? "99+" : unread.length}</strong>}</summary>
    <div className="notifications-panel">
      <header><h2>{t("notifications.heading")}</h2>{unread.length > 0 && <button className="text-link" onClick={markAll} type="button">{t("notifications.markAllRead")}</button>}</header>
      {error && <p className="alert error">{t("notifications.loadError")}</p>}
      {!error && result.recipient_person_id === undefined && <p className="field-hint">{t("notifications.identityMissing")}</p>}
      {!error && result.recipient_person_id !== undefined && result.items.length === 0 && <p className="field-hint">{t("notifications.empty")}</p>}
      <div className="notification-items">{result.items.map((item) => <button className={item.read ? "notification-item" : "notification-item unread"} key={item.key} onClick={() => { markRead(item); onNavigate("tasks", { projectId: item.project_id, taskId: item.task_id, query: { comment: [item.comment_id] } }); }} type="button">
        <span><strong>{item.author.display_name}</strong> {t("notifications.mentionedYou")}</span>
        <strong>{item.task_title}</strong>
        <span>{item.excerpt}</span>
        <time dateTime={item.mentioned_at}>{formatDateTime(locale, item.mentioned_at)}</time>
      </button>)}</div>
    </div>
  </details>;
}
