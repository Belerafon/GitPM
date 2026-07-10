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

export function assertSafeRepositoryUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new SecurityBoundaryError("GIT_URL_INVALID", "repository URL is invalid");
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.search !== ""
    || parsed.hash !== ""
    || parsed.hostname === ""
    || parsed.pathname === "/"
  ) {
    throw new SecurityBoundaryError("GIT_URL_INVALID", "repository URL must be credential-free HTTPS");
  }
  return parsed.toString();
}

export interface GitProcessEnvironmentOptions {
  readonly askPassPath: string;
  readonly hooksPath: string;
  readonly isolatedHome: string;
  readonly token: string;
  readonly baseEnvironment?: NodeJS.ProcessEnv;
}

export function createGitProcessEnvironment(options: GitProcessEnvironmentOptions): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(options.baseEnvironment ?? {})) {
    if (!key.toUpperCase().startsWith("GIT_") && value !== undefined) environment[key] = value;
  }
  return {
    ...environment,
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
