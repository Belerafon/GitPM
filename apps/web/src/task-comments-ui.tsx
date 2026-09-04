import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { GitPmApiPort } from "./api.js";
import { formatDateTime, message, type Locale, type MessageKey } from "./i18n.js";
import type { CommentResult, DraftStatus, EntityResult } from "./types.js";
import type { WorkspaceNavigate } from "./workspace-navigation.js";
import { ProjectFileMarkdownField, type ProjectFileReferenceContext } from "./project-file-reference-ui.js";
import { SafeMarkdown } from "./safe-markdown.js";
import { personNameSearchText } from "@gitpm/shared";
import { useDefaultPersonNameFormat, usePersonNameFormatter } from "./person-name.js";

const mentionPattern = /@\[([^\]\r\n]{1,200})\]\(person:(U-[0-9]{2}-[0-9A-HJKMNP-TV-Z]{6})\)/gu;

function text(document: EntityResult["document"], key: string): string {
  return typeof document[key] === "string" ? document[key] as string : "";
}

function inlineComment(value: string, people: readonly EntityResult[], onNavigate: WorkspaceNavigate, personName: (person: EntityResult["document"]) => string): ReactNode[] {
  const result: ReactNode[] = [];
  let offset = 0;
  for (const match of value.matchAll(mentionPattern)) {
    const index = match.index;
    if (index > offset) result.push(<Fragment key={`text-${offset}`}>{value.slice(offset, index)}</Fragment>);
    const personId = match[2]!;
    const person = people.find((item) => item.document.id === personId);
    const name = person === undefined ? match[1]! : personName(person.document);
    result.push(<button className="comment-mention" key={`${personId}-${index}`} onClick={() => onNavigate("people", { personId })} type="button">@{name}</button>);
    offset = index + match[0].length;
  }
  if (offset < value.length) result.push(<Fragment key={`text-${offset}`}>{value.slice(offset)}</Fragment>);
  return result;
}

function CommentMarkdown({ fileContext, source, people, onNavigate }: { readonly fileContext?: ProjectFileReferenceContext; readonly source: string; readonly people: readonly EntityResult[]; readonly onNavigate: WorkspaceNavigate }) {
  const personName = usePersonNameFormatter();
  return <div className="comment-markdown"><SafeMarkdown fileContext={fileContext} renderText={(value) => inlineComment(value, people, onNavigate, personName)} source={source} /></div>;
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

export type TaskCommentsApi = GitPmApiPort<"createComment" | "deleteComment" | "listComments" | "updateComment">;

export function TaskComments({ api, draft, fileContext, projectId, taskId, people, fingerprint, readOnly, locale, focusCommentId, onNavigate, onFingerprintChange, confirmDelete }: {
  readonly api: TaskCommentsApi;
  readonly draft: DraftStatus;
  readonly fileContext?: ProjectFileReferenceContext;
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
  const personName = usePersonNameFormatter();
  const defaultPersonNameFormat = useDefaultPersonNameFormat();
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
  const [open, setOpen] = useState(false);
  const loadedTaskId = useRef<string | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const activePeople = useMemo(() => people.filter((person) => person.document.lifecycle === "active"), [people]);
  const suggestions = mentionQuery === null ? [] : activePeople.filter((person) => {
    const query = mentionQuery.query.toLocaleLowerCase(locale);
    return personNameSearchText(person.document, defaultPersonNameFormat).toLocaleLowerCase(locale).includes(query) || text(person.document, "email").toLocaleLowerCase(locale).includes(query);
  }).slice(0, 6);

  const load = async () => {
    const operation = api.listComments?.bind(api);
    if (operation === undefined) { setLoading(false); return; }
    setLoading(true); setError(null);
    try {
      const next = await operation(draft.draft_id, projectId, taskId);
      setComments(next);
      setCurrentFingerprint(next[0]?.draft_fingerprint ?? fingerprint);
      if (loadedTaskId.current !== taskId) {
        loadedTaskId.current = taskId;
        setOpen(next.some((comment) => comment.document.state === "active") || (focusCommentId !== undefined && next.some((comment) => comment.document.id === focusCommentId)));
      }
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setLoading(false); }
  };

  useEffect(() => { setCurrentFingerprint(fingerprint); }, [fingerprint]);
  useEffect(() => { void load(); }, [draft.draft_id, projectId, taskId, fingerprint]);
  useEffect(() => { window.sessionStorage.setItem(draftKey, body); }, [body, draftKey]);
  useEffect(() => {
    if (focusCommentId === undefined || !comments.some((comment) => comment.document.id === focusCommentId)) return;
    setOpen(true);
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
    const token = `@[${personName(person.document)}](person:${person.document.id}) `;
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
      const next = comments.map((item) => item.document.id === result.document.id ? result : item);
      setComments(next);
      if (!next.some((item) => item.document.state === "active")) setOpen(false);
      setCurrentFingerprint(result.draft_fingerprint); await onFingerprintChange(result.draft_fingerprint);
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };

  const composerKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void create(); }
  };

  const showComposer = open && !readOnly && !loading;
  const activeCommentCount = comments.filter((comment) => comment.document.state === "active").length;

  return <section aria-busy={loading} className="task-comments" aria-labelledby="task-comments-heading">
    <div className="task-comments-heading"><h3 id="task-comments-heading"><button aria-controls={`task-comments-body-${taskId}`} aria-expanded={open} className="section-toggle" onClick={() => setOpen((value) => !value)} type="button"><span aria-hidden="true" className="section-toggle-chevron">▾</span>{t("comments.heading")}</button></h3><span aria-label={`${t("comments.heading")}: ${activeCommentCount}`}>{activeCommentCount}</span></div>
    {open && (<>
      {loading && <p className="empty-copy">{t("status.loading")}</p>}
      <div className="comment-list">{comments.map((comment) => <article className={`task-comment${comment.document.state === "deleted" ? " deleted" : ""}${comment.document.id === focusCommentId ? " focused" : ""}`} id={`comment-${comment.document.id}`} key={comment.document.id}>
        <div className="comment-avatar" aria-hidden="true">{initials(comment.document.author.display_name)}</div>
        <div className="comment-content">
          <header><div><strong>{comment.document.author.display_name}</strong><time dateTime={comment.document.updated_at ?? comment.document.created_at} title={formatDateTime(locale, comment.document.updated_at ?? comment.document.created_at)}>{relativeTime(locale, comment.document.updated_at ?? comment.document.created_at)}</time>{comment.document.updated_at !== undefined && <span>{t("comments.edited")}</span>}</div>{comment.document.state === "active" && (comment.can_edit || comment.can_delete) && <details className="comment-actions"><summary aria-label={t("comments.actions")} title={t("comments.actions")}>…</summary><div>{comment.can_edit && <button disabled={busy} onClick={() => { setEditing(comment.document.id); setEditBody(comment.document.body_markdown ?? ""); }} type="button">{t("comments.edit")}</button>}{comment.can_delete && <button className="danger" data-control-hint={t("controlHint.deleteComment")} disabled={busy} onClick={() => { void remove(comment); }} type="button">{t("comments.delete")}</button>}</div></details>}</header>
          {comment.document.state === "deleted" ? <p className="comment-deleted">{t("comments.deleted")}</p> : editing === comment.document.id ? <div className="comment-edit"><ProjectFileMarkdownField autoFocus context={fileContext} disabled={busy} label={t("comments.edit")} onKeyDown={(event) => { if (event.key === "Escape") setEditing(null); else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void saveEdit(comment); } }} onValueChange={setEditBody} value={editBody} /><div className="comment-edit-actions"><button disabled={busy} onClick={() => setEditing(null)} type="button">{t("core.cancel")}</button><button className="primary" disabled={busy || editBody.trim() === ""} onClick={() => { void saveEdit(comment); }} type="button">{t("core.save")}</button></div></div> : <CommentMarkdown fileContext={fileContext} onNavigate={onNavigate} people={people} source={comment.document.body_markdown ?? ""} />}
        </div>
      </article>)}</div>
      {error !== null && <div className="alert error">{error}<button onClick={() => { void load(); }}>{t("status.retry")}</button></div>}
      {showComposer && <div className="comment-composer" id={`comment-composer-${taskId}`}>
        <ProjectFileMarkdownField ariaDescribedBy={`comment-help-${taskId}`} context={fileContext} disabled={busy} label={t("comments.add")} onCursorActivity={detectMention} onKeyDown={composerKey} onValueChange={(next) => { setBody(next); setMentionQuery(null); }} placeholder={t("comments.placeholder")} ref={textarea} rows={4} value={body} />
        {suggestions.length > 0 && <div className="mention-suggestions" role="listbox" aria-label={t("comments.mentionSuggestions")}>{suggestions.map((person) => <button key={person.document.id} onClick={() => chooseMention(person)} role="option" type="button"><strong>{personName(person.document)}</strong>{text(person.document, "email") !== "" && <span>{text(person.document, "email")}</span>}</button>)}</div>}
        <div className="comment-composer-actions"><span className="field-hint" id={`comment-help-${taskId}`}>{t("comments.draftHint", { draft: draft.draft_id })}</span><button className="primary" disabled={busy || body.trim() === ""} onClick={() => { void create(); }} type="button">{busy ? t("feedback.saving") : t("comments.submit")}</button></div>
      </div>}
      {readOnly && <p className="field-hint">{t("comments.readOnly")}</p>}
    </>)}
  </section>;
}
