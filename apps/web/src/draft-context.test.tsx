// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ReactNode } from "react";
import { DraftProvider, POLL_INTERVAL_MS, draftSignature, isSameSnapshot, useDrafts } from "./draft-context.js";
import type { GitPmApi } from "./api.js";
import type { DraftSnapshot, DraftStatus, PublicSession } from "./types.js";

const baseDraft: DraftStatus = {
  draft_id: "DRF-1",
  owner_gitlab_user_id: "42",
  branch: "gitpm/42/DRF-1",
  base_commit: "a".repeat(40),
  writer_mode: "ui",
  state: "open",
  fingerprint: "f".repeat(64),
  created_at: "2026-07-01T00:00:00.000Z",
  updated_at: "2026-07-01T00:00:00.000Z",
};

function makeSnapshot(overrides: Partial<DraftSnapshot> = {}): DraftSnapshot {
  return {
    draft: baseDraft,
    changes: { changed_files_count: 0 },
    validation: { valid: true, error_count: 0, warning_count: 0, document_count: 0 },
    ...overrides,
  };
}

const sessionValue = {
  user: { gitlab_user_id: 42, id: "42", username: "ada" },
  expires_at: "2026-12-31T00:00:00.000Z",
} as unknown as PublicSession;

describe("snapshot signature comparison", () => {
  it("treats snapshots as equal when only timestamps differ", () => {
    const a = makeSnapshot();
    const b = makeSnapshot({ draft: { ...baseDraft, created_at: "2026-08-01T00:00:00.000Z", updated_at: "2026-08-01T00:00:00.000Z" } });
    expect(isSameSnapshot(a, b)).toBe(true);
  });

  it("detects a draft fingerprint change", () => {
    const a = makeSnapshot();
    const b = makeSnapshot({ draft: { ...baseDraft, fingerprint: "e".repeat(64) } });
    expect(isSameSnapshot(a, b)).toBe(false);
  });

  it("detects an external fingerprint change", () => {
    const a = makeSnapshot();
    const b = makeSnapshot({ draft: { ...baseDraft, external_fingerprint: "d".repeat(64) } });
    expect(isSameSnapshot(a, b)).toBe(false);
  });

  it("detects a validation change", () => {
    const a = makeSnapshot();
    const b = makeSnapshot({ validation: { valid: false, error_count: 2, warning_count: 1, document_count: 3 } });
    expect(isSameSnapshot(a, b)).toBe(false);
  });

  it("detects a change in changed file count", () => {
    const a = makeSnapshot();
    const b = makeSnapshot({ changes: { changed_files_count: 5 } });
    expect(isSameSnapshot(a, b)).toBe(false);
  });

  it("detects a newly published merge request", () => {
    const a = makeSnapshot();
    const b = makeSnapshot({ mergeRequest: { iid: 7, state: "opened" as const, web_url: "https://example.com/mr/7" } });
    expect(isSameSnapshot(a, b)).toBe(false);
  });

  it("draftSignature ignores timestamps", () => {
    expect(draftSignature({ ...baseDraft, updated_at: "x" })).toBe(draftSignature({ ...baseDraft, updated_at: "y" }));
  });
});

describe("DraftProvider polling", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function flush() {
    // Resolve the async bootstrap chain (session -> list -> snapshot) without relying on real timers.
    for (let i = 0; i < 8; i += 1) await act(async () => { await Promise.resolve(); });
  }

  it("keeps the snapshot reference when a poll returns a content-equal snapshot, and updates on a real change", async () => {
    const initial = makeSnapshot();
    let current = initial;
    const api = {
      session: vi.fn(async () => sessionValue),
      listDrafts: vi.fn(async () => [current.draft]),
      snapshot: vi.fn(async () => current),
    } as unknown as GitPmApi;

    const { result } = renderHook(() => useDrafts(), { wrapper: ({ children }: { readonly children: ReactNode }) => <DraftProvider api={api}>{children}</DraftProvider> });
    await flush();
    expect(result.current.snapshot).toBe(initial);
    const firstDrafts = result.current.drafts;
    expect(api.snapshot).toHaveBeenCalledTimes(1);

    // Identical-by-signature snapshot with fresh object identity and bumped timestamps.
    current = makeSnapshot({ draft: { ...baseDraft, created_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-10-01T00:00:00.000Z" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); });
    expect(result.current.snapshot).toBe(initial);
    expect(result.current.drafts).toBe(firstDrafts);

    // A real content change updates the reference.
    current = makeSnapshot({ draft: { ...baseDraft, fingerprint: "c".repeat(64) } });
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); });
    expect(result.current.snapshot).not.toBe(initial);
    expect(result.current.snapshot?.draft.fingerprint).toBe("c".repeat(64));
  });
});
