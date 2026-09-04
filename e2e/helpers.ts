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

export const FIXTURE_PROJECT_ID = "P-26-MGP84K";
export const E2E_TASK_ID = "T-26-9NJTEF";

export function taskDocument(id = E2E_TASK_ID) {
  return {
    schema: "gitpm/task@2",
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

export async function cleanupDrafts(request: APIRequestContext, draftPrefix: string): Promise<void> {
  const listed = await request.get("/api/drafts");
  if (!listed.ok()) return;
  const drafts = await listed.json() as readonly DraftStatus[];
  for (const draft of drafts) {
    if (!draft.draft_id.startsWith(draftPrefix)) continue;
    let lastFailure = "unknown cleanup failure";
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      if (draft.state === "open") {
        const closed = await request.post(`/api/drafts/${encodeURIComponent(draft.draft_id)}/close`);
        if (!closed.ok() && closed.status() !== 404 && closed.status() !== 409) {
          lastFailure = `close returned ${closed.status()}: ${await closed.text()}`;
        }
      }
      const cleaned = await request.delete(`/api/drafts/${encodeURIComponent(draft.draft_id)}`, {
        data: { confirmation: draft.draft_id },
      });
      if (cleaned.ok() || cleaned.status() === 404) break;
      lastFailure = `delete returned ${cleaned.status()}: ${await cleaned.text()}`;
      if (attempt === 4) throw new Error(`Could not clean ${draft.draft_id} after ${attempt} attempts: ${lastFailure}`);
      await new Promise((resolve) => setTimeout(resolve, attempt * 250));
    }
  }
}
