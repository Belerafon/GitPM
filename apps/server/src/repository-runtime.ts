import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { ChangesService } from "@gitpm/changes";
import { DraftManager } from "@gitpm/drafts";
import { EntityStore } from "@gitpm/domain";
import { GitClient } from "@gitpm/git-client";
import { AuthService, GitLabHttpProtocol } from "@gitpm/gitlab";
import { HistoryService } from "@gitpm/history";
import { buildApp } from "./app.js";
import { registerRepositoryAuthApi } from "./repository-auth-api.js";
import { RepositoryPublishingService } from "./repository-publishing.js";

const execFileAsync = promisify(execFile);
const LOCAL_USER_ID = "local-user";
const DEFAULT_LOCAL_DRAFT_ID = "DRF-LOCAL";
const WORKSPACE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

async function git(repository: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", repository, ...args], { windowsHide: true });
  return result.stdout.trim();
}

async function optionalGit(repository: string, ...args: string[]): Promise<string | undefined> {
  try { return await git(repository, ...args); } catch { return undefined; }
}

function repositoryName(repository: string): string {
  return path.basename(repository) || repository;
}

function defaultDataDirectory(repository: string): string {
  const id = createHash("sha256").update(repository).digest("hex").slice(0, 16);
  return path.join(os.homedir(), ".gitpm", "repositories", id);
}

export interface RepositoryRuntimeConfiguration {
  readonly repository: string;
  readonly dataDirectory: string;
  readonly defaultBranch: string;
  readonly pushRemoteUrl?: string;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly webUrl: string;
  readonly gitlab?: { readonly baseUrl: string; readonly clientId: string; readonly project: string };
}

export async function loadRepositoryRuntimeConfiguration(): Promise<RepositoryRuntimeConfiguration> {
  const requested = process.env.GITPM_REPOSITORY_PATH?.trim();
  if (!requested) throw new Error("GITPM_REPOSITORY_PATH is required. Run run-gitpm.bat and select a Git repository.");
  const repositoryStat = await stat(requested);
  if (!repositoryStat.isDirectory()) throw new Error(`Configured repository is not a directory: ${requested}`);
  const repository = await realpath(requested);
  const topLevel = await realpath(await git(repository, "rev-parse", "--show-toplevel"));
  if (topLevel !== repository) throw new Error(`Select the repository root instead of a subdirectory: ${topLevel}`);
  await git(repository, "rev-parse", "HEAD^{commit}");

  const defaultBranch = process.env.GITPM_DEFAULT_BRANCH?.trim()
    || await optionalGit(repository, "branch", "--show-current")
    || "main";
  const discoveredRemote = await optionalGit(repository, "remote", "get-url", "origin");
  const pushRemoteUrl = process.env.GITPM_PUSH_REMOTE_URL?.trim() || discoveredRemote;
  const supportedRemote = pushRemoteUrl?.startsWith("https://") ? pushRemoteUrl : undefined;
  const authorName = process.env.GITPM_AUTHOR_NAME?.trim()
    || await optionalGit(repository, "config", "user.name")
    || "GitPM Local";
  const authorEmail = process.env.GITPM_AUTHOR_EMAIL?.trim()
    || await optionalGit(repository, "config", "user.email")
    || "gitpm@localhost";
  const dataDirectory = path.resolve(process.env.GITPM_DATA_DIR?.trim() || defaultDataDirectory(repository));
  const baseUrl = process.env.GITPM_GITLAB_URL?.trim();
  const clientId = process.env.GITPM_GITLAB_CLIENT_ID?.trim();
  const project = process.env.GITPM_GITLAB_PROJECT?.trim();
  const gitlab = baseUrl && clientId && project ? { baseUrl, clientId, project } : undefined;

  return {
    repository,
    dataDirectory,
    defaultBranch,
    ...(supportedRemote === undefined ? {} : { pushRemoteUrl: supportedRemote }),
    authorName,
    authorEmail,
    webUrl: process.env.GITPM_WEB_URL?.trim() || "http://127.0.0.1:5173",
    ...(gitlab === undefined ? {} : { gitlab }),
  };
}

export async function buildRepositoryApp() {
  const configuration = await loadRepositoryRuntimeConfiguration();
  await mkdir(configuration.dataDirectory, { recursive: true });
  const gitClient = new GitClient({
    dataDirectory: configuration.dataDirectory,
    remoteUrl: configuration.repository,
    defaultBranch: configuration.defaultBranch,
    allowLocalRepository: true,
    ...(configuration.pushRemoteUrl === undefined ? {} : { pushRemoteUrl: configuration.pushRemoteUrl }),
    askPassPath: path.join(WORKSPACE_ROOT, "scripts", "git-askpass.mjs"),
  });
  await gitClient.initialize();
  await gitClient.fetch();

  const draftManager = new DraftManager(gitClient, configuration.dataDirectory);
  const recovery = await draftManager.recover();
  if (recovery.drafts.length === 0) {
    await draftManager.createDraft(DEFAULT_LOCAL_DRAFT_ID, LOCAL_USER_ID);
  }
  const app = buildApp({
    authenticate: () => ({ userId: LOCAL_USER_ID, role: "Maintainer" }),
    changesService: new ChangesService(draftManager, gitClient),
    draftManager,
    entityStore: new EntityStore(draftManager),
    historyService: new HistoryService(draftManager, gitClient),
  });

  let auth: AuthService | undefined;
  let protocol: GitLabHttpProtocol | undefined;
  if (configuration.gitlab !== undefined) {
    protocol = new GitLabHttpProtocol(configuration.gitlab);
    auth = new AuthService({
      authorizeUrl: `${configuration.gitlab.baseUrl.replace(/\/$/u, "")}/oauth/authorize`,
      clientId: configuration.gitlab.clientId,
      redirectUri: process.env.GITPM_GITLAB_REDIRECT_URI?.trim()
        || `http://127.0.0.1:${process.env.PORT?.trim() || "3000"}/api/auth/callback`,
      protocol,
    });
  }
  const publishing = new RepositoryPublishingService(draftManager, gitClient, {
    ownerId: LOCAL_USER_ID,
    authorName: configuration.authorName,
    authorEmail: configuration.authorEmail,
    defaultBranch: configuration.defaultBranch,
    ...(auth === undefined ? {} : { auth }),
    ...(protocol === undefined ? {} : { mergeRequests: protocol }),
  });
  registerRepositoryAuthApi(app, {
    session_id: "repository-session",
    user: { id: LOCAL_USER_ID, username: os.userInfo().username || "local" },
    role: "Maintainer",
    mode: "repository",
    repository: {
      name: repositoryName(configuration.repository),
      path: configuration.repository,
      has_remote: configuration.pushRemoteUrl !== undefined,
    },
    expires_at: "9999-12-31T23:59:59.999Z",
  }, publishing, auth, configuration.webUrl);

  return app;
}
