import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { GitPmApi } from "./api.js";
import type { DraftSnapshot, DraftStatus, PublicSession, WriterMode } from "./types.js";

export const POLL_INTERVAL_MS = 3_000;
export const ACTIVE_DRAFT_STORAGE_KEY = "gitpm.activeWorkingCopy";

function storedActiveId(): string | null {
  try { return typeof window === "undefined" ? null : window.localStorage.getItem(ACTIVE_DRAFT_STORAGE_KEY); }
  catch { return null; }
}

function rememberActiveId(draftId: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (draftId === null) window.localStorage.removeItem(ACTIVE_DRAFT_STORAGE_KEY);
    else window.localStorage.setItem(ACTIVE_DRAFT_STORAGE_KEY, draftId);
  } catch { /* storage can be disabled */ }
}

interface DraftContextValue {
  readonly session: PublicSession | null | undefined;
  readonly drafts: readonly DraftStatus[];
  readonly snapshot: DraftSnapshot | null;
  readonly busy: boolean;
  readonly error: string | null;
  refresh(): Promise<void>;
  select(draftId: string): Promise<void>;
  create(draftId: string): Promise<void>;
  setWriterMode(mode: WriterMode): Promise<void>;
  close(): Promise<void>;
  reopen(): Promise<void>;
  cleanup(): Promise<void>;
  logout(): Promise<void>;
}

const DraftContext = createContext<DraftContextValue | null>(null);

export function DraftProvider({ api, children }: { readonly api: GitPmApi; readonly children: ReactNode }) {
  const [session, setSession] = useState<PublicSession | null | undefined>(undefined);
  const [drafts, setDrafts] = useState<readonly DraftStatus[]>([]);
  const [activeId, setActiveId] = useState<string | null>(storedActiveId);
  const [snapshot, setSnapshot] = useState<DraftSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (operation: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await operation(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  }, []);

  const refreshList = useCallback(async () => {
    const next = await api.listDrafts();
    setDrafts(next);
    return next;
  }, [api]);

  const poll = useCallback(async (draftId = activeId) => {
    if (draftId === null) return;
    try {
      const next = await api.snapshot(draftId);
      setSnapshot(next);
      setDrafts((current) => current.map((draft) => draft.draft_id === draftId ? next.draft : draft));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [activeId, api]);

  const refresh = useCallback(async () => {
    await run(async () => {
      let currentSession: PublicSession | null;
      try {
        currentSession = await api.session();
      } catch (caught) {
        setSession((current) => current === undefined ? null : current);
        throw caught;
      }
      if (currentSession === null) { setSession(null); setDrafts([]); setActiveId(null); rememberActiveId(null); setSnapshot(null); return; }
      const next = await refreshList();
      const selected = activeId !== null && next.some((draft) => draft.draft_id === activeId) ? activeId : next[0]?.draft_id ?? null;
      setActiveId(selected);
      rememberActiveId(selected);
      if (selected !== null) await poll(selected);
      setSession(currentSession);
    });
  }, [activeId, api, poll, refreshList, run]);

  useEffect(() => { void refresh(); }, []); // initial session bootstrap only
  useEffect(() => {
    if (session === null || session === undefined || activeId === null) return;
    const timer = window.setInterval(() => { void poll(activeId); }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [activeId, poll, session]);

  const select = useCallback(async (draftId: string) => {
    setActiveId(draftId);
    rememberActiveId(draftId);
    await run(async () => await poll(draftId));
  }, [poll, run]);

  const create = useCallback(async (draftId: string) => {
    await run(async () => {
      const created = await api.createDraft(draftId);
      await refreshList();
      setActiveId(created.draft_id);
      rememberActiveId(created.draft_id);
      await poll(created.draft_id);
    });
  }, [api, poll, refreshList, run]);

  const mutateActive = useCallback(async (operation: (draftId: string) => Promise<DraftStatus>) => {
    if (activeId === null) return;
    await run(async () => { await operation(activeId); await refreshList(); await poll(activeId); });
  }, [activeId, poll, refreshList, run]);

  const cleanup = useCallback(async () => {
    if (activeId === null) return;
    await run(async () => {
      await api.cleanupDraft(activeId);
      const next = await refreshList();
      const selected = next[0]?.draft_id ?? null;
      setActiveId(selected);
      rememberActiveId(selected);
      setSnapshot(selected === null ? null : await api.snapshot(selected));
    });
  }, [activeId, api, refreshList, run]);

  const logout = useCallback(async () => {
    await run(async () => {
      await api.logout();
      const currentSession = await api.session();
      setSession(currentSession);
      if (currentSession === null) { setDrafts([]); setActiveId(null); rememberActiveId(null); setSnapshot(null); }
    });
  }, [api, run]);

  const value = useMemo<DraftContextValue>(() => ({
    session, drafts, snapshot, busy, error, refresh, select, create,
    setWriterMode: async (mode) => await mutateActive(async (id) => await api.setWriterMode(id, mode)),
    close: async () => await mutateActive(async (id) => await api.closeDraft(id)),
    reopen: async () => await mutateActive(async (id) => await api.reopenDraft(id)),
    cleanup, logout,
  }), [api, busy, cleanup, create, drafts, error, logout, mutateActive, refresh, select, session, snapshot]);

  return <DraftContext.Provider value={value}>{children}</DraftContext.Provider>;
}

export function useDrafts(): DraftContextValue {
  const context = useContext(DraftContext);
  if (context === null) throw new Error("DraftProvider is missing");
  return context;
}
