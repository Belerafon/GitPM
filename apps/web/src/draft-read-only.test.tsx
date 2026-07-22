// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DraftReadOnlyAlert, draftReadOnlyReason } from "./draft-read-only.js";
import type { DraftStatus } from "./types.js";

const draft: DraftStatus = {
  draft_id: "DRF-READ-ONLY",
  owner_gitlab_user_id: "42",
  branch: "main",
  base_commit: "a".repeat(40),
  writer_mode: "ui",
  state: "open",
  fingerprint: "b".repeat(64),
  created_at: "2026-07-22T00:00:00.000Z",
  updated_at: "2026-07-22T00:00:00.000Z",
};

afterEach(cleanup);

describe("draft read-only reason", () => {
  it("distinguishes lifecycle, writer, and external-change causes", () => {
    expect(draftReadOnlyReason(draft)).toBeNull();
    expect(draftReadOnlyReason({ ...draft, state: "closed" })).toBe("not-open");
    expect(draftReadOnlyReason({ ...draft, writer_mode: "external" })).toBe("external-writer");
    expect(draftReadOnlyReason({ ...draft, changed_externally: true })).toBe("changed-externally");
  });

  it("offers an explicit acknowledgement only for external changes", () => {
    const acknowledge = vi.fn();
    render(<DraftReadOnlyAlert draft={{ ...draft, changed_externally: true }} locale="ru" onAcknowledge={acknowledge} />);
    expect(screen.getByText(/Файлы изменились вне GitPM/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Принять текущее содержимое и продолжить" }));
    expect(acknowledge).toHaveBeenCalledOnce();
  });
});
