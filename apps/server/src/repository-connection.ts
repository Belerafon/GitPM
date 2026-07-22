import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RepositoryMode } from "@gitpm/shared";
import type { GitClient } from "@gitpm/git-client";
import { assertSafeRepositoryUrl } from "@gitpm/security";
import {
  AuthError,
  AuthService,
  GitLabHttpProtocol,
  type MergeRequestPayload,
  type MergeRequestState,
  type ProtectedOperation,
  type PublicSession,
} from "@gitpm/gitlab";

export type ConnectionValueSource = "environment" | "config" | "origin" | "none";

export interface GitLabConnectionConfiguration {
  readonly baseUrl: string;
  readonly project: string;
  readonly clientId: string;
}

export interface RepositoryConnectionStatus {
  readonly repository_path: string;
  readonly repository_mode: RepositoryMode;
  readonly default_branch: string;
  readonly repository_url?: string;
  readonly remote_source: ConnectionValueSource;
  readonly remote_editable: boolean;
  readonly gitlab_editable: boolean;
  readonly gitlab: {
    readonly configured: boolean;
    readonly base_url?: string;
    readonly project?: string;
    readonly client_id?: string;
  };
}

export interface RepositoryConnectionUpdate {
  readonly repository_url?: string | null;
  readonly gitlab?: {
    readonly base_url?: string | null;
    readonly project?: string | null;
    readonly client_id?: string | null;
  } | null;
  /** Exact new URL, or REMOVE_REMOTE when clearing an existing remote. */
  readonly confirmation?: string;
}

export interface RepositoryConnectionManagerOptions {
  readonly git: GitClient;
  readonly configPath: string;
  readonly configuration: Record<string, unknown>;
  readonly repositoryPath: string;
  readonly repositoryMode: RepositoryMode;
  readonly defaultBranch: string;
  readonly repositoryUrl?: string;
  readonly remoteSource: ConnectionValueSource;
  readonly remoteEditable: boolean;
  readonly gitlab?: GitLabConnectionConfiguration;
  readonly gitlabEditable: boolean;
  readonly redirectUri: string;
  readonly directCheckoutPath?: string;
}

export class RepositoryConnectionError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "RepositoryConnectionError";
  }
}

function optionalText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized === "" ? undefined : normalized;
}

function normalizeBaseUrl(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new RepositoryConnectionError("GITLAB_URL_INVALID", "GitLab base URL is invalid"); }
  if (parsed.protocol !== "https:" && !["127.0.0.1", "localhost"].includes(parsed.hostname)) {
    throw new RepositoryConnectionError("GITLAB_URL_INVALID", "GitLab must use HTTPS");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== "/" && parsed.pathname !== "")) {
    throw new RepositoryConnectionError("GITLAB_URL_INVALID", "GitLab base URL must contain only the instance origin");
  }
  return parsed.origin;
}

function normalizeProject(value: string): string {
  const project = value.trim().replace(/^\/+|\/+$/gu, "").replace(/\.git$/u, "");
  if (!project || project.length > 512 || project.split("/").some((part) => !/^[A-Za-z0-9_.-]+$/u.test(part))) {
    throw new RepositoryConnectionError("GITLAB_PROJECT_INVALID", "GitLab project must be a group/project path");
  }
  return project;
}

function normalizeClientId(value: string): string {
  const clientId = value.trim();
  if (!clientId || clientId.length > 512 || /[\r\n\0]/u.test(clientId)) {
    throw new RepositoryConnectionError("GITLAB_CLIENT_ID_INVALID", "GitLab OAuth Application ID is invalid");
  }
  return clientId;
}

export function assertGitLabRemoteMatchesProject(repositoryUrl: string, gitlab: GitLabConnectionConfiguration): void {
  const remote = new URL(repositoryUrl);
  const base = new URL(gitlab.baseUrl);
  let remoteProject: string;
  try { remoteProject = decodeURIComponent(remote.pathname).replace(/^\/+|\/+$/gu, "").replace(/\.git$/u, ""); }
  catch { throw new RepositoryConnectionError("GIT_REMOTE_PROJECT_MISMATCH", "Repository URL contains an invalid project path"); }
  if (remote.origin !== base.origin || remoteProject !== gitlab.project) {
    throw new RepositoryConnectionError("GIT_REMOTE_PROJECT_MISMATCH", "Repository URL and GitLab project must identify the same project");
  }
}

async function writeConfiguration(configPath: string, configuration: Record<string, unknown>): Promise<void> {
  await mkdir(path.dirname(configPath), { recursive: true });
  const temporary = `${configPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(configuration, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, configPath);
  } finally {
    await rm(temporary, { force: true });
  }
}

export class RepositoryConnectionManager {
  private configuration: Record<string, unknown>;
  private repositoryUrl?: string;
  private remoteSource: ConnectionValueSource;
  private gitlab?: GitLabConnectionConfiguration;
  private auth?: AuthService;
  private protocol?: GitLabHttpProtocol;

  constructor(private readonly options: RepositoryConnectionManagerOptions) {
    this.configuration = { ...options.configuration };
    this.repositoryUrl = options.repositoryUrl;
    this.remoteSource = options.remoteSource;
    this.gitlab = options.gitlab;
    if (this.repositoryUrl !== undefined && this.gitlab !== undefined) {
      assertGitLabRemoteMatchesProject(this.repositoryUrl, this.gitlab);
    }
    this.rebuildGitLab();
  }

  status(): RepositoryConnectionStatus {
    return {
      repository_path: this.options.repositoryPath,
      repository_mode: this.options.repositoryMode,
      default_branch: this.options.defaultBranch,
      ...(this.repositoryUrl === undefined ? {} : { repository_url: this.repositoryUrl }),
      remote_source: this.remoteSource,
      remote_editable: this.options.remoteEditable,
      gitlab_editable: this.options.gitlabEditable,
      gitlab: {
        configured: this.auth !== undefined,
        ...(this.gitlab === undefined ? {} : {
          base_url: this.gitlab.baseUrl,
          project: this.gitlab.project,
          client_id: this.gitlab.clientId,
        }),
      },
    };
  }

  async update(input: RepositoryConnectionUpdate): Promise<RepositoryConnectionStatus> {
    if (!this.options.remoteEditable || !this.options.gitlabEditable) {
      throw new RepositoryConnectionError("REPOSITORY_CONNECTION_MANAGED_EXTERNALLY", "Repository connection is controlled by environment variables");
    }
    const repositoryUrlInput = optionalText(input.repository_url);
    const repositoryUrl = repositoryUrlInput === undefined ? undefined : assertSafeRepositoryUrl(repositoryUrlInput);
    const gitlabInput = input.gitlab ?? undefined;
    const baseUrlInput = optionalText(gitlabInput?.base_url);
    const projectInput = optionalText(gitlabInput?.project);
    const clientIdInput = optionalText(gitlabInput?.client_id);
    const hasSomeGitLab = baseUrlInput !== undefined || projectInput !== undefined || clientIdInput !== undefined;
    if (hasSomeGitLab && (baseUrlInput === undefined || projectInput === undefined || clientIdInput === undefined)) {
      throw new RepositoryConnectionError("GITLAB_CONFIGURATION_INCOMPLETE", "GitLab URL, project, and OAuth Application ID must be configured together");
    }
    const gitlab = hasSomeGitLab ? {
      baseUrl: normalizeBaseUrl(baseUrlInput!),
      project: normalizeProject(projectInput!),
      clientId: normalizeClientId(clientIdInput!),
    } : undefined;
    if (gitlab !== undefined && repositoryUrl === undefined) {
      throw new RepositoryConnectionError("GIT_REMOTE_REQUIRED", "Configure the repository URL before GitLab OAuth");
    }
    if (gitlab !== undefined) assertGitLabRemoteMatchesProject(repositoryUrl!, gitlab);

    if (this.repositoryUrl !== undefined && repositoryUrl !== this.repositoryUrl) {
      const expected = repositoryUrl ?? "REMOVE_REMOTE";
      if (input.confirmation !== expected) {
        throw new RepositoryConnectionError("REPOSITORY_CONNECTION_CONFIRMATION_REQUIRED", `Changing the publication repository requires exact confirmation: ${expected}`);
      }
    }

    const nextConfiguration: Record<string, unknown> = { ...this.configuration };
    if (repositoryUrl === undefined) delete nextConfiguration.repositoryUrl;
    else nextConfiguration.repositoryUrl = repositoryUrl;
    if (gitlab === undefined) delete nextConfiguration.gitlab;
    else nextConfiguration.gitlab = { baseUrl: gitlab.baseUrl, project: gitlab.project, clientId: gitlab.clientId };
    await writeConfiguration(this.options.configPath, nextConfiguration);
    try { await this.options.git.configurePublishingRemote(repositoryUrl, this.options.directCheckoutPath); }
    catch (error) {
      await writeConfiguration(this.options.configPath, this.configuration);
      throw error;
    }

    this.configuration = nextConfiguration;
    this.repositoryUrl = repositoryUrl;
    this.remoteSource = repositoryUrl === undefined ? "none" : "config";
    this.gitlab = gitlab;
    this.rebuildGitLab();
    return this.status();
  }

  startLogin(): { authorization_url: string; state: string } {
    return this.requireAuth().startLogin();
  }

  async completeLogin(state: string, code: string): Promise<PublicSession> {
    return await this.requireAuth().completeLogin(state, code);
  }

  async authorize(sessionId: string, operation: ProtectedOperation) {
    return await this.requireAuth().authorize(sessionId, operation);
  }

  async test(sessionId: string): Promise<{ ok: true; branch: string; commit: string }> {
    const authorized = await this.authorize(sessionId, "push");
    const remote = await this.options.git.testPublishingRemote(authorized.accessToken);
    return { ok: true, ...remote };
  }

  logout(sessionId: string): void {
    this.auth?.logout(sessionId);
  }

  async createMergeRequest(accessToken: string, payload: MergeRequestPayload): Promise<MergeRequestState> {
    if (this.protocol === undefined) throw new AuthError("GITLAB_NOT_CONFIGURED", "GitLab is not configured");
    return await this.protocol.createMergeRequest(accessToken, payload);
  }

  async getMergeRequest(accessToken: string, iid: number): Promise<MergeRequestState> {
    if (this.protocol === undefined) throw new AuthError("GITLAB_NOT_CONFIGURED", "GitLab is not configured");
    return await this.protocol.getMergeRequest(accessToken, iid);
  }

  private rebuildGitLab(): void {
    this.auth = undefined;
    this.protocol = undefined;
    if (this.gitlab === undefined) return;
    this.protocol = new GitLabHttpProtocol(this.gitlab);
    this.auth = new AuthService({
      authorizeUrl: `${this.gitlab.baseUrl}/oauth/authorize`,
      clientId: this.gitlab.clientId,
      redirectUri: this.options.redirectUri,
      protocol: this.protocol,
    });
  }

  private requireAuth(): AuthService {
    if (this.auth === undefined) throw new AuthError("GITLAB_NOT_CONFIGURED", "GitLab login is not configured for this repository");
    return this.auth;
  }
}
