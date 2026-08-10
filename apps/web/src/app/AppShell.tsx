import { useEffect, useRef, useState, type ReactNode } from "react";
import type { MessageKey } from "../i18n.js";
import { BUILD_VERSION } from "../version.js";

export interface NavigationGroup {
  readonly label: MessageKey;
  readonly items: readonly MessageKey[];
}

const SIDEBAR_COLLAPSED_STORAGE_KEY = "gitpm.navigation.sidebarCollapsed";

function readSidebarCollapsed(): boolean {
  if (typeof localStorage === "undefined") return false;
  try { return localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true"; } catch { return false; }
}

function writeSidebarCollapsed(collapsed: boolean) {
  try { localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, collapsed ? "true" : "false"); } catch { /* Browser storage may be unavailable. */ }
}

const NAVIGATION_ICON: Partial<Record<MessageKey, ReactNode>> = {
  "nav.projects": <svg aria-hidden="true" viewBox="0 0 16 16"><path d="M1.5 4.5h4l1.4 1.4h7.6v8h-13z" /></svg>,
  "nav.team": <svg aria-hidden="true" viewBox="0 0 16 16"><circle cx="6" cy="5.2" r="2.3" /><path d="M1.6 13.4c0-2.4 2-3.9 4.4-3.9s4.4 1.5 4.4 3.9" /><path d="M10.8 5.3a2.2 2.2 0 0 1 0 4.2" /><path d="M12.4 13.4c0-1.6-.9-2.9-2.3-3.5" /></svg>,
  "nav.repository": <svg aria-hidden="true" viewBox="0 0 16 16"><circle cx="4" cy="3.5" r="1.3" /><circle cx="4" cy="12.5" r="1.3" /><circle cx="12" cy="3.5" r="1.3" /><path d="M4 4.8v6.4" /><path d="M12 4.8c0 3.8-8 1.8-8 5.7" /></svg>,
  "nav.settings": <svg aria-hidden="true" viewBox="0 0 16 16"><path d="M2 4h12M2 8h12M2 12h12" /><circle cx="6" cy="4" r="1.5" /><circle cx="10.5" cy="8" r="1.5" /><circle cx="5" cy="12" r="1.5" /></svg>,
};

export function AppShell({ activeView, banner, breadcrumbs, children, headerMeta, headerSearch, headerTitle, navigationGroups, onNavigate, onOpenRepositoryStatus, repositoryMode, repositoryStatus, t, topActions }: {
  readonly activeView: MessageKey;
  readonly banner?: ReactNode;
  readonly breadcrumbs?: ReactNode;
  readonly children: ReactNode;
  readonly headerMeta: ReactNode;
  readonly headerSearch?: ReactNode;
  readonly headerTitle: string;
  readonly navigationGroups: readonly NavigationGroup[];
  readonly onNavigate: (key: MessageKey) => void;
  readonly onOpenRepositoryStatus?: () => void;
  readonly repositoryMode: boolean;
  readonly repositoryStatus?: { readonly label: string; readonly description: string };
  readonly t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string;
  readonly topActions: ReactNode;
}) {
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed);
  const navigationButtonRef = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const workspaceRef = useRef<HTMLElement>(null);

  useEffect(() => { writeSidebarCollapsed(sidebarCollapsed); }, [sidebarCollapsed]);

  useEffect(() => {
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    if (workspaceRef.current !== null) workspaceRef.current.scrollTop = 0;
    const heading = workspaceRef.current?.querySelector<HTMLElement>(".topbar h1, .section-heading h2, .draft-list h2, .empty-workspace");
    if (heading !== null && heading !== undefined) { heading.tabIndex = -1; heading.focus(); }
  }, [activeView, headerTitle]);

  useEffect(() => {
    if (!navigationOpen) return;
    (sidebarRef.current?.querySelector<HTMLButtonElement>('nav button[aria-current="page"]') ?? sidebarRef.current?.querySelector<HTMLButtonElement>("nav button"))?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleNavigationKeys = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setNavigationOpen(false);
        navigationButtonRef.current?.focus();
        return;
      }
      if (event.key !== "Tab" || sidebarRef.current === null) return;
      const focusable = Array.from(sidebarRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), summary, [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'))
        .filter((item) => item.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", handleNavigationKeys);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleNavigationKeys);
    };
  }, [navigationOpen]);

  const closeNavigation = () => { setNavigationOpen(false); navigationButtonRef.current?.focus(); };
  const navigate = (key: MessageKey) => { onNavigate(key); setNavigationOpen(false); };

  return <div className={`app-shell${repositoryMode ? " repository-mode" : ""}${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
    <button aria-label={t("nav.closeMenu")} className={`navigation-backdrop${navigationOpen ? " open" : ""}`} onClick={closeNavigation} tabIndex={navigationOpen ? 0 : -1} />
    <aside aria-label={t("nav.label")} className={`sidebar${navigationOpen ? " open" : ""}`} id="primary-navigation" ref={sidebarRef}>
      <div className="sidebar-heading"><div className="brand"><img className="brand-mark" src="/gitpm-icon.svg" alt="" /><strong className="brand-title">{t("app.title")}</strong></div><button aria-label={sidebarCollapsed ? t("nav.expandSidebar") : t("nav.collapseSidebar")} className="sidebar-collapse-toggle" onClick={() => setSidebarCollapsed((collapsed) => !collapsed)} title={sidebarCollapsed ? t("nav.expandSidebar") : t("nav.collapseSidebar")} type="button"><svg aria-hidden="true" viewBox="0 0 16 16"><path d={sidebarCollapsed ? "M5 3 11 8 5 13" : "M11 3 5 8 11 13"} /></svg></button><button aria-label={t("nav.closeMenu")} className="navigation-close" onClick={closeNavigation} title={t("nav.closeMenu")} type="button">×</button></div>
      <nav className="navigation-groups">{navigationGroups.map((group) => <div className="navigation-group" key={group.label}>
        {group.items.length > 1 && <span className="navigation-group-label">{t(group.label)}</span>}
        <div className="navigation-group-items">{group.items.map((key) => <div className={`navigation-item${activeView === key ? " active" : ""}`} key={key}>
          <button aria-current={activeView === key ? "page" : undefined} aria-label={sidebarCollapsed ? t(key) : undefined} className={activeView === key ? "active" : ""} onClick={() => navigate(key)} title={sidebarCollapsed ? t(key) : undefined}>{NAVIGATION_ICON[key] !== undefined && <span className="nav-icon">{NAVIGATION_ICON[key]}</span>}<span className="nav-label">{t(key)}</span></button>
          {key === "nav.repository" && repositoryStatus !== undefined && <button aria-label={repositoryStatus.description} className="repository-status navigation-repository-status" onClick={() => { onOpenRepositoryStatus?.(); setNavigationOpen(false); }} title={repositoryStatus.description}>{repositoryStatus.label}</button>}
        </div>)}</div>
      </div>)}</nav>
      <div className="sidebar-footer" data-testid="sidebar-version">
        <span className="sidebar-footer-line">{t("app.version", { version: BUILD_VERSION })}</span>
      </div>
    </aside>
    <main className="workspace" ref={workspaceRef}>
      <header className="topbar">
        <button aria-controls="primary-navigation" aria-expanded={navigationOpen} aria-label={t("nav.openMenu")} className="navigation-toggle" onClick={() => setNavigationOpen((open) => !open)} ref={navigationButtonRef} title={t("nav.openMenu")}><span aria-hidden="true">☰</span></button>
        <div className="page-context"><h1>{headerTitle}</h1><p>{headerMeta}</p></div>
        {headerSearch}
        <div className="top-actions">{topActions}</div>
      </header>
      {breadcrumbs !== undefined && <nav aria-label={t("nav.breadcrumbs")} className="breadcrumbs">{breadcrumbs}</nav>}
      {banner}
      {children}
    </main>
  </div>;
}
