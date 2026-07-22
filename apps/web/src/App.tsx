import { useEffect, useMemo, useState, type FormEvent } from "react";
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
import { parseAppRoute, routeForDestination, serializeAppRoute, type AppRoute } from "./app/router.js";
import { AppShell } from "./app/AppShell.js";
import { navigationDestinations, navigationGroups, routeViews } from "./app/navigation.js";
import { SectionTabs, type SectionTab } from "./app/SectionTabs.js";
import { ProjectTabs } from "./features/projects/project-tabs.js";
import { ProjectPlanWorkspace } from "./features/projects/project-plan-workspace.js";
import { EntityCatalog } from "./entity-catalog.js";
import { PeopleProfileWorkspace } from "./people-profile-ui.js";
import { NotificationsMenu } from "./notifications-ui.js";
import { WorktreeWorkspace } from "./worktree-ui.js";
import { RepositoryConnectionSettings } from "./repository-connection-ui.js";

interface AppProps {
  readonly api: GitPmApi;
  readonly storage?: Pick<Storage, "getItem" | "setItem">;
  readonly browserLanguages?: readonly string[];
  readonly navigate?: (url: string) => void;
  readonly confirmAction?: (message: string) => boolean;
}

const teamTabs: readonly SectionTab[] = [
  { destination: "workload", label: "nav.workload" },
  { destination: "people", label: "nav.people" },
  { destination: "calendar", label: "nav.calendar" },
];

const suggestedDraftId = () => `DRF-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${Math.random().toString(36).slice(2, 6).toUpperCase().padEnd(4, "0")}`;

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
  const [catalog, setCatalog] = useState(() => new EntityCatalog({}));
  const repositoryMode = drafts.session?.mode === "repository";
  const directMode = drafts.session?.repository_mode === "direct";
  const repositoryTabs: readonly SectionTab[] = directMode
    ? [
        { destination: "changes", label: "nav.changes" },
        { destination: "files", label: "nav.files" },
        { destination: "history", label: "nav.history" },
        { destination: "connection", label: "nav.repositoryConnection" },
      ]
    : [
        { destination: "workspaces", label: "nav.drafts" },
        { destination: "changes", label: "nav.changes" },
        { destination: "files", label: "nav.files" },
        { destination: "history", label: "nav.history" },
        { destination: "connection", label: "nav.repositoryConnection" },
      ];
  const rawView = activeRoute === null ? (repositoryMode ? "nav.projects" : "nav.drafts") : routeViews[activeRoute.name];
  // Direct mode has no drafts/workspaces surface; a stale deep link or the
  // repository nav lands on changes instead of the draft management panel.
  const view: typeof rawView = directMode && rawView === "nav.drafts" ? "nav.changes" : rawView;
  const shellActiveView = activeRoute?.projectId !== undefined && ["projects", "stages", "tasks", "board", "gantt"].includes(activeRoute.name)
    ? "nav.projects"
    : ["nav.people", "nav.workload", "nav.calendar"].includes(view)
      ? "nav.team"
      : ["nav.drafts", "nav.changes", "nav.files", "nav.history", "nav.repositoryConnection"].includes(view)
        ? "nav.repository"
        : view;
  const workspaceSelection: WorkspaceSelection = { projectId: activeRoute?.projectId, stageId: activeRoute?.stageId, taskId: activeRoute?.taskId, personId: activeRoute?.personId, commit: activeRoute?.commit, query: activeRoute?.query };
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
  useEffect(() => {
    if (repositoryMode && activeRoute === null) navigateToRoute(routeForDestination("projects"), true);
  }, [repositoryMode, activeRoute]);
  const openWorkspace = (destination: WorkspaceDestination, selection: WorkspaceSelection = {}) => {
    navigateToRoute(routeForDestination(destination, selection));
  };
  const selectNavigationView = (key: MessageKey) => {
    const destination = navigationDestinations[key];
    if (destination !== undefined) {
      // In direct mode the Repository section has no drafts/workspaces landing —
      // route to the changes view (branch, commit, push, sync) instead.
      const resolved = destination === "workspaces" && directMode ? "changes" : destination;
      navigateToRoute(routeForDestination(resolved));
    }
  };
  const activeDraft = drafts.snapshot?.draft;
  useEffect(() => {
    const needsProject = activeRoute?.projectId !== undefined;
    const needsTask = activeRoute?.taskId !== undefined;
    const needsStage = activeRoute?.stageId !== undefined;
    if (activeDraft === undefined || (!needsProject && !needsTask && !needsStage)) { setCatalog(new EntityCatalog({})); return; }
    let current = true;
    void Promise.all([
      api.listEntities(activeDraft.draft_id, "projects"),
      needsStage ? api.listEntities(activeDraft.draft_id, "milestones", activeRoute?.projectId) : Promise.resolve([]),
      needsTask ? api.listEntities(activeDraft.draft_id, "tasks", activeRoute?.projectId) : Promise.resolve([]),
    ]).then(([projects, milestones, tasks]) => { if (current) setCatalog(new EntityCatalog({ projects, milestones, tasks })); }).catch(() => { if (current) setCatalog(new EntityCatalog({})); });
    return () => { current = false; };
  }, [activeDraft?.draft_id, activeDraft?.fingerprint, activeDraft?.external_fingerprint, activeRoute?.projectId, activeRoute?.stageId, activeRoute?.taskId, api]);
  const breadcrumbs = (() => {
    if (activeRoute?.projectId !== undefined && ["projects", "stages", "tasks"].includes(activeRoute.name)) return <>
      <button onClick={() => navigateToRoute(routeForDestination("projects"))}>{t("nav.projects")}</button><span aria-hidden="true">›</span><span aria-current="page">{catalog.project(activeRoute.projectId).name}</span>
    </>;
    if (activeRoute?.name === "history" && activeRoute.commit !== undefined) return <>
      <button onClick={() => navigateToRoute(routeForDestination("history"))}>{t("nav.history")}</button><span aria-hidden="true">›</span><code aria-current="page">{activeRoute.commit.slice(0, 12)}</code>
    </>;
    if ((activeRoute?.name === "board" || activeRoute?.name === "gantt") && activeRoute.projectId !== undefined) {
      const destination = activeRoute.name === "board" ? "board" : "gantt";
      return <><button onClick={() => navigateToRoute(routeForDestination("projects"))}>{t("nav.projects")}</button><span aria-hidden="true">›</span><button onClick={() => navigateToRoute(routeForDestination("projects", { projectId: activeRoute.projectId }))}>{catalog.project(activeRoute.projectId).name}</button><span aria-hidden="true">›</span><span aria-current="page">{t(destination === "board" ? "nav.board" : "nav.gantt")}</span></>;
    }
    return undefined;
  })();

  useEffect(() => {
    const restoreRoute = () => setActiveRoute(parseAppRoute(window.location.href));
    window.addEventListener("popstate", restoreRoute);
    return () => window.removeEventListener("popstate", restoreRoute);
  }, []);

  useEffect(() => {
    if (activeRoute === null) return;
    const canonical = serializeAppRoute(activeRoute);
    if (`${window.location.pathname}${window.location.search}` !== canonical) window.history.replaceState({}, "", canonical);
  }, [activeRoute]);

  useEffect(() => {
    if (drafts.session === undefined || activeRoute !== null || window.location.pathname !== "/") return;
    navigateToRoute(routeForDestination(repositoryMode ? "projects" : "workspaces"), true);
  }, [activeRoute, drafts.session, repositoryMode]);

  if (drafts.session === undefined) return <main className="center-card"><p>{t("status.loading")}</p></main>;
  if (drafts.session === null) return (
    <main className="center-card auth-card">
      <img className="brand-mark" src="/gitpm-icon.svg" alt="" /><h1>{t("auth.heading")}</h1><p>{t("auth.description")}</p>
      <button className="primary" onClick={() => { void api.login().then(navigate); }}>{t("auth.login")}</button>
      <LocalePicker locale={locale} setLocale={setLocale} t={t} />
      {drafts.error !== null && <p className="alert error">{t("status.error", { message: drafts.error })}</p>}
    </main>
  );

  const snapshot = drafts.snapshot;
  const active = activeDraft;
  const external = active?.writer_mode === "external";
  const maintainer = drafts.session.role === "Maintainer";
  const repository = drafts.session.repository;
  const gitlab = drafts.session.gitlab;
  const loginToGitLab = () => { void api.login().then(navigate); };
  const projectWorkspaceRoute = activeRoute?.projectId !== undefined && ["projects", "stages", "tasks"].includes(activeRoute.name);
  const pageTitle = activeRoute?.projectId !== undefined && ["projects", "stages", "tasks"].includes(activeRoute.name) ? t("projectTabs.overview") : t(view);
  const repositoryStatus = snapshot === null || snapshot.changes.changed_files_count === 0 ? undefined : {
    label: String(snapshot.changes.changed_files_count),
    description: t("changes.statusDescription", { files: snapshot.changes.changed_files_count }),
  };
  const openRepositoryStatus = () => navigateToRoute(routeForDestination("changes"));
  return (
    <AppShell activeView={shellActiveView}
      banner={drafts.error !== null && <div className="alert error">{t("status.error", { message: drafts.error })}<button onClick={() => { void drafts.refresh(); }}>{t("status.retry")}</button></div>}
      breadcrumbs={breadcrumbs}
        headerMeta={<><strong>{repository?.name ?? t("app.repository")}</strong>{directMode && repository?.branch !== undefined && <span className="runtime-context"><code>{repository.branch}</code></span>}<span className="runtime-context">{t("auth.localMode")} · {t("auth.role", { role: drafts.session.role })}</span></>}
      headerTitle={pageTitle}
      navigationGroups={navigationGroups}
      onNavigate={selectNavigationView}
      onOpenRepositoryStatus={openRepositoryStatus}
      repositoryDetails={<><strong>{t("app.repositoryDetails")}</strong><code>{repository?.path ?? drafts.session.user.username}</code>{directMode && repository?.branch !== undefined && <><span className="runtime-context">{t("drafts.branch")}</span><code>{repository.branch}</code></>}</>}
      repositoryMode={repositoryMode}
      repositoryName={repository?.name ?? t("app.repository")}
      repositoryStatus={repositoryStatus}
      showSingleRepositoryLabel={!directMode}
      t={t}
      topActions={<>
            <NotificationsMenu api={api} draft={active} locale={locale} namespace={`${repository?.path ?? repository?.name ?? "repository"}:${drafts.session.user.id}`} onNavigate={openWorkspace} />
            {active !== undefined && !directMode && <div className="workspace-switcher">
              <label htmlFor="current-workspace">{t("drafts.current")}</label>
              <div className="workspace-selection-row">
                <select id="current-workspace" value={active.draft_id} onChange={(event) => { void drafts.select(event.target.value); }}>
                  {drafts.drafts.map((draft) => <option key={draft.draft_id} value={draft.draft_id}>{workspaceName(draft.draft_id)}</option>)}
                </select>
                <span className={`state ${active.state}`}>{workspaceState(active.state)}</span>
              </div>
            </div>}
            <InterfaceSettings locale={locale} setLocale={setLocale} t={t} />
            {gitlab?.configured === true && gitlab.user === undefined && <button onClick={loginToGitLab}>{t("auth.login")}</button>}
            {gitlab?.user !== undefined && <><span>{gitlab.user.username}</span><button onClick={() => { void drafts.logout(); }}>{t("auth.logoutGitLab")}</button></>}
          </>}
    >
        {["nav.people", "nav.workload", "nav.calendar"].includes(view) && <SectionTabs active={view} ariaLabel={t("nav.team")} items={teamTabs} onNavigate={(destination) => navigateToRoute(routeForDestination(destination))} t={t} />}
        {["nav.drafts", "nav.changes", "nav.files", "nav.history", "nav.repositoryConnection"].includes(view) && <SectionTabs active={view} ariaLabel={t("nav.repository")} items={repositoryTabs} onNavigate={(destination) => navigateToRoute(routeForDestination(destination))} t={t} />}
        {view === "nav.drafts" && <section className="draft-layout">
          <div className="draft-list card">
            <h2 aria-hidden="true">{t("drafts.heading")}</h2><p className="workspace-description">{t("drafts.description")}</p>
            <form onSubmit={submit}><label htmlFor="draft-id">{t("drafts.id")}</label><p className="field-hint" id="draft-id-hint">{t("drafts.idHint")}</p><div className="inline draft-create-row"><input aria-describedby="draft-id-hint" id="draft-id" placeholder={t("drafts.idExample")} value={draftId} onChange={(event) => setDraftId(event.target.value)} pattern="[A-Za-z0-9][A-Za-z0-9-]{0,127}" required /><button type="button" onClick={() => setDraftId(suggestedDraftId())}>{t("drafts.generateId")}</button><button className="primary" disabled={drafts.busy || drafts.session.role === "Reporter"}>{t("drafts.create")}</button></div></form>
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
              {!external && active.changed_externally === true && <div className="alert error"><span>{t("drafts.changedExternally")}</span><button onClick={() => { void drafts.acknowledgeExternalChanges(); }} type="button">{t("readOnly.acknowledge")}</button></div>}
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
              {active.state === "open" && <p className="draft-action-hint">{t(external ? "drafts.writerHintExternal" : "drafts.writerHintUi")} {t("drafts.closeHint")}</p>}
              <p className="polling">{t("drafts.polling")} {t("drafts.updated", { time: formatDateTime(locale, active.updated_at) })}</p>
            </>}
          </div>
        </section>}
        {activeRoute?.projectId !== undefined && ["projects", "stages", "tasks", "board", "gantt"].includes(activeRoute.name) && <ProjectTabs
          active={(["stages", "tasks"].includes(activeRoute.name) ? "projects" : activeRoute.name === "gantt" ? "gantt" : activeRoute.name) as WorkspaceDestination}
          onNavigate={openWorkspace}
          projectId={activeRoute.projectId}
          query={activeRoute.query}
          t={t}
        />}
        {projectWorkspaceRoute && activeRoute?.projectId !== undefined && (active === undefined
          ? <div className="card empty-workspace">{t("core.selectProject")}</div>
          : <ProjectPlanWorkspace api={api} confirmAction={confirmAction} draft={active} initialMilestoneFilter={workspaceSelection.query?.milestone?.[0]} initialStatusFilter={workspaceSelection.query?.status?.[0]} key={`project-plan:${activeRoute.projectId}`} locale={locale} onChanged={drafts.refresh} onNavigate={openWorkspace} projectId={activeRoute.projectId} selectedStageId={activeRoute.stageId} selectedTaskId={activeRoute.taskId} />)}
        {["nav.portfolio", "nav.projects", "nav.tasks"].includes(view) && !projectWorkspaceRoute && (active === undefined
          ? <div className="card empty-workspace">{t("core.selectProject")}</div>
          : <CoreWorkspace api={api} confirmAction={confirmAction} draft={active} key={`${view}:${workspaceSelection.projectId ?? ""}:${workspaceSelection.taskId ?? ""}`} locale={locale} surface={view === "nav.portfolio" ? "portfolio" : view === "nav.tasks" ? "tasks" : "projects"} initialProjectId={workspaceSelection.projectId} initialTaskId={workspaceSelection.taskId} initialCommentId={workspaceSelection.query?.comment?.[0]} initialStatusFilter={workspaceSelection.query?.status?.[0]} initialMilestoneFilter={workspaceSelection.query?.milestone?.[0]} onNavigate={openWorkspace} onChanged={drafts.refresh} />)}
        {["nav.people", "nav.calendar", "nav.settings"].includes(view) && (active === undefined
          ? <div className="card empty-workspace">{t("core.selectProject")}</div>
          : view === "nav.people" && workspaceSelection.personId !== undefined
            ? <PeopleProfileWorkspace api={api} confirmAction={confirmAction} draft={active} locale={locale} onChanged={drafts.refresh} onNavigate={openWorkspace} personId={workspaceSelection.personId} role={drafts.session.role} />
            : <AdminWorkspace api={api} confirmAction={confirmAction} draft={active} role={drafts.session.role} locale={locale} onOpenPerson={(personId) => openWorkspace("people", { personId })} surface={view === "nav.people" ? "people" : view === "nav.calendar" ? "calendar" : "settings"} onChanged={drafts.refresh} />)}
        {view === "nav.changes" && (active === undefined ? <div className="card empty-workspace">{t("core.selectProject")}</div> : <ChangesWorkspace api={api} draft={active} role={drafts.session.role} locale={locale} onChanged={drafts.refresh} confirmAction={confirmAction} remoteAvailable={repository?.has_remote === true} gitlabConfigured={gitlab?.configured === true} gitlabSignedIn={gitlab?.user !== undefined} onGitLabLogin={loginToGitLab} directMode={directMode} />)}
        {view === "nav.files" && (active === undefined ? <div className="card empty-workspace">{t("core.selectProject")}</div> : <WorktreeWorkspace api={api} confirmAction={confirmAction} draft={active} key={`nav.files:${active.draft_id}:${active.external_fingerprint ?? ""}`} locale={locale} onChanged={drafts.refresh} role={drafts.session.role} />)}
        {view === "nav.history" && (active === undefined ? <div className="card empty-workspace">{t("core.selectProject")}</div> : <HistoryWorkspace api={api} draft={active} key={`nav.history:${workspaceSelection.commit ?? ""}`} locale={locale} canRevert={drafts.session.role !== "Reporter" && !directMode} initialCommit={workspaceSelection.commit} onNavigate={openWorkspace} onDraftCreated={drafts.select} />)}
        {view === "nav.repositoryConnection" && <div className="repository-connection-page"><RepositoryConnectionSettings api={api} locale={locale} maintainer={maintainer} confirmAction={confirmAction} /></div>}
        {view === "nav.board" && (active === undefined ? <div className="card empty-workspace">{t("core.selectProject")}</div> : <BoardWorkspace api={api} draft={active} key={`nav.board:${workspaceSelection.projectId ?? ""}`} locale={locale} initialProjectId={workspaceSelection.projectId} initialStatusFilter={workspaceSelection.query?.status?.[0]} initialTypeFilter={workspaceSelection.query?.type?.[0]} initialMilestoneFilter={workspaceSelection.query?.milestone?.[0]} initialViewId={workspaceSelection.query?.view?.[0]} onNavigate={openWorkspace} onChanged={drafts.refresh} />)}
        {view === "nav.gantt" && (active === undefined ? <div className="card empty-workspace">{t("core.selectProject")}</div> : <GanttWorkspace api={api} draft={active} key={`nav.gantt:${workspaceSelection.projectId ?? ""}`} locale={locale} initialProjectId={workspaceSelection.projectId} onNavigate={openWorkspace} />)}
        {view === "nav.workload" && (active === undefined ? <div className="card empty-workspace">{t("core.selectProject")}</div> : <WorkloadWorkspace api={api} draft={active} locale={locale} onNavigate={openWorkspace} />)}
        {!projectWorkspaceRoute && !["nav.drafts", "nav.portfolio", "nav.projects", "nav.tasks", "nav.people", "nav.calendar", "nav.settings", "nav.changes", "nav.files", "nav.history", "nav.repositoryConnection", "nav.board", "nav.gantt", "nav.workload"].includes(view) && <div className="card empty-workspace">{t("common.notAvailable")}</div>}
    </AppShell>
  );
}

function LocalePicker({ locale, setLocale, t }: { readonly locale: Locale; readonly setLocale: (locale: Locale) => void; readonly t: (key: MessageKey) => string }) {
  return <label className="locale-picker">{t("locale.label")}<select aria-label={t("locale.label")} value={locale} onChange={(event) => setLocale(event.target.value as Locale)}>{Object.entries(localeRegistry).map(([key, definition]) => <option value={key} key={key}>{t(definition.labelKey)}</option>)}</select></label>;
}

function InterfaceSettings({ locale, setLocale, t }: { readonly locale: Locale; readonly setLocale: (locale: Locale) => void; readonly t: (key: MessageKey) => string }) {
  return <details className="interface-settings">
    <summary aria-label={t("settings.interface")} title={t("settings.interface")}><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Zm8.1 4.7a8.6 8.6 0 0 0 0-2.4l2-1.5-2-3.5-2.5 1a9.6 9.6 0 0 0-2.1-1.2L15.2 3h-4l-.4 2.6a9.6 9.6 0 0 0-2.1 1.2l-2.4-1-2 3.5 2 1.5a8.6 8.6 0 0 0 0 2.4l-2 1.5 2 3.5 2.4-1a9.6 9.6 0 0 0 2.1 1.2l.4 2.6h4l.4-2.6a9.6 9.6 0 0 0 2.1-1.2l2.5 1 2-3.5-2.1-1.5Z" /></svg></summary>
    <div className="interface-settings-panel"><strong>{t("settings.interface")}</strong><LocalePicker locale={locale} setLocale={setLocale} t={t} /></div>
  </details>;
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
