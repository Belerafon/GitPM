import path from "node:path";

export class SecurityBoundaryError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SecurityBoundaryError";
  }
}

export function assertSafeBranchName(value: string): string {
  if (
    value.length === 0
    || value.length > 244
    || value.startsWith("-")
    || value.startsWith("/")
    || value.endsWith("/")
    || value.endsWith(".")
    || value.endsWith(".lock")
    || value.includes("..")
    || value.includes("//")
    || value.includes("@{")
    || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value)
    || /[\u0000-\u0020\u007f~^:?*[\]\\]/u.test(value)
    || value.split("/").some((segment) => segment.length === 0 || segment.startsWith("."))
  ) {
    throw new SecurityBoundaryError("GIT_REF_INVALID", "branch name is not allowed");
  }
  return value;
}

export type RepositoryTransport = "https" | "ssh";

export interface RepositoryUrlClassification {
  readonly transport: RepositoryTransport;
  readonly url: string;
  readonly sshUser?: string;
}

const SCP_SSH_PATTERN = /^([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+):(.*)$/u;

function rejectInvalidUrl(): never {
  throw new SecurityBoundaryError("GIT_URL_INVALID", "repository URL must be credential-free HTTPS or SSH");
}

/**
 * Classify a git remote URL as HTTPS or SSH and return a credential-free
 * canonical form. Accepted shapes:
 *   - https://host/path[.git]            (no userinfo, no query, no hash)
 *   - ssh://[user@]host[:port]/path      (no password)
 *   - user@host:path                     (SCP-like, no password)
 *
 * Embedded passwords are rejected in every transport. For HTTPS the username
 * is also rejected (GitPM injects the OAuth username via ASKPASS); for SSH the
 * username is the connection identity (e.g. `git`) and is kept.
 */
export function classifyRepositoryUrl(value: string): RepositoryUrlClassification {
  const input = value.trim();
  if (input === "") throw rejectInvalidUrl();
  if (!input.includes("://")) {
    const scp = SCP_SSH_PATTERN.exec(input);
    if (!scp) throw rejectInvalidUrl();
    const user = scp[1];
    const host = scp[2];
    const pathPart = scp[3];
    if (!user || !host || pathPart === undefined || pathPart === "" || pathPart === "/") throw rejectInvalidUrl();
    const composed = `ssh://${user}@${host}${pathPart.startsWith("/") ? pathPart : `/${pathPart}`}`;
    const parsed = parseUrl(composed);
    if (parsed.password !== "" || parsed.search !== "" || parsed.hash !== "" || parsed.hostname === "" || parsed.pathname === "/" || parsed.pathname === "") {
      throw rejectInvalidUrl();
    }
    return { transport: "ssh", url: parsed.toString(), sshUser: parsed.username };
  }
  const parsed = parseUrl(input);
  if (parsed.password !== "" || parsed.search !== "" || parsed.hash !== "" || parsed.hostname === "") throw rejectInvalidUrl();
  if (parsed.protocol === "https:") {
    if (parsed.username !== "" || parsed.pathname === "/") throw rejectInvalidUrl();
    return { transport: "https", url: parsed.toString() };
  }
  if (parsed.protocol === "ssh:") {
    if (parsed.pathname === "/" || parsed.pathname === "") throw rejectInvalidUrl();
    return { transport: "ssh", url: parsed.toString(), sshUser: parsed.username || undefined };
  }
  throw rejectInvalidUrl();
}

function parseUrl(value: string): URL {
  try {
    return new URL(value);
  } catch {
    throw rejectInvalidUrl();
  }
}

export function assertSafeRepositoryUrl(value: string): string {
  return classifyRepositoryUrl(value).url;
}

export interface GitProcessEnvironmentOptions {
  readonly askPassPath: string;
  readonly hooksPath: string;
  readonly isolatedHome: string;
  readonly token: string;
  /** Git username returned by the controlled ASKPASS helper. OAuth uses `oauth2`. */
  readonly username?: string;
  readonly baseEnvironment?: NodeJS.ProcessEnv;
}

/** Strip inherited GIT_* configuration so a malicious host config cannot override the boundary. */
function stripInheritedGitConfig(baseEnvironment?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnvironment ?? {})) {
    if (!key.toUpperCase().startsWith("GIT_") && value !== undefined) environment[key] = value;
  }
  return environment;
}

export function createGitProcessEnvironment(options: GitProcessEnvironmentOptions): NodeJS.ProcessEnv {
  return {
    ...stripInheritedGitConfig(options.baseEnvironment),
    GIT_ASKPASS: path.resolve(options.askPassPath),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "4",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: path.resolve(options.hooksPath),
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: "",
    GIT_CONFIG_KEY_2: "protocol.file.allow",
    GIT_CONFIG_VALUE_2: "never",
    GIT_CONFIG_KEY_3: "protocol.ext.allow",
    GIT_CONFIG_VALUE_3: "never",
    GIT_TERMINAL_PROMPT: "0",
    GITPM_ASKPASS_TOKEN: options.token,
    GITPM_ASKPASS_USERNAME: options.username ?? "oauth2",
    HOME: path.resolve(options.isolatedHome),
    XDG_CONFIG_HOME: path.resolve(options.isolatedHome),
  };
}

export interface SshGitProcessEnvironmentOptions {
  readonly hooksPath: string;
  readonly isolatedHome: string;
  readonly baseEnvironment?: NodeJS.ProcessEnv;
  /** Absolute path to a private key mounted outside the worktree (e.g. a Docker secret). Optional when ssh-agent is used. */
  readonly sshKeyPath?: string;
  /** Absolute path to a known_hosts file. Defaults to a file under the isolated home. */
  readonly knownHostsPath?: string;
  readonly strictHostKeyChecking?: "yes" | "accept-new";
  /** Override the ssh binary/launcher. Defaults to `ssh` on PATH. Admin-controlled only. */
  readonly sshCommand?: string;
}

/**
 * Build a controlled environment for SSH transports. The credential (a private
 * key file or an ssh-agent socket) is provisioned by the server administrator
 * and never enters the repository URL, argv, Git config, or logs. SSH options
 * are restricted to an allowlist built from admin-controlled inputs; the remote
 * URL (host/user/path) is passed by Git to ssh as an argument without a shell.
 */
export function createSshGitProcessEnvironment(options: SshGitProcessEnvironmentOptions): NodeJS.ProcessEnv {
  const parts = [options.sshCommand ?? "ssh"];
  if (options.sshKeyPath !== undefined && options.sshKeyPath !== "") {
    parts.push("-i", path.resolve(options.sshKeyPath), "-o", "IdentitiesOnly=yes");
  }
  parts.push("-o", "BatchMode=yes");
  parts.push("-o", `StrictHostKeyChecking=${options.strictHostKeyChecking ?? "accept-new"}`);
  const knownHosts = options.knownHostsPath ?? path.join(path.resolve(options.isolatedHome), ".ssh", "known_hosts");
  parts.push("-o", `UserKnownHostsFile=${path.resolve(knownHosts)}`);
  return {
    ...stripInheritedGitConfig(options.baseEnvironment),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "4",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: path.resolve(options.hooksPath),
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: "",
    GIT_CONFIG_KEY_2: "protocol.file.allow",
    GIT_CONFIG_VALUE_2: "never",
    GIT_CONFIG_KEY_3: "protocol.ext.allow",
    GIT_CONFIG_VALUE_3: "never",
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: parts.join(" "),
    HOME: path.resolve(options.isolatedHome),
    XDG_CONFIG_HOME: path.resolve(options.isolatedHome),
  };
}

export interface GitInvocation {
  readonly executable: "git";
  readonly args: readonly string[];
}

export function buildFetchInvocation(repositoryPath: string, repositoryUrl: string, branch: string): GitInvocation {
  const safeUrl = assertSafeRepositoryUrl(repositoryUrl);
  const safeBranch = assertSafeBranchName(branch);
  return {
    executable: "git",
    args: [
      "-C",
      path.resolve(repositoryPath),
      "fetch",
      "--no-tags",
      "--prune",
      "--",
      safeUrl,
      `+refs/heads/${safeBranch}:refs/remotes/origin/${safeBranch}`,
    ],
  };
}
