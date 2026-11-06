import { createHash, randomBytes, randomUUID } from "node:crypto";

const MAX_SESSION_MS = 60 * 24 * 60 * 60 * 1000;
const TOKEN_REFRESH_LEEWAY_MS = 30_000;
const ROLE_CACHE_MS = 60_000;
const PENDING_LOGIN_MS = 10 * 60 * 1000;

export type GitPmRole = "Reporter" | "Developer" | "Maintainer";
export type ProtectedOperation = "read" | "mutation" | "commit" | "push" | "mr";
export type GitLabAuthMode =
  | "user-oauth-publication"
  | "oauth-identity-project-token"
  | "oauth-identity-user-token";

export const GITLAB_AUTH_MODES: readonly GitLabAuthMode[] = [
  "user-oauth-publication",
  "oauth-identity-project-token",
  "oauth-identity-user-token",
];

export function isGitLabAuthMode(value: string): value is GitLabAuthMode {
  return (GITLAB_AUTH_MODES as readonly string[]).includes(value);
}

export function gitLabAuthRequiresLogin(mode: GitLabAuthMode | undefined): boolean {
  return mode === "oauth-identity-project-token" || mode === "oauth-identity-user-token";
}

export function gitLabAuthUsesProjectToken(mode: GitLabAuthMode | undefined): boolean {
  return mode === "oauth-identity-project-token";
}

export interface OAuthTokenResponse {
  readonly access_token: string;
  readonly expires_in: number;
  readonly refresh_token?: string;
}

export interface GitLabUser {
  readonly id: string;
  readonly username: string;
  readonly name: string;
  readonly email?: string;
}

export interface GitLabProtocol {
  exchangeAuthorizationCode(input: {
    readonly code: string;
    readonly codeVerifier: string;
    readonly redirectUri: string;
  }): Promise<OAuthTokenResponse>;
  refreshAccessToken(input: { readonly refreshToken: string; readonly redirectUri: string }): Promise<OAuthTokenResponse>;
  currentUser(accessToken: string): Promise<GitLabUser>;
  projectAccessLevel(accessToken: string, userId: string): Promise<number | null>;
}

export interface MergeRequestPayload {
  readonly source_branch: string;
  readonly target_branch: string;
  readonly title: string;
  readonly description?: string;
}

export interface MergeRequestState {
  readonly iid: number;
  readonly state: "opened" | "merged" | "closed";
  readonly source_branch: string;
  readonly target_branch: string;
  readonly web_url: string;
}

export interface GitLabMergeRequestProtocol {
  createMergeRequest(accessToken: string, payload: MergeRequestPayload): Promise<MergeRequestState>;
  getMergeRequest(accessToken: string, iid: number): Promise<MergeRequestState>;
}

export interface GitLabHttpProtocolOptions {
  readonly baseUrl: string;
  readonly clientId: string;
  readonly project: string;
  readonly fetch?: typeof globalThis.fetch;
}

export interface SanitizedCapture {
  readonly operation: string;
  readonly payload?: unknown;
}

export interface AuthServiceOptions {
  readonly authorizeUrl: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly protocol: GitLabProtocol;
  readonly authMode?: GitLabAuthMode;
  readonly projectAccessToken?: string;
  readonly now?: () => number;
}

interface PendingLogin {
  readonly verifier: string;
  readonly expiresAt: number;
  readonly returnTo?: string;
}

interface Session {
  readonly id: string;
  oauthAccessToken?: string;
  oauthRefreshToken?: string;
  oauthExpiresAt?: number;
  refreshing?: Promise<void>;
  readonly user: GitLabUser;
  readonly expiresAt: number;
  role: GitPmRole;
  roleCheckedAt: number;
}

export interface PublicSession {
  readonly session_id: string;
  readonly user: GitLabUser;
  readonly role: GitPmRole;
  readonly expires_at: string;
}

export class AuthError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

const base64Url = (value: Buffer) => value.toString("base64url");

function validateOAuthToken(token: OAuthTokenResponse): void {
  if (typeof token?.access_token !== "string" || !token.access_token.trim()
    || !Number.isFinite(token.expires_in) || token.expires_in <= 0
    || (token.refresh_token !== undefined && typeof token.refresh_token !== "string")) {
    throw new AuthError("OAUTH_TOKEN_INVALID", "OAuth token response is invalid");
  }
}

export function mapAccessLevel(level: number | null): GitPmRole {
  if (level === null || level < 20) throw new AuthError("PROJECT_MEMBERSHIP_REQUIRED", "Project membership is required");
  if (level < 30) return "Reporter";
  if (level < 40) return "Developer";
  return "Maintainer";
}

export class AuthService {
  private readonly pending = new Map<string, PendingLogin>();
  private readonly sessions = new Map<string, Session>();
  private readonly now: () => number;

  constructor(private readonly options: AuthServiceOptions) {
    this.now = options.now ?? Date.now;
    if (gitLabAuthUsesProjectToken(this.authMode) && !options.projectAccessToken?.trim()) {
      throw new AuthError("GITLAB_PROJECT_TOKEN_REQUIRED", "Project Access Token is required for the configured authentication mode");
    }
  }

  private get authMode(): GitLabAuthMode {
    return this.options.authMode ?? "user-oauth-publication";
  }

  private roleAccessToken(session?: Session): string {
    const accessToken = gitLabAuthUsesProjectToken(this.authMode)
      ? this.options.projectAccessToken
      : session?.oauthAccessToken;
    if (!accessToken) throw new AuthError("GITLAB_ACCESS_TOKEN_REQUIRED", "GitLab access token is unavailable");
    return accessToken;
  }

  startLogin(returnTo?: string): { authorization_url: string; state: string } {
    const state = base64Url(randomBytes(32));
    const verifier = base64Url(randomBytes(64));
    const challenge = base64Url(createHash("sha256").update(verifier).digest());
    this.pending.set(state, {
      verifier,
      expiresAt: this.now() + PENDING_LOGIN_MS,
      ...(returnTo === undefined ? {} : { returnTo }),
    });
    const url = new URL(this.options.authorizeUrl);
    url.searchParams.set("client_id", this.options.clientId);
    url.searchParams.set("redirect_uri", this.options.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", gitLabAuthUsesProjectToken(this.authMode) ? "read_user" : "api write_repository");
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    return { authorization_url: url.toString(), state };
  }

  async completeLogin(state: string, code: string): Promise<PublicSession & { readonly return_to?: string }> {
    const pending = this.pending.get(state);
    this.pending.delete(state);
    if (!pending || pending.expiresAt < this.now()) throw new AuthError("OAUTH_STATE_INVALID", "OAuth state is invalid or expired");
    const token = await this.options.protocol.exchangeAuthorizationCode({
      code,
      codeVerifier: pending.verifier,
      redirectUri: this.options.redirectUri,
    });
    validateOAuthToken(token);
    const user = await this.options.protocol.currentUser(token.access_token);
    const roleToken = gitLabAuthUsesProjectToken(this.authMode)
      ? this.roleAccessToken()
      : token.access_token;
    const role = mapAccessLevel(await this.options.protocol.projectAccessLevel(roleToken, user.id));
    const projectTokenMode = gitLabAuthUsesProjectToken(this.authMode);
    const refreshToken = token.refresh_token?.trim() || undefined;
    const session: Session = {
      id: randomUUID(),
      ...(projectTokenMode ? {} : {
        oauthAccessToken: token.access_token,
        oauthExpiresAt: this.now() + token.expires_in * 1000,
        ...(refreshToken === undefined ? {} : { oauthRefreshToken: refreshToken }),
      }),
      user,
      role,
      roleCheckedAt: this.now(),
      expiresAt: this.now() + (projectTokenMode || refreshToken !== undefined
        ? MAX_SESSION_MS : Math.min(token.expires_in * 1000, MAX_SESSION_MS)),
    };
    this.sessions.set(session.id, session);
    return pending.returnTo === undefined ? this.public(session) : { ...this.public(session), return_to: pending.returnTo };
  }

  async authorize(sessionId: string, operation: ProtectedOperation): Promise<{ session: PublicSession; accessToken: string }> {
    const session = this.sessions.get(sessionId);
    this.requireActiveSession(sessionId, session);
    await this.ensureOAuthToken(session);
    this.requireActiveSession(sessionId, session);
    const publishSensitive = operation !== "read";
    if (publishSensitive || this.now() - session.roleCheckedAt >= ROLE_CACHE_MS) {
      session.role = mapAccessLevel(await this.options.protocol.projectAccessLevel(this.roleAccessToken(session), session.user.id));
      session.roleCheckedAt = this.now();
    }
    this.requireActiveSession(sessionId, session);
    if (operation !== "read" && session.role === "Reporter") {
      throw new AuthError("ROLE_READ_ONLY", "Reporter role is read-only");
    }
    return { session: this.public(session), accessToken: this.roleAccessToken(session) };
  }

  logout(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  sessionCount(): number {
    return this.sessions.size;
  }

  private requireActiveSession(sessionId: string, session: Session | undefined): asserts session is Session {
    if (session === undefined || this.sessions.get(sessionId) !== session || session.expiresAt <= this.now()) {
      this.sessions.delete(sessionId);
      throw new AuthError("SESSION_INVALID", "Session is unavailable or expired");
    }
  }

  private async ensureOAuthToken(session: Session): Promise<void> {
    if (session.oauthExpiresAt === undefined) return;
    if (session.oauthExpiresAt - this.now() > TOKEN_REFRESH_LEEWAY_MS) return;
    if (session.oauthRefreshToken === undefined) {
      if (session.oauthExpiresAt > this.now()) return;
      this.sessions.delete(session.id);
      throw new AuthError("SESSION_INVALID", "Session is unavailable or expired");
    }
    // GitLab rotates both tokens. Concurrent API requests must share one exchange.
    const refreshing = session.refreshing ??= this.refreshOAuthToken(session, session.oauthRefreshToken);
    try {
      await refreshing;
    } finally {
      if (session.refreshing === refreshing) delete session.refreshing;
    }
  }

  private async refreshOAuthToken(session: Session, refreshToken: string): Promise<void> {
    try {
      const token = await this.options.protocol.refreshAccessToken({ refreshToken, redirectUri: this.options.redirectUri });
      validateOAuthToken(token);
      if (typeof token.refresh_token !== "string" || !token.refresh_token.trim()) {
        throw new AuthError("OAUTH_TOKEN_INVALID", "OAuth refresh response is invalid");
      }
      this.requireActiveSession(session.id, session);
      session.oauthAccessToken = token.access_token;
      session.oauthRefreshToken = token.refresh_token;
      session.oauthExpiresAt = this.now() + token.expires_in * 1000;
      // Recheck membership even if the previous cached role was still current.
      session.roleCheckedAt = Number.NEGATIVE_INFINITY;
    } catch (error) {
      if (error instanceof AuthError && ["GITLAB_HTTP_400", "GITLAB_HTTP_401", "GITLAB_HTTP_403", "OAUTH_TOKEN_INVALID"].includes(error.code)) {
        this.sessions.delete(session.id);
        throw new AuthError("SESSION_INVALID", "Session is unavailable or expired");
      }
      throw error;
    }
  }

  private public(session: Session): PublicSession {
    return {
      session_id: session.id,
      user: session.user,
      role: session.role,
      expires_at: new Date(session.expiresAt).toISOString(),
    };
  }
}

export class GitLabHttpProtocol implements GitLabProtocol, GitLabMergeRequestProtocol {
  private readonly baseUrl: string;
  private readonly fetchImplementation: typeof globalThis.fetch;

  constructor(private readonly options: GitLabHttpProtocolOptions) {
    let baseUrl: URL;
    try {
      baseUrl = new URL(options.baseUrl);
    } catch {
      throw new AuthError("GITLAB_URL_INVALID", "GitLab base URL is invalid");
    }
    if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
      throw new AuthError("GITLAB_URL_INVALID", "GitLab must use HTTP or HTTPS");
    }
    if (baseUrl.hostname === "" || baseUrl.username !== "" || baseUrl.password !== ""
      || baseUrl.search !== "" || baseUrl.hash !== ""
      || (baseUrl.pathname !== "/" && baseUrl.pathname !== "")) {
      throw new AuthError("GITLAB_URL_INVALID", "GitLab base URL must contain only the instance origin");
    }
    this.baseUrl = baseUrl.origin;
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
  }

  async exchangeAuthorizationCode(input: { code: string; codeVerifier: string; redirectUri: string }): Promise<OAuthTokenResponse> {
    const body = new URLSearchParams({
      client_id: this.options.clientId,
      code: input.code,
      code_verifier: input.codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: input.redirectUri,
    });
    return await this.request<OAuthTokenResponse>("/oauth/token", { method: "POST", body });
  }

  async refreshAccessToken(input: { refreshToken: string; redirectUri: string }): Promise<OAuthTokenResponse> {
    const body = new URLSearchParams({
      client_id: this.options.clientId,
      refresh_token: input.refreshToken,
      grant_type: "refresh_token",
      redirect_uri: input.redirectUri,
    });
    return await this.request<OAuthTokenResponse>("/oauth/token", { method: "POST", body });
  }

  async currentUser(accessToken: string): Promise<GitLabUser> {
    const user = await this.request<{
      id: number | string;
      username: string;
      name: string;
      commit_email?: string | null;
    }>("/api/v4/user", {}, accessToken);
    const email = user.commit_email?.trim() || undefined;
    return {
      id: String(user.id),
      username: user.username,
      name: user.name,
      ...(email === undefined ? {} : { email }),
    };
  }

  async projectAccessLevel(accessToken: string, userId: string): Promise<number | null> {
    try {
      const membership = await this.request<{ access_level: number }>(
        `/api/v4/projects/${encodeURIComponent(this.options.project)}/members/all/${encodeURIComponent(userId)}`,
        {},
        accessToken,
      );
      return membership.access_level;
    } catch (error) {
      if (error instanceof AuthError && error.code === "GITLAB_HTTP_404") return null;
      throw error;
    }
  }

  async createMergeRequest(accessToken: string, payload: MergeRequestPayload): Promise<MergeRequestState> {
    return await this.request<MergeRequestState>(
      `/api/v4/projects/${encodeURIComponent(this.options.project)}/merge_requests`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) },
      accessToken,
    );
  }

  async getMergeRequest(accessToken: string, iid: number): Promise<MergeRequestState> {
    if (!Number.isSafeInteger(iid) || iid <= 0) throw new AuthError("MR_ID_INVALID", "Merge Request ID is invalid");
    return await this.request<MergeRequestState>(
      `/api/v4/projects/${encodeURIComponent(this.options.project)}/merge_requests/${iid}`,
      {},
      accessToken,
    );
  }

  private async request<T>(pathname: string, init: RequestInit = {}, accessToken?: string): Promise<T> {
    const headers = new Headers(init.headers);
    if (accessToken !== undefined) headers.set("authorization", `Bearer ${accessToken}`);
    let response: Response;
    try {
      response = await this.fetchImplementation(`${this.baseUrl}${pathname}`, { ...init, headers });
    } catch {
      throw new AuthError("GITLAB_UNAVAILABLE", "GitLab is unavailable");
    }
    if (!response.ok) throw new AuthError(`GITLAB_HTTP_${response.status}`, `GitLab request failed (${response.status})`);
    return await response.json() as T;
  }
}

export class GitLabProtocolTestDouble implements GitLabProtocol, GitLabMergeRequestProtocol {
  readonly captures: SanitizedCapture[] = [];
  accessLevel: number | null = 30;
  user: GitLabUser = { id: "42", username: "developer", name: "GitLab Developer", email: "developer@example.test" };
  private readonly mergeRequests = new Map<number, MergeRequestState>();
  private nextIid = 1;

  async exchangeAuthorizationCode(input: { code: string; codeVerifier: string; redirectUri: string }): Promise<OAuthTokenResponse> {
    this.captures.push({
      operation: "oauth-token",
      payload: {
        code: input.code,
        code_verifier_sha256: createHash("sha256").update(input.codeVerifier).digest("hex"),
        redirect_uri: input.redirectUri,
      },
    });
    return { access_token: "gitlab-test-double-access-token", expires_in: 3600 };
  }

  async currentUser(_accessToken: string): Promise<GitLabUser> {
    this.captures.push({ operation: "current-user" });
    return this.user;
  }

  async refreshAccessToken(_input: { refreshToken: string; redirectUri: string }): Promise<OAuthTokenResponse> {
    this.captures.push({ operation: "oauth-refresh" });
    return { access_token: "gitlab-test-double-access-token", refresh_token: "gitlab-test-double-refresh-token", expires_in: 3600 };
  }

  async projectAccessLevel(_accessToken: string, userId: string): Promise<number | null> {
    this.captures.push({ operation: "project-role", payload: { user_id: userId } });
    return this.accessLevel;
  }

  async createMergeRequest(_accessToken: string, payload: MergeRequestPayload): Promise<MergeRequestState> {
    const iid = this.nextIid;
    this.nextIid += 1;
    const mergeRequest: MergeRequestState = {
      iid,
      state: "opened",
      source_branch: payload.source_branch,
      target_branch: payload.target_branch,
      web_url: `https://gitlab.example.test/group/gitpm/-/merge_requests/${iid}`,
    };
    this.mergeRequests.set(iid, mergeRequest);
    this.captures.push({ operation: "create-mr", payload });
    return mergeRequest;
  }

  async getMergeRequest(_accessToken: string, iid: number): Promise<MergeRequestState> {
    this.captures.push({ operation: "get-mr", payload: { iid } });
    const mergeRequest = this.mergeRequests.get(iid);
    if (!mergeRequest) throw new AuthError("MR_NOT_FOUND", `Merge Request ${iid} not found`);
    return mergeRequest;
  }
}
