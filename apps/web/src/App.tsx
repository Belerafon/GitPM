import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
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
import type { WorkspaceDestination, WorkspaceSelection } from "./workspace-navigation.js";
import { parseAppRoute, routeForDestination, serializeAppRoute, type AppRoute, type AppRouteName } from "./app/router.js";

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

const routeViews: Readonly<Record<AppRouteName, MessageKey>> = {
  workspaces: "nav.drafts", portfolio: "nav.portfolio", projects: "nav.projects", tasks: "nav.tasks", board: "nav.board",
  people: "nav.people", calendars: "nav.calendar", settings: "nav.settings", workload: "nav.workload", gantt: "nav.gantt",
  changes: "nav.changes", history: "nav.history",
};

const navigationDestinations: Readonly<Partial<Record<MessageKey, WorkspaceDestination | "workspaces">>> = {
  "nav.drafts": "workspaces", "nav.portfolio": "portfolio", "nav.projects": "projects", "nav.tasks": "tasks", "nav.board": "board",
  "nav.people": "people", "nav.calendar": "calendar", "nav.settings": "settings", "nav.workload": "workload", "nav.gantt": "gantt",
  "nav.changes": "changes", "nav.history": "history",
};

function Shell({ locale, setLocale, api, navigate, confirmAction }: {
  readonly locale: Locale;
  readonly setLocale: (locale: Locale) => void;
  readonly api: GitPmApi;
  readonly navigate: (url: string) => void;
  readonly confirmAction: (message: string) => boolean;
}) {
  const drafts = useDrafts();
  const [draftId, setDraftId] = useState("");
  const [activeRoute, setActiveRoute] = useState<AppRoute | null>(() => parseAppRoute(window.location.href));
  const [navigationOpen, setNavigationOpen] = useState(false);
  const navigationButtonRef = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  const repositoryMode = drafts.session?.mode === "repository";
  const view = activeRoute === null ? (repositoryMode ? "nav.projects" : "nav.drafts") : routeViews[activeRoute.name];
  const workspaceSelection: WorkspaceSelection = { projectId: activeRoute?.projectId, taskId: activeRoute?.taskId, commit: activeRoute?.commit, query: activeRoute?.query };
  const t = (key: MessageKey, values?: Readonly<Record<string, string | number>>) => message(locale, key, values);
  const workspaceName = (id: string) => repositoryMode && id === "DRF-LOCAL" ? t("drafts.localName") : id;
  const workspaceState = (state: string) => t(({ open: "drafts.stateOpen", closed: "drafts.stateClosed", published: "drafts.statePublished", abandoned: "drafts.stateAbandoned" } as const)[state as "open" | "closed" | "published" | "abandoned"] ?? "drafts.state");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = draftId.trim();
    if (value !== "") { void drafts.create(value); setDraftId(""); }
  };
  const navigateToRoute = (nextRoute: AppRoute, replace = false) => {
    const nextUrl = serializeAppRoute(nextRoute);
    if (`${window.location.pathname}${window.location.search}` !== nextUrl) window.history[replace ? "replaceState" : "pushState"]({}, "", nextUrl);
    setActiveRoute(nextRoute);
  };
  const openWorkspace = (destination: WorkspaceDestination, selection: WorkspaceSelection = {}) => {
    navigateToRoute(routeForDestination(destination, selection));
    setNavigationOpen(false);
  };
  const selectNavigationView = (key: MessageKey) => {
    const destination = navigationDestinations[key];
    if (destination !== undefined) navigateToRoute(routeForDestination(destination));
    setNavigationOpen(false);
  };

  useEffect(() => {
    const restoreRoute = () => setActiveRoute(parseAppRoute(window.location.href));
    window.addEventListener("popstate", restoreRoute);
    return () => window.removeEventListener("popstate", restoreRoute);
  }, []);

  useEffect(() => {
    if (drafts.session === undefined || activeRoute !== null || window.location.pathname !== "/") return;
    navigateToRoute(routeForDestination(repositoryMode ? "projects" : "workspaces"), true);
  }, [activeRoute, drafts.session, repositoryMode]);

  useEffect(() => {
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    if (workspaceRef.current !== null) workspaceRef.current.scrollTop = 0;
    const heading = workspaceRef.current?.querySelector<HTMLElement>(".section-heading h2, .draft-list h2, .empty-workspace");
    if (heading !== null && heading !== undefined) { heading.tabIndex = -1; heading.focus(); }
  }, [view]);

  useEffect(() => {
    if (!navigationOpen) return;
    sidebarRef.current?.querySelector<HTMLButtonElement>("nav button")?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setNavigationOpen(false);
      navigationButtonRef.current?.focus();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [navigationOpen]);

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
    <div className={`app-shell${repositoryMode ? " repository-mode" : ""}`}>
      <button aria-label={t("nav.closeMenu")} className={`navigation-backdrop${navigationOpen ? " open" : ""}`} onClick={() => { setNavigationOpen(false); navigationButtonRef.current?.focus(); }} tabIndex={navigationOpen ? 0 : -1} />
      <aside aria-label={t("nav.label")} className={`sidebar${navigationOpen ? " open" : ""}`} id="primary-navigation" ref={sidebarRef}>
        <div className="brand"><span className="brand-mark">G</span><strong>{t("app.title")}</strong></div>
        <nav>{navigation.map((key) => <button aria-current={view === key ? "page" : undefined} className={view === key ? "active" : ""} key={key} onClick={() => selectNavigationView(key)}>{t(key)}</button>)}</nav>
        <div className="repository-card"><span>{t("app.singleRepository")}</span><strong>{repository?.name ?? t("app.repository")}</strong></div>
      </aside>
      <main className="workspace" ref={workspaceRef}>
        <header className="topbar">
          <button aria-controls="primary-navigation" aria-expanded={navigationOpen} aria-label={t("nav.openMenu")} className="navigation-toggle" onClick={() => setNavigationOpen((open) => !open)} ref={navigationButtonRef}><span aria-hidden="true">☰</span></button>
          <div><h1>{repository?.name ?? t("app.repository")}</h1><p>{repository?.path ?? drafts.session.user.username} · {t("auth.localMode")} · {t("auth.role", { role: drafts.session.role })}</p></div>
          <div className="top-actions">
            {active !== undefined && <button aria-label={`${t("drafts.current")}: ${workspaceName(active.draft_id)} · ${workspaceState(active.state)}`} className="workspace-switcher" onClick={() => selectNavigationView("nav.drafts")}>
              <span>{t("drafts.current")}</span><strong>{workspaceName(active.draft_id)}</strong>
              <span className={`state ${active.state}`}>{workspaceState(active.state)}</span>
            </button>}
            <LocalePicker locale={locale} setLocale={setLocale} t={t} />
            {gitlab?.configured === true && gitlab.user === undefined && <button onClick={loginToGitLab}>{t("auth.login")}</button>}
            {gitlab?.user !== undefined && <><span>{gitlab.user.username}</span><button onClick={() => { void drafts.logout(); }}>{t("auth.logoutGitLab")}</button></>}
          </div>
        </header>
        {drafts.error !== null && <div className="alert error">{t("status.error", { message: drafts.error })}<button onClick={() => { void drafts.refresh(); }}>{t("status.retry")}</button></div>}
        {view === "nav.drafts" && <section className="draft-layout">
          <div className="draft-list card">
            <h2>{t("drafts.heading")}</h2><p className="workspace-description">{t("drafts.description")}</p>
            <form onSubmit={submit}><label htmlFor="draft-id">{t("drafts.id")}</label><div className="inline"><input id="draft-id" value={draftId} onChange={(event) => setDraftId(event.target.value)} pattern="[A-Za-z0-9][A-Za-z0-9-]{0,127}" required /><button className="primary" disabled={drafts.busy || drafts.session.role === "Reporter"}>{t("drafts.create")}</button></div></form>
            <div className="draft-items">{drafts.drafts.length === 0 ? <p>{t("drafts.empty")}</p> : drafts.drafts.map((draft) => (
              <button aria-label={`${workspaceName(draft.draft_id)} · ${draft.draft_id} · ${draft.branch} · ${workspaceState(draft.state)}`} className={active?.draft_id === draft.draft_id ? "draft-item selected" : "draft-item"} key={draft.draft_id} onClick={() => { void drafts.select(draft.draft_id); }}>
                <strong>{workspaceName(draft.draft_id)}</strong><code>{draft.draft_id}</code><span>{draft.branch}</span><span className={`state ${draft.state}`}>{workspaceState(draft.state)}</span>
              </button>
            ))}</div>
          </div>
          <div className="draft-detail card">
            {snapshot === null || active === undefined ? <p>{t("drafts.empty")}</p> : <>
              <div className="detail-heading"><div><span className="eyebrow">{t("drafts.current")}</span><h2>{workspaceName(active.draft_id)}</h2><code>{active.draft_id}</code></div><span className={`state ${active.state}`}>{workspaceState(active.state)}</span></div>
              {external && <div className="alert warning">{t("drafts.externalWarning")}</div>}
              {!external && active.changed_externally === true && <div className="alert error">{t("drafts.changedExternally")}</div>}
              {snapshot.changes.changed_files_count > 0 && <div className="alert info">{t("drafts.localWarning")}</div>}
              <dl className="status-grid">
                <div><dt>{t("drafts.branch")}</dt><dd><code>{active.branch}</code></dd></div>
                <div><dt>{t("drafts.writerMode")}</dt><dd>{t(external ? "drafts.writerExternal" : "drafts.writerUi")}</dd></div>
                <div><dt>{t("drafts.dirty")}</dt><dd>{snapshot.changes.changed_files_count}</dd></div>
                <div><dt>{t("drafts.validation")}</dt><dd className={snapshot.validation.valid ? "valid" : "invalid"}>{snapshot.validation.valid ? t("drafts.validationValid") : t("drafts.validationInvalid", { count: snapshot.validation.error_count })}</dd></div>
                <div><dt>{t("drafts.mr")}</dt><dd>{snapshot.mergeRequest?.state ?? t("drafts.noMr")}</dd></div>
                <div><dt>{t("drafts.state")}</dt><dd>{workspaceState(active.state)}</dd></div>
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
          : <CoreWorkspace api={api} confirmAction={confirmAction} draft={active} key={`${view}:${workspaceSelection.projectId ?? ""}:${workspaceSelection.taskId ?? ""}:${workspaceSelection.query?.status?.[0] ?? ""}`} locale={locale} surface={view === "nav.portfolio" ? "portfolio" : view === "nav.tasks" ? "tasks" : "projects"} initialProjectId={workspaceSelection.projectId} initialTaskId={workspaceSelection.taskId} initialStatusFilter={workspaceSelection.query?.status?.[0]} onNavigate={openWorkspace} onChanged={drafts.refresh} />)}
        {["nav.people", "nav.calendar", "nav.settings"].includes(view) && (active === undefined
          ? <div className="card empty-workspace">{t("core.selectProject")}</div>
          : <AdminWorkspace api={api} confirmAction={confirmAction} draft={active} role={drafts.session.role} locale={locale} surface={view === "nav.people" ? "people" : view === "nav.calendar" ? "calendar" : "settings"} onChanged={drafts.refresh} />)}
        {view === "nav.changes" && (active === undefined ? <div className="card empty-workspace">{t("core.selectProject")}</div> : <ChangesWorkspace api={api} draft={active} role={drafts.session.role} locale={locale} onChanged={drafts.refresh} confirmAction={confirmAction} remoteAvailable={repository?.has_remote === true} gitlabConfigured={gitlab?.configured === true} gitlabSignedIn={gitlab?.user !== undefined} onGitLabLogin={loginToGitLab} />)}
        {view === "nav.history" && (active === undefined ? <div className="card empty-workspace">{t("core.selectProject")}</div> : <HistoryWorkspace api={api} draft={active} key={`nav.history:${workspaceSelection.commit ?? ""}`} locale={locale} canRevert={drafts.session.role !== "Reporter"} initialCommit={workspaceSelection.commit} onNavigate={openWorkspace} onDraftCreated={drafts.select} />)}
        {view === "nav.board" && (active === undefined ? <div className="card empty-workspace">{t("core.selectProject")}</div> : <BoardWorkspace api={api} draft={active} key={`nav.board:${workspaceSelection.projectId ?? ""}`} locale={locale} initialProjectId={workspaceSelection.projectId} onNavigate={openWorkspace} onChanged={drafts.refresh} />)}
        {view === "nav.gantt" && (active === undefined ? <div className="card empty-workspace">{t("core.selectProject")}</div> : <GanttWorkspace api={api} draft={active} key={`nav.gantt:${workspaceSelection.projectId ?? ""}`} locale={locale} initialProjectId={workspaceSelection.projectId} onNavigate={openWorkspace} />)}
        {view === "nav.workload" && (active === undefined ? <div className="card empty-workspace">{t("core.selectProject")}</div> : <WorkloadWorkspace api={api} draft={active} locale={locale} onNavigate={openWorkspace} />)}
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
