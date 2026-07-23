import { useEffect, useRef, useState, type ReactNode } from "react";
import { formatDateTime, type Locale, type MessageKey } from "../i18n.js";
import { BUILD_COMMIT, BUILD_COMMIT_DATE, BUILD_VERSION } from "../version.js";

export interface NavigationGroup {
  readonly label: MessageKey;
  readonly items: readonly MessageKey[];
}

export function AppShell({ activeView, banner, breadcrumbs, children, headerMeta, headerTitle, locale, navigationGroups, onNavigate, onOpenRepositoryStatus, repositoryMode, repositoryStatus, t, topActions }: {
  readonly activeView: MessageKey;
  readonly banner?: ReactNode;
  readonly breadcrumbs?: ReactNode;
  readonly children: ReactNode;
  readonly headerMeta: ReactNode;
  readonly headerTitle: string;
  readonly locale: Locale;
  readonly navigationGroups: readonly NavigationGroup[];
  readonly onNavigate: (key: MessageKey) => void;
  readonly onOpenRepositoryStatus?: () => void;
  readonly repositoryMode: boolean;
  readonly repositoryStatus?: { readonly label: string; readonly description: string };
  readonly t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string;
  readonly topActions: ReactNode;
}) {
  const [navigationOpen, setNavigationOpen] = useState(false);
  const navigationButtonRef = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const workspaceRef = useRef<HTMLElement>(null);

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

  return <div className={`app-shell${repositoryMode ? " repository-mode" : ""}`}>
    <button aria-label={t("nav.closeMenu")} className={`navigation-backdrop${navigationOpen ? " open" : ""}`} onClick={closeNavigation} tabIndex={navigationOpen ? 0 : -1} />
    <aside aria-label={t("nav.label")} className={`sidebar${navigationOpen ? " open" : ""}`} id="primary-navigation" ref={sidebarRef}>
      <div className="sidebar-heading"><div className="brand"><img className="brand-mark" src="/gitpm-icon.svg" alt="" /><strong>{t("app.title")}</strong></div><button aria-label={t("nav.closeMenu")} className="navigation-close" onClick={closeNavigation} type="button">×</button></div>
      <nav className="navigation-groups">{navigationGroups.map((group) => <div className="navigation-group" key={group.label}>
        {group.items.length > 1 && <span className="navigation-group-label">{t(group.label)}</span>}
        <div className="navigation-group-items">{group.items.map((key) => <div className={`navigation-item${activeView === key ? " active" : ""}`} key={key}>
          <button aria-current={activeView === key ? "page" : undefined} className={activeView === key ? "active" : ""} onClick={() => navigate(key)}>{t(key)}</button>
          {key === "nav.repository" && repositoryStatus !== undefined && <button aria-label={repositoryStatus.description} className="repository-status navigation-repository-status" onClick={() => { onOpenRepositoryStatus?.(); setNavigationOpen(false); }} title={repositoryStatus.description}>{repositoryStatus.label}</button>}
        </div>)}</div>
      </div>)}</nav>
      <div className="sidebar-footer" data-testid="sidebar-version">
        <span className="sidebar-footer-line">{t("app.version", { version: BUILD_VERSION })}</span>
        {BUILD_COMMIT_DATE !== "" && <span className="sidebar-footer-meta">{t("app.buildInfo", { commit: BUILD_COMMIT, date: formatDateTime(locale, BUILD_COMMIT_DATE) })}</span>}
      </div>
    </aside>
    <main className="workspace" ref={workspaceRef}>
      <header className="topbar">
        <button aria-controls="primary-navigation" aria-expanded={navigationOpen} aria-label={t("nav.openMenu")} className="navigation-toggle" onClick={() => setNavigationOpen((open) => !open)} ref={navigationButtonRef}><span aria-hidden="true">☰</span></button>
        <div className="page-context"><h1>{headerTitle}</h1><p>{headerMeta}</p></div>
        <div className="top-actions">{topActions}</div>
      </header>
      {breadcrumbs !== undefined && <nav aria-label={t("nav.breadcrumbs")} className="breadcrumbs">{breadcrumbs}</nav>}
      {banner}
      {children}
    </main>
  </div>;
}
