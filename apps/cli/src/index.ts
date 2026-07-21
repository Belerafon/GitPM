#!/usr/bin/env node
import { run } from "./command.js";
import { AgentWorkflow } from "@gitpm/agent";
import { ChangesService } from "@gitpm/changes";
import { DraftManager } from "@gitpm/drafts";
import { GitClient } from "@gitpm/git-client";
import { resolveRepositoryMode } from "@gitpm/shared";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DirectCliRuntime } from "./direct-runtime.js";

const WORKSPACE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

interface DirectEnv {
  readonly dataDirectory: string;
  readonly remoteUrl: string;
  readonly defaultBranch: string;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly askPassPath?: string;
  readonly allowLocalRepository: boolean;
  readonly pushAccessToken?: string;
}

function readDirectEnv(): DirectEnv | undefined {
  const dataDirectory = process.env.GITPM_DATA_DIR?.trim();
  const remoteUrl = process.env.GITPM_REPOSITORY_PATH?.trim() ?? process.env.GITPM_REMOTE_URL?.trim();
  if (!dataDirectory || !remoteUrl) return undefined;
  const defaultBranch = process.env.GITPM_DEFAULT_BRANCH?.trim() || "main";
  const authorName = process.env.GITPM_AGENT_AUTHOR_NAME?.trim() ?? "GitPM Agent";
  const authorEmail = process.env.GITPM_AGENT_AUTHOR_EMAIL?.trim() ?? "agent@users.noreply.gitlab.example.test";
  const askPassPath = process.env.GITPM_ASKPASS_PATH?.trim() || undefined;
  const allowLocalRepository = process.env.GITPM_ALLOW_LOCAL_REPOSITORY === "1" || !remoteUrl.startsWith("https://");
  const pushAccessToken = process.env.GITPM_ACCESS_TOKEN?.trim() || undefined;
  return {
    dataDirectory,
    remoteUrl,
    defaultBranch,
    authorName,
    authorEmail,
    ...(askPassPath === undefined ? {} : { askPassPath }),
    allowLocalRepository,
    ...(pushAccessToken === undefined ? {} : { pushAccessToken }),
  };
}

async function environmentAgent() {
  const dataDirectory = process.env.GITPM_DATA_DIR;
  const remoteUrl = process.env.GITPM_REMOTE_URL;
  if (!dataDirectory || !remoteUrl) return undefined;
  const defaultBranch = process.env.GITPM_DEFAULT_BRANCH ?? "main";
  const git = new GitClient({
    dataDirectory, remoteUrl, defaultBranch,
    ...(process.env.GITPM_ASKPASS_PATH ? { askPassPath: process.env.GITPM_ASKPASS_PATH } : {}),
    allowLocalRepository: process.env.GITPM_ALLOW_LOCAL_REPOSITORY === "1",
    allowLocalTestRemote: process.env.GITPM_ALLOW_LOCAL_TEST_REMOTE === "1",
  });
  const drafts = new DraftManager(git, dataDirectory);
  await git.initialize();
  await drafts.recover();
  return new AgentWorkflow(drafts, git, new ChangesService(drafts, git), {
    accessToken: process.env.GITPM_ACCESS_TOKEN,
    authorName: process.env.GITPM_AGENT_AUTHOR_NAME ?? "GitPM Agent",
    authorEmail: process.env.GITPM_AGENT_AUTHOR_EMAIL ?? "agent@users.noreply.gitlab.example.test",
    defaultBranch,
  });
}

async function buildDependencies() {
  const mode = resolveRepositoryMode({ envValue: process.env.GITPM_REPOSITORY_MODE });
  if (mode === "direct") {
    const env = readDirectEnv();
    if (env === undefined) return {};
    const askPass = env.askPassPath ?? path.join(WORKSPACE_ROOT, "scripts", "git-askpass.mjs");
    const direct = new DirectCliRuntime({ ...env, askPassPath: askPass });
    return { direct };
  }
  return { agent: await environmentAgent() };
}

const result = await run(process.argv.slice(2), process.cwd(), await buildDependencies());
process.stdout.write(`${result.output}\n`);
process.exitCode = result.exitCode;
