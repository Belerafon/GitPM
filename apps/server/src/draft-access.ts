import { DraftRuntimeError } from "@gitpm/drafts";
import type { DraftManager, DraftMetadata } from "@gitpm/drafts";
import type { RequestActor } from "./draft-api.js";

/**
 * Draft visibility follows the repository mode: the direct mode serves one shared
 * workspace whose GitLab identity does not partition drafts, while every worktree
 * draft is readable and mutable only by its owner (docs/Repository_Modes.md).
 */
export function canAccessDraft(manager: DraftManager, actor: RequestActor, metadata: DraftMetadata): boolean {
  return manager.repositoryMode === "direct" || metadata.owner_gitlab_user_id === actor.userId;
}

/**
 * Resolve the draft owner a mutation is recorded under. Worktree drafts keep the
 * acting user as the owner; the direct shared workspace keeps its provisioning
 * owner so every authenticated member can mutate the selected checkout. Comment
 * and time-entry actor identities must still be built from the real actor.
 */
export function workspaceOwnerId(manager: DraftManager, actor: RequestActor, metadata: DraftMetadata): string {
  return manager.repositoryMode === "direct" ? metadata.owner_gitlab_user_id : actor.userId;
}

export async function requireDraftRead(manager: DraftManager, actor: RequestActor, draftId: string): Promise<DraftMetadata> {
  const metadata = await manager.getDraft(draftId);
  if (!canAccessDraft(manager, actor, metadata)) {
    throw new DraftRuntimeError("DRAFT_FORBIDDEN", "Draft owner mismatch");
  }
  return metadata;
}

export async function requireDraftMutationOwner(manager: DraftManager, actor: RequestActor, draftId: string): Promise<string> {
  const metadata = await requireDraftRead(manager, actor, draftId);
  return workspaceOwnerId(manager, actor, metadata);
}
