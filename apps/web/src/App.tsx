import { useMemo, useState, type FormEvent } from "react";
import type { GitPmApi } from "./api.js";
import { DraftProvider, useDrafts } from "./draft-context.js";
import { formatDateTime, localeRegistry, LOCALE_STORAGE_KEY, message, selectLocale, type Locale, type MessageKey } from "./i18n.js";
import { CoreWorkspace } from "./core-ui.js";
import { AdminWorkspace } from "./admin-ui.js";
import { ChangesWorkspace } from "./changes-ui.js";
import { HistoryWorkspace } from "./history-ui.js";
import { BoardWorkspace } from "./board-ui.js";
import { GanttWorkspace } from "./gantt-ui.js";
import { WorkloadWorkspace } from "./workload-ui.js";

interface AppProps {
  readonly api: GitPmApi;
  readonly storage?: Pick<Storage, "getItem" | "setItem">;
  readonly browserLanguages?: readonly string[];
  readonly navigate?: (url: string) => void;
  readonly confirmAction?: (message: string) => boolean;
}

const navigation: readonly MessageKey[] = [
  "nav.drafts", "nav.portfolio", "nav.projects", "nav.tasks", "nav.board", "nav.people",
  "nav.calendar", "nav.settings", "nav.workload", "nav.gantt", "nav.changes", "nav.history",
];

function Shell({ locale, setLocale, api, navigate, confirmAction }: {
  readonly locale: Locale;
  readonly setLocale: (locale: Locale) => void;
  readonly api: GitPmApi;
  readonly navigate: (url: string) => void;
  readonly confirmAction: (message: string) => boolean;
}) {
  const drafts = useDrafts();
  const [draftId, setDraftId] = useState("");
  const [selectedView, setSelectedView] = useState<MessageKey | null>(null);
  const repositoryMode = drafts.session?.mode === "repository";
  const view = selectedView ?? (repositoryMode ? "nav.projects" : "nav.drafts");
  const visibleNavigation = repositoryMode ? navigation.filter((key) => key !== "nav.drafts") : navigation;
  const t = (key: MessageKey, values?: Readonly<Record<string, string | number>>) => message(locale, key, values);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = draftId.trim();
    if (value !== "") { void drafts.create(value); setDraftId(""); }
  };

  if (drafts.session === undefined) return <main className="center-card"><p>{t("status.loading")}</p></main>;
  if (drafts.session === null) return (
    <main className="center-card auth-card">
      <div className="brand-mark">G</div><h1>{t("auth.heading")}</h1><p>{t("auth.description")}</p>
      <button className="primary" onClick={() => { void api.login().then(navigate); }}>{t("auth.login")}</button>
      <LocalePicker locale={locale} setLocale={setLocale} t={t} />
      {drafts.error !== null && <p className="alert error">{t("status.error", { message: drafts.error })}</p>}
    </main>
  );

  const snapshot = drafts.snapshot;
  const active = snapshot?.draft;
  const external = active?.writer_mode === "external";
  const maintainer = drafts.session.role === "Maintainer";
  const repository = drafts.session.repository;
  const gitlab = drafts.session.gitlab;
  const loginToGitLab = () => { void api.login().then(navigate); };
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">G</span><strong>{t("app.title")}</strong></div>
        <nav>{visibleNavigation.map((key) => <button className={view === key ? "active" : ""} key={key} onClick={() => setSelectedView(key)}>{t(key)}</button>)}</nav>
        <div className="repository-card"><span>{t("app.singleRepository")}</span><strong>{repository?.name ?? t("app.repository")}</strong></div>
      </aside>
      <main className="workspace">
        <header className="topbar">
          <div><h1>{repository?.name ?? t("app.repository")}</h1><p>{repository?.path ?? drafts.session.user.username} · {t("auth.localMode")} · {t("auth.role", { role: drafts.session.role })}</p></div>
          <div className="top-actions"><LocalePicker locale={locale} setLocale={setLocale} t={t} />
            {gitlab?.configured === true && gitlab.user === undefined && <button onClick={loginToGitLab}>{t("auth.login")}</button>}
            {gitlab?.user !== undefined && <><span>{gitlab.user.username}</span><button onClick={() => { void drafts.logout(); }}>{t("auth.logoutGitLab")}</button></>}
          </div>
        </header>
        {drafts.error !== null && <div className="alert error">{t("status.error", { message: drafts.error })}<button onClick={() => { void drafts.refresh(); }}>{t("status.retry")}</button></div>}
        {!repositoryMode && view === "nav.drafts" && <section className="draft-layout">
          <div className="draft-list card">
            <h2>{t("drafts.heading")}</h2>
            <form onSubmit={submit}><label htmlFor="draft-id">{t("drafts.id")}</label><div className="inline"><input id="draft-id" value={draftId} onChange={(event) => setDraftId(event.target.value)} pattern="[A-Za-z0-9][A-Za-z0-9-]{0,127}" required /><button className="primary" disabled={drafts.busy || drafts.session.role === "Reporter"}>{t("drafts.create")}</button></div></form>
            <div className="draft-items">{drafts.drafts.length === 0 ? <p>{t("drafts.empty")}</p> : drafts.drafts.map((draft) => (
              <button className={active?.draft_id === draft.draft_id ? "draft-item selected" : "draft-item"} key={draft.draft_id} onClick={() => { void drafts.select(draft.draft_id); }}>
                <strong>{draft.draft_id}</strong><span>{draft.branch}</span><span className={`state ${draft.state}`}>{draft.state}</span>
              </button>
            ))}</div>
          </div>
          <div className="draft-detail card">
            {snapshot === null || active === undefined ? <p>{t("drafts.empty")}</p> : <>
              <div className="detail-heading"><div><span className="eyebrow">{t("drafts.id")}</span><h2>{active.draft_id}</h2></div><span className={`state ${active.state}`}>{active.state}</span></div>
              {external && <div className="alert warning">{t("drafts.externalWarning")}</div>}
              {!external && active.changed_externally === true && <div className="alert error">{t("drafts.changedExternally")}</div>}
              {snapshot.changes.changed_files_count > 0 && <div className="alert info">{t("drafts.localWarning")}</div>}
              <dl className="status-grid">
                <div><dt>{t("drafts.branch")}</dt><dd><code>{active.branch}</code></dd></div>
                <div><dt>{t("drafts.writerMode")}</dt><dd>{t(external ? "drafts.writerExternal" : "drafts.writerUi")}</dd></div>
                <div><dt>{t("drafts.dirty")}</dt><dd>{snapshot.changes.changed_files_count}</dd></div>
                <div><dt>{t("drafts.validation")}</dt><dd className={snapshot.validation.valid ? "valid" : "invalid"}>{snapshot.validation.valid ? t("drafts.validationValid") : t("drafts.validationInvalid", { count: snapshot.validation.error_count })}</dd></div>
                <div><dt>{t("drafts.mr")}</dt><dd>{snapshot.mergeRequest?.state ?? t("drafts.noMr")}</dd></div>
                <div><dt>{t("drafts.state")}</dt><dd>{active.state}</dd></div>
              </dl>
              <div className="actions">
                {active.state === "open" && <button disabled={drafts.busy} onClick={() => { void drafts.setWriterMode(external ? "ui" : "external"); }}>{t(external ? "drafts.switchToUi" : "drafts.switchToExternal")}</button>}
                {active.state === "open" && <button disabled={drafts.busy} onClick={() => { void drafts.close(); }}>{t("drafts.close")}</button>}
                {active.state === "closed" && <button disabled={drafts.busy} onClick={() => { void drafts.reopen(); }}>{t("drafts.reopen")}</button>}
                {maintainer && active.state !== "open" && <button className="danger" disabled={drafts.busy} onClick={() => { if (confirmAction(t("drafts.cleanupConfirm", { id: active.draft_id }))) void drafts.cleanup(); }}>{t("drafts.cleanup")}</button>}
              </div>
              <p className="polling">{t("drafts.polling")} {t("drafts.updated", { time: formatDateTime(locale, active.updated_at) })}</p>
            </>}
          </div>
        </section>}
        {["nav.portfolio", "nav.projects", "nav.tasks"].includes(view) && (active === undefined
          ? <div className="card empty-workspace">{t("core.selectProject")}</div>
          : <CoreWorkspace api={api} draft={active} locale={locale} onChanged={drafts.refresh} />)}
        {["nav.people", "nav.calendar", "nav.settings"].includes(view) && (active === undefined
          ? <div className="card empty-workspace">{t("core.selectProject")}</div>
          : <AdminWorkspace api={api} draft={active} role={drafts.session.role} locale={locale} surface={view === "nav.people" ? "people" : view === "nav.calendar" ? "calendar" : "settings"} onChanged={drafts.refresh} />)}
        {view === "nav.changes" && (active === undefined ? <div className="card empty-workspace">{t("core.selectProject")}</div> : <ChangesWorkspace api={api} draft={active} role={drafts.session.role} locale={locale} onChanged={drafts.refresh} confirmAction={confirmAction} remoteAvailable={repository?.has_remote === true} gitlabConfigured={gitlab?.configured === true} gitlabSignedIn={gitlab?.user !== undefined} onGitLabLogin={loginToGitLab} />)}
        {view === "nav.history" && (active === undefined ? <div className="card empty-workspace">{t("core.selectProject")}</div> : <HistoryWorkspace api={api} draft={active} locale={locale} canRevert={drafts.session.role !== "Reporter"} onDraftCreated={drafts.select} />)}
        {view === "nav.board" && (active === undefined ? <div className="card empty-workspace">{t("core.selectProject")}</div> : <BoardWorkspace api={api} draft={active} locale={locale} onChanged={drafts.refresh} />)}
        {view === "nav.gantt" && (active === undefined ? <div className="card empty-workspace">{t("core.selectProject")}</div> : <GanttWorkspace api={api} draft={active} locale={locale} />)}
        {view === "nav.workload" && (active === undefined ? <div className="card empty-workspace">{t("core.selectProject")}</div> : <WorkloadWorkspace api={api} draft={active} locale={locale} />)}
        {!["nav.drafts", "nav.portfolio", "nav.projects", "nav.tasks", "nav.people", "nav.calendar", "nav.settings", "nav.changes", "nav.history", "nav.board", "nav.gantt", "nav.workload"].includes(view) && <div className="card empty-workspace">{t("common.notAvailable")}</div>}
      </main>
    </div>
  );
}

function LocalePicker({ locale, setLocale, t }: { readonly locale: Locale; readonly setLocale: (locale: Locale) => void; readonly t: (key: MessageKey) => string }) {
  return <label className="locale-picker">{t("locale.label")}<select aria-label={t("locale.label")} value={locale} onChange={(event) => setLocale(event.target.value as Locale)}>{Object.entries(localeRegistry).map(([key, definition]) => <option value={key} key={key}>{t(definition.labelKey)}</option>)}</select></label>;
}

export function App({ api, storage = window.localStorage, browserLanguages = navigator.languages, navigate = (url) => window.location.assign(url), confirmAction = (value) => window.confirm(value) }: AppProps) {
  const initial = useMemo(() => selectLocale(storage.getItem(LOCALE_STORAGE_KEY), browserLanguages), []);
  const [locale, setLocaleState] = useState<Locale>(initial);
  const setLocale = (next: Locale) => { const definition = localeRegistry[next] ?? localeRegistry.en; storage.setItem(LOCALE_STORAGE_KEY, next); setLocaleState(next); document.documentElement.lang = definition.languageTag; document.documentElement.dir = definition.direction; };
  const definition = localeRegistry[locale] ?? localeRegistry.en;
  document.documentElement.lang = definition.languageTag;
  document.documentElement.dir = definition.direction;
  return <DraftProvider api={api}><Shell locale={locale} setLocale={setLocale} api={api} navigate={navigate} confirmAction={confirmAction} /></DraftProvider>;
}
