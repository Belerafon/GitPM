import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { ChangesService } from "@gitpm/changes";
import { DirectRepositoryBackend, directPushStrategy, DraftManager } from "@gitpm/drafts";
import { CommentStore, EntityStore } from "@gitpm/domain";
import { GitClient } from "@gitpm/git-client";
import { assertSafeRepositoryUrl } from "@gitpm/security";
import { HistoryService } from "@gitpm/history";
import { resolveRepositoryMode, type RepositoryMode } from "@gitpm/shared";
import { buildApp } from "./app.js";
import { registerRepositoryAuthApi } from "./repository-auth-api.js";
import { RepositoryPublishingService } from "./repository-publishing.js";
import { RepositoryConnectionManager, type ConnectionValueSource, type GitLabConnectionConfiguration } from "./repository-connection.js";

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

async function readConfigFile(): Promise<Record<string, unknown>> {
  const configPath = repositoryConfigPath();
  try {
    const parsed = JSON.parse(await readFile(configPath, "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Cannot read ${configPath}: ${(error as Error).message}`);
  }
}

function repositoryConfigPath(): string {
  return path.resolve(process.env.GITPM_CONFIG_PATH?.trim() || path.join(WORKSPACE_ROOT, ".gitpm", "config.json"));
}

export interface RepositoryRuntimeConfiguration {
  readonly repository: string;
  readonly dataDirectory: string;
  readonly defaultBranch: string;
  readonly repositoryMode: RepositoryMode;
  readonly configPath: string;
  readonly rawConfiguration: Record<string, unknown>;
  readonly pushRemoteUrl?: string;
  readonly remoteSource: ConnectionValueSource;
  readonly remoteEditable: boolean;
  readonly gitlabEditable: boolean;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly webUrl: string;
  readonly gitlab?: GitLabConnectionConfiguration;
}

export async function loadRepositoryRuntimeConfiguration(): Promise<RepositoryRuntimeConfiguration> {
  const config = await readConfigFile();
  const repositoryMode = resolveRepositoryMode({
    configValue: config.repositoryMode,
    envValue: process.env.GITPM_REPOSITORY_MODE,
  });
  const requested = process.env.GITPM_REPOSITORY_PATH?.trim()
    || (typeof config.repository === "string" ? config.repository.trim() : "");
  if (!requested) throw new Error("GITPM_REPOSITORY_PATH is required. Run run-gitpm.bat and select a Git repository.");
  const repositoryStat = await stat(requested);
  if (!repositoryStat.isDirectory()) throw new Error(`Configured repository is not a directory: ${requested}`);
  const repository = await realpath(requested);
  const topLevel = await realpath(await git(repository, "rev-parse", "--show-toplevel"));
  if (topLevel !== repository) throw new Error(`Select the repository root instead of a subdirectory: ${topLevel}`);
  await git(repository, "rev-parse", "HEAD^{commit}");

  const defaultBranch = process.env.GITPM_DEFAULT_BRANCH?.trim()
    || (typeof config.defaultBranch === "string" ? config.defaultBranch.trim() : "")
    || await optionalGit(repository, "branch", "--show-current")
    || "main";
  const discoveredRemote = await optionalGit(repository, "remote", "get-url", "origin");
  const configuredUrl = typeof config.repositoryUrl === "string" && config.repositoryUrl.trim() !== "" ? config.repositoryUrl.trim() : undefined;
  const environmentUrl = process.env.GITPM_PUSH_REMOTE_URL?.trim() || undefined;
  const remoteCandidate = environmentUrl || configuredUrl || discoveredRemote;
  let supportedRemote: string | undefined;
  if (remoteCandidate !== undefined) {
    try { supportedRemote = assertSafeRepositoryUrl(remoteCandidate); }
    catch (error) {
      if (environmentUrl !== undefined || configuredUrl !== undefined) throw error;
      supportedRemote = undefined;
    }
  }
  const remoteSource: ConnectionValueSource = environmentUrl !== undefined ? "environment"
    : configuredUrl !== undefined ? "config"
      : supportedRemote !== undefined ? "origin" : "none";
  const authorName = process.env.GITPM_AUTHOR_NAME?.trim()
    || await optionalGit(repository, "config", "user.name")
    || "GitPM Local";
  const authorEmail = process.env.GITPM_AUTHOR_EMAIL?.trim()
    || await optionalGit(repository, "config", "user.email")
    || "gitpm@localhost";
  const dataDirectory = path.resolve(process.env.GITPM_DATA_DIR?.trim() || defaultDataDirectory(repository));
  const fileGitLab = typeof config.gitlab === "object" && config.gitlab !== null ? config.gitlab as Record<string, unknown> : {};
  const baseUrl = process.env.GITPM_GITLAB_URL?.trim()
    || (typeof fileGitLab.baseUrl === "string" ? fileGitLab.baseUrl.trim() : "");
  const clientId = process.env.GITPM_GITLAB_CLIENT_ID?.trim()
    || (typeof fileGitLab.clientId === "string" ? fileGitLab.clientId.trim() : "");
  const project = process.env.GITPM_GITLAB_PROJECT?.trim()
    || (typeof fileGitLab.project === "string" ? fileGitLab.project.trim() : "");
  const gitlab = baseUrl && clientId && project ? { baseUrl, clientId, project } : undefined;

  return {
    repository,
    dataDirectory,
    defaultBranch,
    repositoryMode,
    configPath: repositoryConfigPath(),
    rawConfiguration: config,
    ...(supportedRemote === undefined ? {} : { pushRemoteUrl: supportedRemote }),
    remoteSource,
    remoteEditable: environmentUrl === undefined,
    gitlabEditable: !process.env.GITPM_GITLAB_URL?.trim()
      && !process.env.GITPM_GITLAB_CLIENT_ID?.trim()
      && !process.env.GITPM_GITLAB_PROJECT?.trim(),
    authorName,
    authorEmail,
    webUrl: process.env.GITPM_WEB_URL?.trim() || "http://127.0.0.1:5173",
    ...(gitlab === undefined ? {} : { gitlab }),
  };
}

async function buildWorktreeRuntime(configuration: RepositoryRuntimeConfiguration, gitClient: GitClient) {
  await gitClient.initialize();
  await gitClient.fetch();
  const draftManager = new DraftManager(gitClient, configuration.dataDirectory);
  const recovery = await draftManager.recover();
  if (recovery.drafts.length === 0) {
    await draftManager.createDraft(DEFAULT_LOCAL_DRAFT_ID, LOCAL_USER_ID);
  }
  return { draftManager };
}

async function buildDirectRuntime(configuration: RepositoryRuntimeConfiguration, gitClient: GitClient) {
  const backend = new DirectRepositoryBackend(gitClient, configuration.repository);
  const draftManager = new DraftManager(gitClient, configuration.dataDirectory, { backend, push: directPushStrategy(gitClient) });
  await draftManager.ensureDirectWorkspace(DEFAULT_LOCAL_DRAFT_ID, LOCAL_USER_ID);
  return { draftManager };
}

export async function buildRepositoryApp() {
  const configuration = await loadRepositoryRuntimeConfiguration();
  await mkdir(configuration.dataDirectory, { recursive: true });
  const worktreeUsesHttpsOrigin = configuration.repositoryMode === "worktree" && configuration.pushRemoteUrl !== undefined;
  const gitClient = new GitClient({
    dataDirectory: configuration.dataDirectory,
    remoteUrl: worktreeUsesHttpsOrigin ? configuration.pushRemoteUrl! : configuration.repository,
    defaultBranch: configuration.defaultBranch,
    allowLocalRepository: !worktreeUsesHttpsOrigin,
    ...(configuration.pushRemoteUrl === undefined ? {} : { pushRemoteUrl: configuration.pushRemoteUrl }),
    askPassPath: path.join(WORKSPACE_ROOT, "scripts", "git-askpass.mjs"),
  });

  if (configuration.repositoryMode === "direct" && ["config", "environment"].includes(configuration.remoteSource) && configuration.pushRemoteUrl !== undefined) {
    await gitClient.configurePublishingRemote(configuration.pushRemoteUrl, configuration.repository);
  }

  const runtime = configuration.repositoryMode === "direct"
    ? await buildDirectRuntime(configuration, gitClient)
    : await buildWorktreeRuntime(configuration, gitClient);
  const draftManager = runtime.draftManager;

  const app = buildApp({
    authenticate: () => ({ userId: LOCAL_USER_ID, role: "Maintainer", provider: "git", displayName: configuration.authorName, email: configuration.authorEmail }),
    changesService: new ChangesService(draftManager, gitClient),
    commentStore: new CommentStore(draftManager),
    draftManager,
    entityStore: new EntityStore(draftManager),
    historyService: new HistoryService(draftManager, gitClient),
  });

  const connection = new RepositoryConnectionManager({
    git: gitClient,
    configPath: configuration.configPath,
    configuration: configuration.rawConfiguration,
    repositoryPath: configuration.repository,
    repositoryMode: configuration.repositoryMode,
    defaultBranch: configuration.defaultBranch,
    ...(configuration.pushRemoteUrl === undefined ? {} : { repositoryUrl: configuration.pushRemoteUrl }),
    remoteSource: configuration.remoteSource,
    remoteEditable: configuration.remoteEditable,
    ...(configuration.gitlab === undefined ? {} : { gitlab: configuration.gitlab }),
    gitlabEditable: configuration.gitlabEditable,
    redirectUri: process.env.GITPM_GITLAB_REDIRECT_URI?.trim()
      || `http://127.0.0.1:${process.env.PORT?.trim() || "3000"}/api/auth/callback`,
    ...(configuration.repositoryMode === "direct" ? { directCheckoutPath: configuration.repository } : {}),
  });
  const publishing = new RepositoryPublishingService(draftManager, gitClient, {
    ownerId: LOCAL_USER_ID,
    authorName: configuration.authorName,
    authorEmail: configuration.authorEmail,
    defaultBranch: configuration.defaultBranch,
    remote: connection,
  });
  registerRepositoryAuthApi(app, {
    session_id: "repository-session",
    user: { id: LOCAL_USER_ID, username: os.userInfo().username || "local" },
    role: "Maintainer",
    mode: "repository",
    repository_mode: configuration.repositoryMode,
    repository: {
      name: repositoryName(configuration.repository),
      path: configuration.repository,
      has_remote: configuration.pushRemoteUrl !== undefined,
      ...(configuration.repositoryMode === "direct" ? { branch: configuration.defaultBranch } : {}),
    },
    expires_at: "9999-12-31T23:59:59.999Z",
  }, publishing, connection, configuration.webUrl, connection);

  return app;
}
