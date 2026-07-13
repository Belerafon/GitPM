import { spawn } from "node:child_process";
import { mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { assertSafeBranchName, assertSafeRepositoryUrl, createGitProcessEnvironment } from "@gitpm/security";

const MAX_OUTPUT_BYTES = 1_048_576;

export class GitCommandError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly exitCode?: number,
  ) {
    super(message);
    this.name = "GitCommandError";
  }
}

export interface GitCommandRecord {
  readonly args: readonly string[];
  readonly durationMs: number;
  readonly exitCode: number;
}

export interface GitClientOptions {
  readonly dataDirectory: string;
  readonly remoteUrl: string;
  readonly defaultBranch: string;
  readonly allowLocalTestRemote?: boolean;
  readonly askPassPath?: string;
  readonly timeoutMs?: number;
  readonly onCommand?: (record: GitCommandRecord) => void;
}

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitHistoryEntry {
  readonly commit: string;
  readonly parents: readonly string[];
  readonly author_name: string;
  readonly author_email: string;
  readonly authored_at: string;
  readonly subject: string;
}

export interface GitCommitFile {
  readonly path: string;
  readonly additions: number | null;
  readonly deletions: number | null;
}

export interface GitCommitDetail extends GitHistoryEntry {
  readonly body: string;
  readonly files: readonly GitCommitFile[];
  readonly diff: string;
}

export interface GitRevertResult {
  readonly conflicted: boolean;
  readonly conflicted_files: readonly string[];
}

function assertCommitId(commit: string): string {
  if (!/^[0-9a-f]{40,64}$/u.test(commit)) throw new GitCommandError("GIT_COMMIT_INVALID", "Commit ID is invalid");
  return commit;
}

function parseHistoryRecord(record: string): GitHistoryEntry {
  const [commit = "", parents = "", authorName = "", authorEmail = "", authoredAt = "", subject = ""] = record.split("\x1f");
  return {
    commit: assertCommitId(commit),
    parents: parents === "" ? [] : parents.split(" ").map(assertCommitId),
    author_name: authorName,
    author_email: authorEmail,
    authored_at: authoredAt,
    subject,
  };
}

function safeEnvironment(home: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.toUpperCase().startsWith("GIT_") && value !== undefined) environment[key] = value;
  }
  return {
    ...environment,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "4",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: path.join(home, "hooks"),
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: "",
    GIT_CONFIG_KEY_2: "protocol.file.allow",
    GIT_CONFIG_VALUE_2: "never",
    GIT_CONFIG_KEY_3: "protocol.ext.allow",
    GIT_CONFIG_VALUE_3: "never",
    GIT_TERMINAL_PROMPT: "0",
    HOME: home,
    XDG_CONFIG_HOME: home,
  };
}

async function executeGit(
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
  onCommand?: (record: GitCommandRecord) => void,
): Promise<CommandResult> {
  const started = performance.now();
  return await new Promise((resolve, reject) => {
    const child = spawn("git", [...args], { env: environment, shell: false, windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let timedOut = false;
    let outputLimited = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const capture = (target: Buffer[]) => (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        outputLimited = true;
        child.kill("SIGKILL");
      } else target.push(chunk);
    };
    child.stdout.on("data", capture(stdout));
    child.stderr.on("data", capture(stderr));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new GitCommandError("GIT_SPAWN_FAILED", error.message));
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      const code = exitCode ?? -1;
      onCommand?.({ args, durationMs: performance.now() - started, exitCode: code });
      if (timedOut) reject(new GitCommandError("GIT_TIMEOUT", "Git command timed out", code));
      else if (outputLimited) reject(new GitCommandError("GIT_OUTPUT_LIMIT", "Git command exceeded output limit", code));
      else {
        const result = { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
        if (code === 0) resolve(result);
        else reject(new GitCommandError("GIT_FAILED", result.stderr.trim() || "Git command failed", code));
      }
    });
  });
}

export class GitClient {
  public readonly bareRepository: string;
  public readonly worktreesDirectory: string;
  private readonly homeDirectory: string;
  private readonly remoteUrl: string;
  private readonly defaultBranch: string;
  private readonly allowLocalTestRemote: boolean;
  private readonly askPassPath?: string;
  private readonly timeoutMs: number;
  private readonly onCommand?: (record: GitCommandRecord) => void;

  constructor(options: GitClientOptions) {
    this.bareRepository = path.resolve(options.dataDirectory, "repository.git");
    this.worktreesDirectory = path.resolve(options.dataDirectory, "worktrees");
    this.homeDirectory = path.resolve(options.dataDirectory, "git-home");
    this.defaultBranch = assertSafeBranchName(options.defaultBranch);
    this.allowLocalTestRemote = options.allowLocalTestRemote ?? false;
    this.askPassPath = options.askPassPath;
    this.remoteUrl = this.allowLocalTestRemote ? path.resolve(options.remoteUrl) : assertSafeRepositoryUrl(options.remoteUrl);
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.onCommand = options.onCommand;
  }

  private async git(args: readonly string[]): Promise<CommandResult> {
    return await executeGit(args, safeEnvironment(this.homeDirectory), this.timeoutMs, this.onCommand);
  }

  private async gitWithEnvironment(args: readonly string[], environment: NodeJS.ProcessEnv): Promise<CommandResult> {
    return await executeGit(args, environment, this.timeoutMs, this.onCommand);
  }

  private localProtocolArgs(): string[] {
    return this.allowLocalTestRemote ? ["-c", "protocol.file.allow=always"] : [];
  }

  async initialize(): Promise<void> {
    await mkdir(this.homeDirectory, { recursive: true, mode: 0o700 });
    await mkdir(path.join(this.homeDirectory, "hooks"), { recursive: true, mode: 0o700 });
    await mkdir(this.worktreesDirectory, { recursive: true, mode: 0o700 });
    try {
      const repositoryStat = await stat(this.bareRepository);
      if (!repositoryStat.isDirectory()) throw new GitCommandError("GIT_REPOSITORY_INVALID", "Bare repository path is not a directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.git(["init", "--bare", this.bareRepository]);
    }
    try {
      await this.git(["--git-dir", this.bareRepository, "remote", "get-url", "origin"]);
      await this.git(["--git-dir", this.bareRepository, "remote", "set-url", "origin", this.remoteUrl]);
    } catch (error) {
      if (!(error instanceof GitCommandError) || error.code !== "GIT_FAILED") throw error;
      await this.git(["--git-dir", this.bareRepository, "remote", "add", "origin", this.remoteUrl]);
    }
  }

  async fetch(): Promise<string> {
    await this.git([
      ...this.localProtocolArgs(),
      "--git-dir",
      this.bareRepository,
      "fetch",
      "--prune",
      "origin",
      "+refs/heads/*:refs/remotes/origin/*",
    ]);
    return await this.remoteDefaultCommit();
  }

  async remoteDefaultCommit(): Promise<string> {
    const result = await this.git([
      "--git-dir",
      this.bareRepository,
      "rev-parse",
      `refs/remotes/origin/${this.defaultBranch}^{commit}`,
    ]);
    const commit = result.stdout.trim();
    if (!/^[0-9a-f]{40,64}$/u.test(commit)) throw new GitCommandError("GIT_COMMIT_INVALID", "Remote commit is invalid");
    return commit;
  }

  async addWorktree(branch: string, worktreeName: string, commit: string): Promise<string> {
    const safeBranch = assertSafeBranchName(branch);
    if (!/^[A-Za-z0-9-]+$/u.test(worktreeName)) throw new GitCommandError("WORKTREE_NAME_INVALID", "Worktree name is invalid");
    if (!/^[0-9a-f]{40,64}$/u.test(commit)) throw new GitCommandError("GIT_COMMIT_INVALID", "Base commit is invalid");
    const worktree = path.join(this.worktreesDirectory, worktreeName);
    await this.git(["--git-dir", this.bareRepository, "worktree", "add", "-b", safeBranch, worktree, commit]);
    return await realpath(worktree);
  }

  async headCommit(worktree: string): Promise<string> {
    const result = await this.git(["-C", await realpath(worktree), "rev-parse", "HEAD^{commit}"]);
    return result.stdout.trim();
  }

  async statusPorcelain(worktree: string): Promise<string> {
    const result = await this.git(["-C", await realpath(worktree), "status", "--porcelain=v2", "--untracked-files=all"]);
    return result.stdout;
  }

  async statusPorcelainZ(worktree: string): Promise<string> {
    const result = await this.git(["-C", await realpath(worktree), "status", "--porcelain=v2", "-z", "--untracked-files=all"]);
    return result.stdout;
  }

  async diffFile(worktree: string, relativePath: string, contextLines = 3): Promise<string> {
    const result = await this.git([
      "-C",
      await realpath(worktree),
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      `--unified=${contextLines}`,
      "--",
      relativePath,
    ]);
    return result.stdout;
  }

  async showHeadFile(worktree: string, relativePath: string): Promise<string> {
    const result = await this.git(["-C", await realpath(worktree), "show", `HEAD:${relativePath}`]);
    return result.stdout;
  }

  async history(worktree: string, limit = 50): Promise<readonly GitHistoryEntry[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new GitCommandError("GIT_HISTORY_LIMIT_INVALID", "History limit must be between 1 and 200");
    const result = await this.git([
      "-C", await realpath(worktree), "log", `--max-count=${limit}`, "--date=iso-strict",
      "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e",
    ]);
    return result.stdout.split("\x1e").map((value) => value.trim()).filter(Boolean).map(parseHistoryRecord);
  }

  async fileHistory(worktree: string, relativePath: string, limit = 50): Promise<readonly GitHistoryEntry[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new GitCommandError("GIT_HISTORY_LIMIT_INVALID", "History limit must be between 1 and 200");
    const result = await this.git([
      "-C", await realpath(worktree), "log", "--follow", `--max-count=${limit}`, "--date=iso-strict",
      "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e", "--", relativePath,
    ]);
    return result.stdout.split("\x1e").map((value) => value.trim()).filter(Boolean).map(parseHistoryRecord);
  }

  async commitDetail(worktree: string, commitInput: string): Promise<GitCommitDetail> {
    const commit = assertCommitId(commitInput);
    const canonical = await realpath(worktree);
    await this.assertCommitReachable(canonical, commit);
    const metadata = await this.git([
      "-C", canonical, "show", "--no-patch", "--date=iso-strict",
      "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b", commit,
    ]);
    const fields = metadata.stdout.trim().split("\x1f");
    const entry = parseHistoryRecord(fields.slice(0, 6).join("\x1f"));
    const stats = await this.git(["-C", canonical, "show", "--format=", "--numstat", "--no-renames", commit]);
    const files = stats.stdout.split(/\r?\n/u).filter(Boolean).map((line): GitCommitFile => {
      const [added = "-", deleted = "-", ...pathParts] = line.split("\t");
      return {
        path: pathParts.join("\t"),
        additions: added === "-" ? null : Number.parseInt(added, 10),
        deletions: deleted === "-" ? null : Number.parseInt(deleted, 10),
      };
    });
    const diff = await this.git(["-C", canonical, "show", "--format=", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--unified=3", commit]);
    return { ...entry, body: fields.slice(6).join("\x1f").trim(), files, diff: diff.stdout };
  }

  async revertNoCommit(worktree: string, commitInput: string): Promise<GitRevertResult> {
    const commit = assertCommitId(commitInput);
    const canonical = await realpath(worktree);
    await this.assertCommitReachable(canonical, commit);
    const parentLine = (await this.git(["-C", canonical, "rev-list", "--parents", "-n", "1", commit])).stdout.trim();
    const parentCount = Math.max(0, parentLine.split(" ").length - 1);
    try {
      await this.git(["-C", canonical, "revert", "--no-commit", ...(parentCount > 1 ? ["-m", "1"] : []), commit]);
      return { conflicted: false, conflicted_files: [] };
    } catch (error) {
      if (!(error instanceof GitCommandError) || error.code !== "GIT_FAILED") throw error;
      const conflicts = await this.git(["-C", canonical, "diff", "--name-only", "--diff-filter=U"]);
      const conflictedFiles = conflicts.stdout.split(/\r?\n/u).filter(Boolean);
      if (conflictedFiles.length === 0) throw error;
      return { conflicted: true, conflicted_files: conflictedFiles };
    }
  }

  async assertCommitOnRemoteDefault(commitInput: string): Promise<void> {
    const commit = assertCommitId(commitInput);
    const remoteCommit = await this.remoteDefaultCommit();
    try {
      await this.git(["--git-dir", this.bareRepository, "merge-base", "--is-ancestor", commit, remoteCommit]);
    } catch (error) {
      if (error instanceof GitCommandError && error.code === "GIT_FAILED") {
        throw new GitCommandError("GIT_COMMIT_NOT_ON_MAIN", "Revert commit is not in current remote main history", error.exitCode);
      }
      throw error;
    }
  }

  private async assertCommitReachable(worktree: string, commit: string): Promise<void> {
    try {
      await this.git(["-C", worktree, "merge-base", "--is-ancestor", commit, "HEAD"]);
    } catch (error) {
      if (error instanceof GitCommandError && error.code === "GIT_FAILED") {
        throw new GitCommandError("GIT_COMMIT_NOT_REACHABLE", "Commit is not in the current main history", error.exitCode);
      }
      throw error;
    }
  }

  async removeWorktree(worktree: string, branch: string, force: boolean): Promise<void> {
    const safeBranch = assertSafeBranchName(branch);
    const canonical = await realpath(worktree);
    await this.git([
      "--git-dir",
      this.bareRepository,
      "worktree",
      "remove",
      ...(force ? ["--force"] : []),
      canonical,
    ]);
    await this.git(["--git-dir", this.bareRepository, "branch", "-D", safeBranch]);
  }

  async commitAll(worktree: string, message: string, authorName: string, authorEmail: string): Promise<string> {
    if (!message.trim() || message.length > 500 || /[\r\n\0]/u.test(message)) {
      throw new GitCommandError("COMMIT_MESSAGE_INVALID", "Commit message must be one non-empty line up to 500 characters");
    }
    if (!authorName.trim() || /[\r\n\0]/u.test(authorName) || !/^[^\s@]+@[^\s@]+$/u.test(authorEmail)) {
      throw new GitCommandError("GIT_AUTHOR_INVALID", "Git author identity is invalid");
    }
    const canonical = await realpath(worktree);
    await this.git(["-C", canonical, "add", "--all"]);
    await this.git([
      "-c", `user.name=${authorName}`,
      "-c", `user.email=${authorEmail}`,
      "-C", canonical,
      "commit", "-m", message,
    ]);
    return await this.headCommit(canonical);
  }

  async pushBranch(worktree: string, branch: string, accessToken: string): Promise<void> {
    const safeBranch = assertSafeBranchName(branch);
    if (!this.askPassPath) throw new GitCommandError("GIT_ASKPASS_REQUIRED", "Controlled ASKPASS path is required for push");
    const environment = createGitProcessEnvironment({
      askPassPath: this.askPassPath,
      hooksPath: path.join(this.homeDirectory, "hooks"),
      isolatedHome: this.homeDirectory,
      token: accessToken,
      baseEnvironment: process.env,
    });
    await this.gitWithEnvironment([
      ...this.localProtocolArgs(),
      "-C",
      await realpath(worktree),
      "push",
      "--set-upstream",
      "origin",
      `refs/heads/${safeBranch}:refs/heads/${safeBranch}`,
    ], environment);
  }

  async hashObject(content: string): Promise<string> {
    const started = performance.now();
    return await new Promise((resolve, reject) => {
      const args = ["--git-dir", this.bareRepository, "hash-object", "--stdin"];
      const child = spawn("git", args, { env: safeEnvironment(this.homeDirectory), shell: false, windowsHide: true });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", (exitCode) => {
        this.onCommand?.({ args, durationMs: performance.now() - started, exitCode: exitCode ?? -1 });
        if (exitCode === 0) resolve(stdout.trim());
        else reject(new GitCommandError("GIT_FAILED", stderr.trim() || "hash-object failed", exitCode ?? -1));
      });
      child.stdin.end(content, "utf8");
    });
  }
}
