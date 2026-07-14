import { useEffect, useRef, useState, type ReactNode } from "react";
import type { MessageKey } from "../i18n.js";

export interface NavigationGroup {
  readonly label: MessageKey;
  readonly items: readonly MessageKey[];
}

export function AppShell({ activeView, banner, children, headerMeta, headerTitle, navigationGroups, onNavigate, repositoryMode, repositoryName, t, topActions }: {
  readonly activeView: MessageKey;
  readonly banner?: ReactNode;
  readonly children: ReactNode;
  readonly headerMeta: ReactNode;
  readonly headerTitle: string;
  readonly navigationGroups: readonly NavigationGroup[];
  readonly onNavigate: (key: MessageKey) => void;
  readonly repositoryMode: boolean;
  readonly repositoryName: string;
  readonly t: (key: MessageKey) => string;
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
    const heading = workspaceRef.current?.querySelector<HTMLElement>(".section-heading h2, .draft-list h2, .empty-workspace");
    if (heading !== null && heading !== undefined) { heading.tabIndex = -1; heading.focus(); }
  }, [activeView]);

  useEffect(() => {
    if (!navigationOpen) return;
    (sidebarRef.current?.querySelector<HTMLButtonElement>('nav button[aria-current="page"]') ?? sidebarRef.current?.querySelector<HTMLButtonElement>("nav button"))?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setNavigationOpen(false);
      navigationButtonRef.current?.focus();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [navigationOpen]);

  const closeNavigation = () => { setNavigationOpen(false); navigationButtonRef.current?.focus(); };
  const navigate = (key: MessageKey) => { onNavigate(key); setNavigationOpen(false); };

  return <div className={`app-shell${repositoryMode ? " repository-mode" : ""}`}>
    <button aria-label={t("nav.closeMenu")} className={`navigation-backdrop${navigationOpen ? " open" : ""}`} onClick={closeNavigation} tabIndex={navigationOpen ? 0 : -1} />
    <aside aria-label={t("nav.label")} className={`sidebar${navigationOpen ? " open" : ""}`} id="primary-navigation" ref={sidebarRef}>
      <div className="brand"><span className="brand-mark">G</span><strong>{t("app.title")}</strong></div>
      <nav className="navigation-groups">{navigationGroups.map((group) => <div className="navigation-group" key={group.label}>
        <span className="navigation-group-label">{t(group.label)}</span>
        {group.items.map((key) => <button aria-current={activeView === key ? "page" : undefined} className={activeView === key ? "active" : ""} key={key} onClick={() => navigate(key)}>{t(key)}</button>)}
      </div>)}</nav>
      <div className="repository-card"><span>{t("app.singleRepository")}</span><strong>{repositoryName}</strong></div>
    </aside>
    <main className="workspace" ref={workspaceRef}>
      <header className="topbar">
        <button aria-controls="primary-navigation" aria-expanded={navigationOpen} aria-label={t("nav.openMenu")} className="navigation-toggle" onClick={() => setNavigationOpen((open) => !open)} ref={navigationButtonRef}><span aria-hidden="true">☰</span></button>
        <div><h1>{headerTitle}</h1><p>{headerMeta}</p></div>
        <div className="top-actions">{topActions}</div>
      </header>
      {banner}
      {children}
    </main>
  </div>;
}
