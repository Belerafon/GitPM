import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { GitPmApi } from "./api.js";
import type { DraftSnapshot, DraftStatus, PublicSession, WriterMode } from "./types.js";

export const POLL_INTERVAL_MS = 3_000;

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
  const [activeId, setActiveId] = useState<string | null>(null);
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
      const currentSession = await api.session();
      setSession(currentSession);
      if (currentSession === null) { setDrafts([]); setActiveId(null); setSnapshot(null); return; }
      const next = await refreshList();
      const selected = activeId ?? next[0]?.draft_id ?? null;
      setActiveId(selected);
      if (selected !== null) await poll(selected);
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
    await run(async () => await poll(draftId));
  }, [poll, run]);

  const create = useCallback(async (draftId: string) => {
    await run(async () => {
      const created = await api.createDraft(draftId);
      await refreshList();
      setActiveId(created.draft_id);
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
      setSnapshot(selected === null ? null : await api.snapshot(selected));
    });
  }, [activeId, api, refreshList, run]);

  const logout = useCallback(async () => {
    await run(async () => { await api.logout(); setSession(null); setDrafts([]); setActiveId(null); setSnapshot(null); });
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
