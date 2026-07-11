// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import type { GitPmApi } from "./api.js";
import { POLL_INTERVAL_MS } from "./draft-context.js";
import { assertLocalePacks, localeRegistry, LOCALE_STORAGE_KEY, message, selectLocale } from "./i18n.js";
import type { ChangesList, CommitHistoryDetail, CommitResult, DraftSnapshot, DraftStatus, EntityResult, MergeRequestStatus, PublicSession, PushResult, RevertDraftResult, SemanticDiff, WriterMode } from "./types.js";

const session: PublicSession = {
  user: { id: "42", username: "developer" },
  role: "Maintainer",
  expires_at: "2026-07-10T18:00:00.000Z",
};

function draft(overrides: Partial<DraftStatus> = {}): DraftStatus {
  return {
    draft_id: "DRF-WEB",
    owner_gitlab_user_id: "42",
    branch: "gitpm/42/DRF-WEB",
    base_commit: "a".repeat(40),
    writer_mode: "ui",
    state: "open",
    fingerprint: "b".repeat(64),
    created_at: "2026-07-10T10:00:00.000Z",
    updated_at: "2026-07-10T10:00:00.000Z",
    ...overrides,
  };
}

class FakeApi implements GitPmApi {
  currentSession: PublicSession | null = session;
  drafts: DraftStatus[] = [];
  snapshotCalls = 0;
  payloads: unknown[] = [];
  async session() { return this.currentSession; }
  async login() { return "https://gitlab.example.test/oauth/authorize"; }
  async logout() { this.currentSession = null; }
  async listDrafts() { return this.drafts; }
  async createDraft(draftId: string) { const created = draft({ draft_id: draftId, branch: `gitpm/42/${draftId}` }); this.payloads.push({ draft_id: draftId }); this.drafts = [created]; return created; }
  async snapshot(draftId: string): Promise<DraftSnapshot> {
    this.snapshotCalls += 1;
    const current = this.drafts.find((item) => item.draft_id === draftId) ?? draft({ draft_id: draftId });
    return { draft: current, changes: { changed_files_count: 2 }, validation: { valid: true, error_count: 0, warning_count: 1, document_count: 14 } };
  }
  async setWriterMode(draftId: string, mode: WriterMode) { return this.replace(draftId, { writer_mode: mode }); }
  async closeDraft(draftId: string) { return this.replace(draftId, { state: "closed" }); }
  async reopenDraft(draftId: string) { return this.replace(draftId, { state: "open" }); }
  async cleanupDraft(draftId: string) { this.drafts = this.drafts.filter((item) => item.draft_id !== draftId); }
  async listEntities() { return []; }
  async createEntity(): Promise<EntityResult> { throw new Error("not used"); }
  async updateEntity(): Promise<EntityResult> { throw new Error("not used"); }
  async archiveEntity(): Promise<EntityResult> { throw new Error("not used"); }
  async deleteEntity() { /* not used */ }
  async getConfiguration(): Promise<EntityResult> { throw new Error("not used"); }
  async updateConfiguration(): Promise<EntityResult> { throw new Error("not used"); }
  async listChanges(): Promise<ChangesList> { throw new Error("not used"); }
  async semanticChanges(): Promise<SemanticDiff> { throw new Error("not used"); }
  async restoreFile() { throw new Error("not used"); }
  async restoreHunk() { throw new Error("not used"); }
  async discardAll() { throw new Error("not used"); }
  async commitAll(): Promise<CommitResult> { throw new Error("not used"); }
  async push(): Promise<PushResult> { throw new Error("not used"); }
  async createMergeRequest(): Promise<MergeRequestStatus> { throw new Error("not used"); }
  async pollMergeRequest(): Promise<MergeRequestStatus> { throw new Error("not used"); }
  async history() { return []; }
  async commitDetail(): Promise<CommitHistoryDetail> { throw new Error("not used"); }
  async fileHistory() { return []; }
  async createRevertDraft(): Promise<RevertDraftResult> { throw new Error("not used"); }
  private replace(draftId: string, values: Partial<DraftStatus>) { const next = { ...(this.drafts.find((item) => item.draft_id === draftId) ?? draft({ draft_id: draftId })), ...values }; this.drafts = [next]; return next; }
}

afterEach(() => { cleanup(); vi.useRealTimers(); localStorage.clear(); });

describe("localization runtime", () => {
  it("keeps en and mandatory ru packs complete and placeholder-compatible", () => {
    expect(() => assertLocalePacks()).not.toThrow();
    expect(Object.keys(localeRegistry.ru.messages)).toEqual(Object.keys(localeRegistry.en.messages));
    expect(message("ru", "drafts.validationInvalid", { count: 3 })).toBe("Ошибок: 3");
  });

  it("selects stored locale first and otherwise the first supported browser locale", () => {
    expect(selectLocale("en", ["ru-RU"], "ru")).toBe("en");
    expect(selectLocale(null, ["de-DE", "ru-RU"], "en")).toBe("ru");
    expect(selectLocale(null, ["de-DE"], "ru")).toBe("ru");
  });
});

describe("frontend draft lifecycle", () => {
  it("persists locale and changes lang/dir without changing API payloads", async () => {
    const api = new FakeApi();
    localStorage.setItem(LOCALE_STORAGE_KEY, "ru");
    render(<App api={api} />);
    expect(await screen.findByRole("heading", { name: "Репозиторий портфеля" })).toBeTruthy();
    expect(document.documentElement.lang).toBe("ru");
    fireEvent.change(screen.getByLabelText("Язык"), { target: { value: "en" } });
    expect(await screen.findByRole("heading", { name: "Portfolio repository" })).toBeTruthy();
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("en");
    expect(document.documentElement).toMatchObject({ lang: "en", dir: "ltr" });
    expect(api.payloads).toEqual([]);
  });

  it("creates, polls, switches writer mode, closes, reopens and cleans up a draft", async () => {
    const api = new FakeApi();
    render(<App api={api} browserLanguages={["en"]} confirmAction={() => true} />);
    await screen.findAllByText("No drafts yet.");
    fireEvent.change(screen.getByLabelText("Draft ID"), { target: { value: "DRF-WEB" } });
    fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
    expect((await screen.findAllByText("gitpm/42/DRF-WEB")).length).toBeGreaterThan(0);
    expect(screen.getByText("Changed files").nextElementSibling?.textContent).toBe("2");
    expect(screen.getByText("Valid")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Switch to external writer" }));
    expect(await screen.findByText("External writer mode is active. Editing actions are read-only.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(await screen.findByRole("button", { name: "Reopen" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    expect(await screen.findByRole("button", { name: "Close" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await screen.findByRole("button", { name: "Clean up" });
    fireEvent.click(screen.getByRole("button", { name: "Clean up" }));
    expect((await screen.findAllByText("No drafts yet.")).length).toBeGreaterThan(0);
  });

  it("refreshes an active draft every three seconds", async () => {
    vi.useFakeTimers();
    const api = new FakeApi();
    api.drafts = [draft()];
    render(<App api={api} browserLanguages={["en"]} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(api.snapshotCalls).toBeGreaterThanOrEqual(1);
    const before = api.snapshotCalls;
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); });
    expect(api.snapshotCalls).toBeGreaterThan(before);
  });
});
