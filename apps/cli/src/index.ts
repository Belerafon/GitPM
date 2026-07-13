#!/usr/bin/env node
import { run } from "./command.js";
import { AgentWorkflow } from "@gitpm/agent";
import { ChangesService } from "@gitpm/changes";
import { DraftManager } from "@gitpm/drafts";
import { GitClient } from "@gitpm/git-client";

async function environmentAgent(): Promise<AgentWorkflow | undefined> {
  const dataDirectory = process.env.GITPM_DATA_DIR; const remoteUrl = process.env.GITPM_REMOTE_URL;
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

const result = await run(process.argv.slice(2), process.cwd(), { agent: await environmentAgent() });
process.stdout.write(`${result.output}\n`);
process.exitCode = result.exitCode;
