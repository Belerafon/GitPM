// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitPmApi } from "./api.js";
import type { TimeEntryResult } from "./api.js";
import { TaskTimeEntries } from "./task-time-entries.js";
import type { DraftStatus, EntityResult } from "./types.js";

const draft: DraftStatus = { draft_id: "DRF-TIME", owner_gitlab_user_id: "42", branch: "gitpm/42/DRF-TIME", base_commit: "a".repeat(40), writer_mode: "ui", state: "open", fingerprint: "b".repeat(64), created_at: "2026-07-10T00:00:00.000Z", updated_at: "2026-07-10T00:00:00.000Z" };
const person = { document: { schema: "gitpm/person@1", id: "U-26-ADA", name: "Ada", lifecycle: "active" }, path: "p.yaml", blob_id: "a".repeat(40), draft_fingerprint: "b".repeat(64) } as EntityResult;

function entry(id: string, overrides: Partial<TimeEntryResult["document"]> = {}): TimeEntryResult {
  return {
    document: {
      schema: "gitpm/time-entry@1", id, project: "P-26-1", task: "T-26-1", person: "U-26-ADA",
      performed_on: "2026-09-01", hours: 2, category: "regular", created_at: "2026-09-01T10:00:00.000Z", state: "active",
      ...overrides,
    },
    path: `projects/P-26-1/time-entries/T-26-1/${id}.yaml`,
    blob_id: "c".repeat(40),
    draft_fingerprint: "d".repeat(64),
  };
}

afterEach(cleanup);

describe("TaskTimeEntries", () => {
  it("lists entries, sums hours and adds then voids an entry", async () => {
    const createTimeEntry = vi.fn(async (): Promise<TimeEntryResult> => entry("E-26-NEW2", { performed_on: "2026-09-03", hours: 3 }));
    const voidTimeEntry = vi.fn(async (): Promise<TimeEntryResult> => entry("E-26-NEW2", { performed_on: "2026-09-03", hours: 3, state: "voided" }));
    const api = {
      listTimeEntries: vi.fn(async (): Promise<readonly TimeEntryResult[]> => [entry("E-26-AAAA", { performed_on: "2026-08-17", hours: 4 })]),
      getConfiguration: vi.fn(async (_draftId: string, kind: string) => ({ document: { schema: "gitpm/work-categories@1", categories: [{ slug: "regular", title: "Regular", active: true }] }, path: kind, blob_id: "a".repeat(40), draft_fingerprint: "b".repeat(64) })),
      createTimeEntry,
      voidTimeEntry,
    } as unknown as GitPmApi;

    render(<TaskTimeEntries api={api} draft={draft} fingerprint={draft.fingerprint} projectId="P-26-1" taskId="T-26-1" people={[person]} readOnly={false} locale="en" onFingerprintChange={vi.fn(async () => undefined)} />);

    await waitFor(() => expect(screen.getByText("4 h")).toBeTruthy());
    expect(screen.getByText(/Total hours/).parentElement?.textContent).toMatch(/4/);

    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-09-03" } });
    fireEvent.change(screen.getByLabelText("Hours"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Add effort" }));
    await waitFor(() => expect(createTimeEntry).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText("3 h")).toBeTruthy());

    fireEvent.click(screen.getAllByRole("button", { name: "Void" })[0]!);
    await waitFor(() => expect(voidTimeEntry).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryAllByRole("button", { name: "Void" })).toHaveLength(1));
  });
});
