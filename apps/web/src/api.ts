import type { DraftSnapshot, DraftStatus, MergeRequestStatus, PublicSession, ValidationSummary, WriterMode, ChangesSummary } from "./types.js";

export class ApiError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

export interface GitPmApi {
  session(): Promise<PublicSession | null>;
  login(): Promise<string>;
  logout(): Promise<void>;
  listDrafts(): Promise<readonly DraftStatus[]>;
  createDraft(draftId: string): Promise<DraftStatus>;
  snapshot(draftId: string): Promise<DraftSnapshot>;
  setWriterMode(draftId: string, mode: WriterMode): Promise<DraftStatus>;
  closeDraft(draftId: string): Promise<DraftStatus>;
  reopenDraft(draftId: string): Promise<DraftStatus>;
  cleanupDraft(draftId: string): Promise<void>;
}

interface ErrorBody { readonly error?: { readonly code?: string; readonly message?: string } }

export class HttpGitPmApi implements GitPmApi {
  constructor(private readonly baseUrl = "") {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      credentials: "include",
      headers: { "content-type": "application/json", ...init?.headers },
    });
    if (!response.ok) {
      let body: ErrorBody = {};
      try { body = await response.json() as ErrorBody; } catch { /* stable fallback below */ }
      throw new ApiError(body.error?.code ?? `HTTP_${response.status}`, body.error?.message ?? response.statusText);
    }
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }

  async session(): Promise<PublicSession | null> {
    try { return await this.request<PublicSession>("/api/auth/session"); }
    catch (error) { if (error instanceof ApiError && error.code === "SESSION_INVALID") return null; throw error; }
  }

  async login(): Promise<string> {
    return (await this.request<{ authorization_url: string }>("/api/auth/login")).authorization_url;
  }

  async logout(): Promise<void> { await this.request("/api/auth/logout", { method: "POST" }); }
  async listDrafts(): Promise<readonly DraftStatus[]> { return await this.request("/api/drafts"); }
  async createDraft(draftId: string): Promise<DraftStatus> {
    return await this.request("/api/drafts", { method: "POST", body: JSON.stringify({ draft_id: draftId }) });
  }

  async snapshot(draftId: string): Promise<DraftSnapshot> {
    const prefix = `/api/drafts/${encodeURIComponent(draftId)}`;
    const draftPromise = this.request<DraftStatus>(prefix);
    const [draft, changes, validation] = await Promise.all([
      draftPromise,
      this.request<ChangesSummary>(`${prefix}/changes`),
      this.request<ValidationSummary>(`${prefix}/validation`),
    ]);
    let mergeRequest: MergeRequestStatus | undefined;
    if (draft.merge_request_iid !== undefined) mergeRequest = await this.request(`${prefix}/merge-request`);
    return { draft, changes, validation, mergeRequest };
  }

  async setWriterMode(draftId: string, writer_mode: WriterMode): Promise<DraftStatus> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/writer-mode`, { method: "PATCH", body: JSON.stringify({ writer_mode }) });
  }
  async closeDraft(draftId: string): Promise<DraftStatus> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/close`, { method: "POST" });
  }
  async reopenDraft(draftId: string): Promise<DraftStatus> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/reopen`, { method: "POST" });
  }
  async cleanupDraft(draftId: string): Promise<void> {
    await this.request(`/api/drafts/${encodeURIComponent(draftId)}`, { method: "DELETE", body: JSON.stringify({ confirmation: draftId }) });
  }
}
