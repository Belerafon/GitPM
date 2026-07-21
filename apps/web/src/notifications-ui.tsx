import { useEffect, useMemo, useState } from "react";
import type { GitPmApi } from "./api.js";
import { formatDateTime, message, type Locale, type MessageKey } from "./i18n.js";
import type { DraftStatus, MentionNotification, NotificationsResult } from "./types.js";
import type { WorkspaceNavigate } from "./workspace-navigation.js";

export function NotificationsMenu({ api, draft, locale, namespace, onNavigate }: {
  readonly api: GitPmApi;
  readonly draft?: DraftStatus;
  readonly locale: Locale;
  readonly namespace: string;
  readonly onNavigate: WorkspaceNavigate;
}) {
  const t = (key: MessageKey, values?: Readonly<Record<string, string | number>>) => message(locale, key, values);
  const storageKey = `gitpm.notifications.read:${namespace}`;
  const [result, setResult] = useState<NotificationsResult>({ items: [] });
  const [readKeys, setReadKeys] = useState<ReadonlySet<string>>(() => {
    try { const value = JSON.parse(window.localStorage.getItem(storageKey) ?? "[]") as unknown; return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []); }
    catch { return new Set(); }
  });
  const [error, setError] = useState(false);
  const unread = useMemo(() => result.items.filter((item) => !readKeys.has(item.key)), [readKeys, result.items]);

  useEffect(() => {
    if (draft === undefined || api.notifications === undefined) { setResult({ items: [] }); return; }
    let current = true;
    void api.notifications(draft.draft_id).then((next) => { if (current) { setResult(next); setError(false); } }).catch(() => { if (current) setError(true); });
    return () => { current = false; };
  }, [api, draft?.draft_id, draft?.fingerprint, draft?.external_fingerprint]);

  const persist = (next: ReadonlySet<string>) => {
    const keys = [...next].slice(-500);
    window.localStorage.setItem(storageKey, JSON.stringify(keys));
    setReadKeys(new Set(keys));
  };
  const markRead = (item: MentionNotification) => persist(new Set([...readKeys, item.key]));
  const markAll = () => persist(new Set([...readKeys, ...result.items.map((item) => item.key)]));

  return <details className="notifications-menu">
    <summary aria-label={t("notifications.heading")} title={t("notifications.heading")}><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></svg>{unread.length > 0 && <strong>{unread.length > 99 ? "99+" : unread.length}</strong>}</summary>
    <div className="notifications-panel">
      <header><h2>{t("notifications.heading")}</h2>{unread.length > 0 && <button className="text-link" onClick={markAll} type="button">{t("notifications.markAllRead")}</button>}</header>
      {error && <p className="alert error">{t("notifications.loadError")}</p>}
      {!error && result.recipient_person_id === undefined && <p className="field-hint">{t("notifications.identityMissing")}</p>}
      {!error && result.recipient_person_id !== undefined && result.items.length === 0 && <p className="field-hint">{t("notifications.empty")}</p>}
      <div className="notification-items">{result.items.map((item) => <button className={readKeys.has(item.key) ? "notification-item" : "notification-item unread"} key={item.key} onClick={() => { markRead(item); onNavigate("tasks", { projectId: item.project_id, taskId: item.task_id, query: { comment: [item.comment_id] } }); }} type="button">
        <span><strong>{item.author.display_name}</strong> {t("notifications.mentionedYou")}</span>
        <strong>{item.task_title}</strong>
        <span>{item.excerpt}</span>
        <time dateTime={item.mentioned_at}>{formatDateTime(locale, item.mentioned_at)}</time>
      </button>)}</div>
    </div>
  </details>;
}
