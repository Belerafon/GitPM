import { expect, type APIRequestContext } from "@playwright/test";

export interface DraftStatus {
  readonly draft_id: string;
  readonly state: "open" | "closed" | "published";
  readonly fingerprint: string;
}

export interface EntityResult {
  readonly blob_id: string;
  readonly draft_fingerprint: string;
  readonly document: Record<string, unknown>;
}

export const FIXTURE_PROJECT_ID = "PRJ-01J2BZA35YJGY8Z4T1P8JZ2TYP";
export const E2E_TASK_ID = "TSK-01J2BZ7G4VJ57PX9K2Q0C6C5XZ";

export function taskDocument(id = E2E_TASK_ID) {
  return {
    schema: "gitpm/task@1",
    id,
    project: FIXTURE_PROJECT_ID,
    title: "E2E task",
    type: "task",
    status: "backlog",
    lifecycle: "active",
  };
}

export async function createDraft(request: APIRequestContext, draftId: string): Promise<DraftStatus> {
  const response = await request.post("/api/drafts", { data: { draft_id: draftId } });
  expect(response.status(), await response.text()).toBe(201);
  return await response.json() as DraftStatus;
}

export async function cleanupDrafts(request: APIRequestContext): Promise<void> {
  const listed = await request.get("/api/drafts");
  if (!listed.ok()) return;
  const drafts = await listed.json() as readonly DraftStatus[];
  for (const draft of drafts) {
    if (draft.state === "open") {
      const closed = await request.post(`/api/drafts/${encodeURIComponent(draft.draft_id)}/close`);
      if (!closed.ok()) throw new Error(`Could not close ${draft.draft_id}: ${await closed.text()}`);
    }
    const cleaned = await request.delete(`/api/drafts/${encodeURIComponent(draft.draft_id)}`, {
      data: { confirmation: draft.draft_id },
    });
    if (!cleaned.ok()) throw new Error(`Could not clean ${draft.draft_id}: ${await cleaned.text()}`);
  }
}
