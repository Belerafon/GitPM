import { createHash, randomBytes, randomUUID } from "node:crypto";

const MAX_SESSION_MS = 8 * 60 * 60 * 1000;
const ROLE_CACHE_MS = 60_000;
const PENDING_LOGIN_MS = 10 * 60 * 1000;

export type GitPmRole = "Reporter" | "Developer" | "Maintainer";
export type ProtectedOperation = "read" | "mutation" | "commit" | "push" | "mr";

export interface OAuthTokenResponse {
  readonly access_token: string;
  readonly expires_in: number;
  readonly refresh_token?: string;
}

export interface GitLabUser {
  readonly id: string;
  readonly username: string;
}

export interface GitLabProtocol {
  exchangeAuthorizationCode(input: {
    readonly code: string;
    readonly codeVerifier: string;
    readonly redirectUri: string;
  }): Promise<OAuthTokenResponse>;
  currentUser(accessToken: string): Promise<GitLabUser>;
  projectAccessLevel(accessToken: string): Promise<number | null>;
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

export interface SanitizedCapture {
  readonly operation: string;
  readonly payload?: unknown;
}

export interface AuthServiceOptions {
  readonly authorizeUrl: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly protocol: GitLabProtocol;
  readonly now?: () => number;
}

interface PendingLogin {
  readonly verifier: string;
  readonly expiresAt: number;
}

interface Session {
  readonly id: string;
  readonly accessToken: string;
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
  }

  startLogin(): { authorization_url: string; state: string } {
    const state = base64Url(randomBytes(32));
    const verifier = base64Url(randomBytes(64));
    const challenge = base64Url(createHash("sha256").update(verifier).digest());
    this.pending.set(state, { verifier, expiresAt: this.now() + PENDING_LOGIN_MS });
    const url = new URL(this.options.authorizeUrl);
    url.searchParams.set("client_id", this.options.clientId);
    url.searchParams.set("redirect_uri", this.options.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "api write_repository");
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    return { authorization_url: url.toString(), state };
  }

  async completeLogin(state: string, code: string): Promise<PublicSession> {
    const pending = this.pending.get(state);
    this.pending.delete(state);
    if (!pending || pending.expiresAt < this.now()) throw new AuthError("OAUTH_STATE_INVALID", "OAuth state is invalid or expired");
    const token = await this.options.protocol.exchangeAuthorizationCode({
      code,
      codeVerifier: pending.verifier,
      redirectUri: this.options.redirectUri,
    });
    if (!token.access_token || token.expires_in <= 0) throw new AuthError("OAUTH_TOKEN_INVALID", "OAuth token response is invalid");
    const user = await this.options.protocol.currentUser(token.access_token);
    const role = mapAccessLevel(await this.options.protocol.projectAccessLevel(token.access_token));
    const session: Session = {
      id: randomUUID(),
      accessToken: token.access_token,
      user,
      role,
      roleCheckedAt: this.now(),
      expiresAt: this.now() + Math.min(token.expires_in * 1000, MAX_SESSION_MS),
    };
    this.sessions.set(session.id, session);
    return this.public(session);
  }

  async authorize(sessionId: string, operation: ProtectedOperation): Promise<{ session: PublicSession; accessToken: string }> {
    const session = this.sessions.get(sessionId);
    if (!session || session.expiresAt <= this.now()) {
      if (session) this.sessions.delete(sessionId);
      throw new AuthError("SESSION_INVALID", "Session is unavailable or expired");
    }
    const publishSensitive = operation !== "read";
    if (publishSensitive || this.now() - session.roleCheckedAt >= ROLE_CACHE_MS) {
      session.role = mapAccessLevel(await this.options.protocol.projectAccessLevel(session.accessToken));
      session.roleCheckedAt = this.now();
    }
    if (operation !== "read" && session.role === "Reporter") {
      throw new AuthError("ROLE_READ_ONLY", "Reporter role is read-only");
    }
    return { session: this.public(session), accessToken: session.accessToken };
  }

  logout(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  sessionCount(): number {
    return this.sessions.size;
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

export class GitLabProtocolTestDouble implements GitLabProtocol, GitLabMergeRequestProtocol {
  readonly captures: SanitizedCapture[] = [];
  accessLevel: number | null = 30;
  user: GitLabUser = { id: "42", username: "developer" };
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

  async projectAccessLevel(_accessToken: string): Promise<number | null> {
    this.captures.push({ operation: "project-role" });
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
