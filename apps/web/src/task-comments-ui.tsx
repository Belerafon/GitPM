import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { GitPmApi } from "./api.js";
import { formatDateTime, message, type Locale, type MessageKey } from "./i18n.js";
import type { CommentResult, DraftStatus, EntityResult } from "./types.js";
import type { WorkspaceNavigate } from "./workspace-navigation.js";

const mentionPattern = /@\[([^\]\r\n]{1,200})\]\(person:(U-[0-9]{2}-[0-9A-HJKMNP-TV-Z]{6})\)/gu;

function text(document: EntityResult["document"], key: string): string {
  return typeof document[key] === "string" ? document[key] as string : "";
}

function inlineComment(value: string, people: readonly EntityResult[], onNavigate: WorkspaceNavigate): ReactNode[] {
  const result: ReactNode[] = [];
  let offset = 0;
  for (const match of value.matchAll(mentionPattern)) {
    const index = match.index;
    if (index > offset) result.push(<Fragment key={`text-${offset}`}>{value.slice(offset, index)}</Fragment>);
    const personId = match[2]!;
    const person = people.find((item) => item.document.id === personId);
    const name = person === undefined ? match[1]! : text(person.document, "name");
    result.push(<button className="comment-mention" key={`${personId}-${index}`} onClick={() => onNavigate("people", { personId })} type="button">@{name}</button>);
    offset = index + match[0].length;
  }
  if (offset < value.length) result.push(<Fragment key={`text-${offset}`}>{value.slice(offset)}</Fragment>);
  return result;
}

function CommentMarkdown({ source, people, onNavigate }: { readonly source: string; readonly people: readonly EntityResult[]; readonly onNavigate: WorkspaceNavigate }) {
  return <div className="safe-markdown comment-markdown">{source.split(/\r?\n/u).map((line, index) => line === ""
    ? <br key={index} />
    : line.startsWith("- ")
      ? <div className="markdown-list-item" key={index}>• {inlineComment(line.slice(2), people, onNavigate)}</div>
      : <p key={index}>{inlineComment(line, people, onNavigate)}</p>)}</div>;
}

function initials(name: string): string {
  return name.split(/\s+/u).filter(Boolean).slice(0, 2).map((part) => part[0]?.toLocaleUpperCase() ?? "").join("") || "?";
}

function relativeTime(locale: Locale, timestamp: string): string {
  const delta = Date.now() - Date.parse(timestamp);
  if (!Number.isFinite(delta) || delta < 0) return formatDateTime(locale, timestamp);
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return locale === "ru" ? "только что" : "just now";
  if (minutes < 60) return locale === "ru" ? `${minutes} мин. назад` : `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return locale === "ru" ? `${hours} ч. назад` : `${hours}h ago`;
  return formatDateTime(locale, timestamp);
}

export function TaskComments({ api, draft, projectId, taskId, people, fingerprint, readOnly, locale, focusCommentId, onNavigate, onFingerprintChange, confirmDelete }: {
  readonly api: GitPmApi;
  readonly draft: DraftStatus;
  readonly projectId: string;
  readonly taskId: string;
  readonly people: readonly EntityResult[];
  readonly fingerprint: string;
  readonly readOnly: boolean;
  readonly locale: Locale;
  readonly focusCommentId?: string;
  readonly onNavigate: WorkspaceNavigate;
  readonly onFingerprintChange: (fingerprint: string) => Promise<void>;
  readonly confirmDelete: () => boolean;
}) {
  const t = (key: MessageKey, values?: Readonly<Record<string, string | number>>) => message(locale, key, values);
  const draftKey = `gitpm.comment-draft:${draft.draft_id}:${taskId}`;
  const [comments, setComments] = useState<readonly CommentResult[]>([]);
  const [body, setBody] = useState(() => window.sessionStorage.getItem(draftKey) ?? "");
  const [currentFingerprint, setCurrentFingerprint] = useState(fingerprint);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");
  const [mentionQuery, setMentionQuery] = useState<{ start: number; query: string } | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const activePeople = useMemo(() => people.filter((person) => person.document.lifecycle === "active"), [people]);
  const suggestions = mentionQuery === null ? [] : activePeople.filter((person) => {
    const query = mentionQuery.query.toLocaleLowerCase(locale);
    return text(person.document, "name").toLocaleLowerCase(locale).includes(query) || text(person.document, "email").toLocaleLowerCase(locale).includes(query);
  }).slice(0, 6);

  const load = async () => {
    const operation = api.listComments?.bind(api);
    if (operation === undefined) { setLoading(false); return; }
    setLoading(true); setError(null);
    try {
      const next = await operation(draft.draft_id, projectId, taskId);
      setComments(next);
      setCurrentFingerprint(next[0]?.draft_fingerprint ?? fingerprint);
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setLoading(false); }
  };

  useEffect(() => { setCurrentFingerprint(fingerprint); }, [fingerprint]);
  useEffect(() => { void load(); }, [draft.draft_id, projectId, taskId, fingerprint]);
  useEffect(() => { window.sessionStorage.setItem(draftKey, body); }, [body, draftKey]);
  useEffect(() => {
    if (focusCommentId === undefined || !comments.some((comment) => comment.document.id === focusCommentId)) return;
    requestAnimationFrame(() => document.getElementById(`comment-${focusCommentId}`)?.scrollIntoView({ block: "center", behavior: "smooth" }));
  }, [comments, focusCommentId]);

  const detectMention = (value: string, cursor: number | null) => {
    if (cursor === null) { setMentionQuery(null); return; }
    const match = value.slice(0, cursor).match(/(?:^|\s)@([^@\s]{0,40})$/u);
    setMentionQuery(match === null ? null : { start: cursor - match[1]!.length - 1, query: match[1]! });
  };

  const chooseMention = (person: EntityResult) => {
    if (mentionQuery === null) return;
    const cursor = textarea.current?.selectionStart ?? body.length;
    const token = `@[${text(person.document, "name")}](person:${person.document.id}) `;
    const next = `${body.slice(0, mentionQuery.start)}${token}${body.slice(cursor)}`;
    setBody(next); setMentionQuery(null);
    requestAnimationFrame(() => { const position = mentionQuery.start + token.length; textarea.current?.focus(); textarea.current?.setSelectionRange(position, position); });
  };

  const create = async () => {
    if (body.trim() === "" || busy) return;
    setBusy(true); setError(null);
    try {
      const result = await api.createComment(draft.draft_id, projectId, taskId, currentFingerprint, body);
      setComments((current) => [...current, result]); setCurrentFingerprint(result.draft_fingerprint); setBody(""); setMentionQuery(null);
      window.sessionStorage.removeItem(draftKey);
      await onFingerprintChange(result.draft_fingerprint);
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };

  const saveEdit = async (comment: CommentResult) => {
    if (editBody.trim() === "" || busy) return;
    setBusy(true); setError(null);
    try {
      const result = await api.updateComment(draft.draft_id, projectId, taskId, comment, currentFingerprint, editBody);
      setComments((current) => current.map((item) => item.document.id === result.document.id ? result : item));
      setCurrentFingerprint(result.draft_fingerprint); setEditing(null); await onFingerprintChange(result.draft_fingerprint);
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };

  const remove = async (comment: CommentResult) => {
    if (busy || !confirmDelete()) return;
    setBusy(true); setError(null);
    try {
      const result = await api.deleteComment(draft.draft_id, projectId, taskId, comment, currentFingerprint);
      setComments((current) => current.map((item) => item.document.id === result.document.id ? result : item));
      setCurrentFingerprint(result.draft_fingerprint); await onFingerprintChange(result.draft_fingerprint);
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };

  const composerKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void create(); }
  };

  return <section className="task-comments" aria-labelledby="task-comments-heading">
    <div className="task-comments-heading"><h3 id="task-comments-heading">{t("comments.heading")}</h3><span>{comments.filter((comment) => comment.document.state === "active").length}</span></div>
    {loading && <p className="empty-copy">{t("status.loading")}</p>}
    {!loading && comments.length === 0 && <p className="empty-copy">{t("comments.empty")}</p>}
    <div className="comment-list">{comments.map((comment) => <article className={`task-comment${comment.document.state === "deleted" ? " deleted" : ""}${comment.document.id === focusCommentId ? " focused" : ""}`} id={`comment-${comment.document.id}`} key={comment.document.id}>
      <div className="comment-avatar" aria-hidden="true">{initials(comment.document.author.display_name)}</div>
      <div className="comment-content">
        <header><div><strong>{comment.document.author.display_name}</strong><time dateTime={comment.document.updated_at ?? comment.document.created_at} title={formatDateTime(locale, comment.document.updated_at ?? comment.document.created_at)}>{relativeTime(locale, comment.document.updated_at ?? comment.document.created_at)}</time>{comment.document.updated_at !== undefined && <span>{t("comments.edited")}</span>}</div>{comment.document.state === "active" && (comment.can_edit || comment.can_delete) && <details className="comment-actions"><summary aria-label={t("comments.actions")}>…</summary><div>{comment.can_edit && <button disabled={busy} onClick={() => { setEditing(comment.document.id); setEditBody(comment.document.body_markdown ?? ""); }} type="button">{t("comments.edit")}</button>}{comment.can_delete && <button className="danger" disabled={busy} onClick={() => { void remove(comment); }} type="button">{t("comments.delete")}</button>}</div></details>}</header>
        {comment.document.state === "deleted" ? <p className="comment-deleted">{t("comments.deleted")}</p> : editing === comment.document.id ? <div className="comment-edit"><textarea autoFocus disabled={busy} onChange={(event) => setEditBody(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setEditing(null); else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void saveEdit(comment); } }} value={editBody} /><div><button disabled={busy} onClick={() => setEditing(null)} type="button">{t("core.cancel")}</button><button className="primary" disabled={busy || editBody.trim() === ""} onClick={() => { void saveEdit(comment); }} type="button">{t("core.save")}</button></div></div> : <CommentMarkdown onNavigate={onNavigate} people={people} source={comment.document.body_markdown ?? ""} />}
      </div>
    </article>)}</div>
    {error !== null && <div className="alert error">{error}<button onClick={() => { void load(); }}>{t("status.retry")}</button></div>}
    {!readOnly && <div className="comment-composer">
      <label htmlFor={`comment-body-${taskId}`}>{t("comments.add")}</label>
      <textarea aria-describedby={`comment-help-${taskId}`} disabled={busy} id={`comment-body-${taskId}`} onChange={(event) => { setBody(event.target.value); detectMention(event.target.value, event.target.selectionStart); }} onClick={(event) => detectMention(event.currentTarget.value, event.currentTarget.selectionStart)} onKeyDown={composerKey} placeholder={t("comments.placeholder")} ref={textarea} rows={4} value={body} />
      {suggestions.length > 0 && <div className="mention-suggestions" role="listbox" aria-label={t("comments.mentionSuggestions")}>{suggestions.map((person) => <button key={person.document.id} onClick={() => chooseMention(person)} role="option" type="button"><strong>{text(person.document, "name")}</strong>{text(person.document, "email") !== "" && <span>{text(person.document, "email")}</span>}</button>)}</div>}
      <div className="comment-composer-actions"><span className="field-hint" id={`comment-help-${taskId}`}>{t("comments.draftHint", { draft: draft.draft_id })}</span><button className="primary" disabled={busy || body.trim() === ""} onClick={() => { void create(); }} type="button">{busy ? t("feedback.saving") : t("comments.submit")}</button></div>
    </div>}
    {readOnly && <p className="field-hint">{t("comments.readOnly")}</p>}
  </section>;
}
