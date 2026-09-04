import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { GitPmApiPort } from "./api.js";
import type { MessageKey } from "./i18n.js";
import type { GlobalSearchItem, GlobalSearchResult } from "./types.js";
import type { WorkspaceNavigate } from "./workspace-navigation.js";

const TYPE_LABELS: Readonly<Record<GlobalSearchItem["entity_type"], MessageKey>> = {
  project: "search.type.project",
  task: "search.type.task",
  milestone: "search.type.milestone",
  person: "search.type.person",
  team: "search.type.team",
  calendar: "search.type.calendar",
};

export function GlobalSearch({ api, draftId, onNavigate, t }: {
  readonly api: GitPmApiPort<"searchEntities">;
  readonly draftId?: string;
  readonly onNavigate: WorkspaceNavigate;
  readonly t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string;
}) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<GlobalSearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        setOpen(true);
      }
    };
    document.addEventListener("keydown", handleShortcut);
    return () => document.removeEventListener("keydown", handleShortcut);
  }, []);

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (event.target !== null && !rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, []);

  useEffect(() => {
    setQuery("");
    setResult(null);
    setOpen(false);
  }, [draftId]);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed === "" || draftId === undefined || api.searchEntities === undefined) {
      setResult(null);
      setLoading(false);
      setFailed(false);
      setActiveIndex(-1);
      return;
    }
    let current = true;
    setLoading(true);
    setFailed(false);
    setResult(null);
    setActiveIndex(-1);
    const timer = window.setTimeout(() => {
      void api.searchEntities!(draftId, trimmed, 20).then((next) => {
        if (!current) return;
        setResult(next);
        setActiveIndex(next.items.length === 0 ? -1 : 0);
      }).catch(() => { if (current) { setResult(null); setFailed(true); setActiveIndex(-1); } })
        .finally(() => { if (current) setLoading(false); });
    }, 180);
    return () => { current = false; window.clearTimeout(timer); };
  }, [api, draftId, query]);

  const choose = (item: GlobalSearchItem) => {
    const archiveQuery = item.lifecycle === "archived" ? { archive: ["1"] } : undefined;
    if (item.entity_type === "project") onNavigate("projects", { projectId: item.id, query: archiveQuery });
    else if (item.entity_type === "task" && item.project_id !== undefined) onNavigate("tasks", { projectId: item.project_id, taskId: item.id, query: archiveQuery });
    else if (item.entity_type === "milestone" && item.project_id !== undefined) onNavigate("stages", { projectId: item.project_id, stageId: item.id, query: archiveQuery });
    else if (item.entity_type === "person") onNavigate("people", { personId: item.id });
    else if (item.entity_type === "team") onNavigate("people");
    else if (item.entity_type === "calendar") onNavigate("calendar");
    setOpen(false);
    setQuery("");
    setResult(null);
  };
  const items = result?.items ?? [];
  const visible = open && query.trim() !== "";
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") { setOpen(false); inputRef.current?.blur(); return; }
    if (event.key === "ArrowDown" && items.length > 0) {
      event.preventDefault(); setOpen(true); setActiveIndex((index) => Math.min(items.length - 1, index + 1));
    } else if (event.key === "ArrowUp" && items.length > 0) {
      event.preventDefault(); setOpen(true); setActiveIndex((index) => Math.max(0, index - 1));
    } else if (event.key === "Enter" && activeIndex >= 0 && items[activeIndex] !== undefined) {
      event.preventDefault(); choose(items[activeIndex]!);
    }
  };

  return <div className="global-search" ref={rootRef}>
    <div className="global-search-input-wrap">
      <svg aria-hidden="true" className="global-search-icon" viewBox="0 0 16 16"><circle cx="6.7" cy="6.7" r="4.4" /><path d="m10 10 4 4" /></svg>
      <input
        aria-activedescendant={activeIndex >= 0 ? `${listboxId}-${activeIndex}` : undefined}
        aria-autocomplete="list"
        aria-controls={listboxId}
        aria-expanded={visible}
        aria-label={t("search.label")}
        autoComplete="off"
        disabled={draftId === undefined || api.searchEntities === undefined}
        onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
        onFocus={() => { if (query.trim() !== "") setOpen(true); }}
        onKeyDown={onKeyDown}
        placeholder={t("search.placeholder")}
        ref={inputRef}
        role="combobox"
        type="search"
        value={query}
      />
      {query === "" ? <kbd>{t("search.shortcut")}</kbd> : <button aria-label={t("search.clear")} className="global-search-clear" onClick={() => { setQuery(""); setResult(null); inputRef.current?.focus(); }} type="button">×</button>}
    </div>
    {visible && <div className="global-search-panel">
      <div aria-label={t("search.results")} className="global-search-results" id={listboxId} role="listbox">
        {items.map((item, index) => <button
          aria-selected={index === activeIndex}
          className={index === activeIndex ? "active" : ""}
          id={`${listboxId}-${index}`}
          key={`${item.entity_type}:${item.id}`}
          onClick={() => choose(item)}
          onMouseEnter={() => setActiveIndex(index)}
          role="option"
          type="button"
        >
          <span className={`global-search-kind ${item.entity_type}`} aria-hidden="true">{t(TYPE_LABELS[item.entity_type]).slice(0, 1)}</span>
          <span className="global-search-copy"><strong>{item.title}</strong><small><span>{t(TYPE_LABELS[item.entity_type])}</span><code>{item.id}</code>{item.context !== undefined && <span>{item.context}</span>}{item.lifecycle === "archived" && <span className="state archived">{t("search.archived")}</span>}</small></span>
        </button>)}
      </div>
      <div aria-live="polite" className="global-search-status">
        {loading ? t("search.loading") : failed ? t("search.error") : result !== null && result.total === 0 ? t("search.empty") : result !== null && result.total > items.length ? t("search.more", { shown: items.length, total: result.total }) : null}
      </div>
    </div>}
  </div>;
}
