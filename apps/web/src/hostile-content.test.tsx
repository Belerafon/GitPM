// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitPmApi } from "./api.js";
import { SafeMarkdown } from "./core-ui.js";
import { HistoryWorkspace } from "./history-ui.js";
import type { CommitHistoryDetail, CommitHistoryItem, DraftStatus } from "./types.js";

const payload = '<img src=x onerror="globalThis.owned=true"><script>globalThis.owned=true</script><svg onload="globalThis.owned=true">';
const commit = "a".repeat(40);
const item: CommitHistoryItem = {
  commit,
  parents: [],
  author_name: payload,
  author_email: "hostile@example.test",
  authored_at: "2026-07-13T00:00:00.000Z",
  subject: payload,
  semantic_summary: { created: 0, updated: 1, deleted: 0, affected_projects: [payload] },
};
const detail: CommitHistoryDetail = {
  ...item,
  body: payload,
  files: [{ path: `projects/P-26-H0ST1E/${payload}.yaml`, additions: 1, deletions: 1 }],
  diff: `+${payload}\n`,
};
const draft: DraftStatus = {
  draft_id: "DRF-HOSTILE",
  owner_gitlab_user_id: "42",
  branch: "gitpm/42/DRF-HOSTILE",
  base_commit: commit,
  writer_mode: "ui",
  state: "open",
  fingerprint: "b".repeat(64),
  created_at: "2026-07-13T00:00:00.000Z",
  updated_at: "2026-07-13T00:00:00.000Z",
};

afterEach(() => {
  cleanup();
  delete (globalThis as { owned?: boolean }).owned;
});

describe("P13A hostile browser content", () => {
  it("keeps repository Markdown and Git metadata as inert text", async () => {
    const markdown = render(<SafeMarkdown source={payload} />);
    expect(markdown.container.textContent).toContain("<img");
    expect(markdown.container.querySelector("img,script,svg")).toBeNull();
    markdown.unmount();

    const api = {
      history: vi.fn(async () => [item]),
      commitDetail: vi.fn(async () => detail),
      fileHistory: vi.fn(async () => [item]),
    } as unknown as GitPmApi;
    const history = render(<HistoryWorkspace api={api} draft={draft} locale="en" canRevert={false} onDraftCreated={vi.fn(async () => undefined)} />);
    await screen.findAllByText(payload);
    expect(history.container.textContent).toContain(payload);
    expect(history.container.querySelector("img,script,svg")).toBeNull();
    expect((globalThis as { owned?: boolean }).owned).toBeUndefined();
  });
});
