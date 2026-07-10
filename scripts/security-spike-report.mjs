#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildFetchInvocation,
  createGitProcessEnvironment,
} from "../packages/security/dist/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "gitpm-vfy-003-"));
const token = "vfy-003-process-inspection-secret";

async function containsToken(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (await containsToken(absolute)) return true;
    } else if ((await readFile(absolute, "utf8")).includes(token)) {
      return true;
    }
  }
  return false;
}

try {
  const hooksPath = path.join(temporaryRoot, "hooks");
  const isolatedHome = path.join(temporaryRoot, "home");
  await mkdir(hooksPath);
  await mkdir(isolatedHome);
  const invocation = buildFetchInvocation(
    temporaryRoot,
    "https://gitlab.example.test/group/gitpm.git",
    "main",
  );
  const environment = createGitProcessEnvironment({
    askPassPath: path.join(ROOT, "scripts", "git-askpass.mjs"),
    hooksPath,
    isolatedHome,
    token,
    baseEnvironment: process.env,
  });
  const askPass = spawnSync(process.execPath, [environment.GIT_ASKPASS, "Password for Git:"], {
    encoding: "utf8",
    env: environment,
  });
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  const gitConfigValues = Object.fromEntries(Object.entries(environment)
    .filter(([key]) => key.startsWith("GIT_CONFIG_")));
  const inspected = JSON.stringify({ invocation, gitConfigValues });
  const report = {
    executable: invocation.executable,
    argv: invocation.args.map((argument) => argument === temporaryRoot ? "<worktree>" : argument),
    inherited_git_config_removed: environment.GIT_CONFIG_GLOBAL === undefined,
    controlled_git_config_keys: Object.keys(gitConfigValues).sort(),
    token_transport: "child-environment-only",
    token_environment_key: "GITPM_ASKPASS_TOKEN",
    askpass_round_trip_ok: askPass.status === 0 && digest(askPass.stdout) === digest(token),
    token_in_argv_url_or_git_config: inspected.includes(token),
    token_in_files: await containsToken(temporaryRoot),
    token_in_report: false,
  };
  const output = JSON.stringify(report, null, 2);
  report.token_in_report = output.includes(token);
  if (
    !report.askpass_round_trip_ok
    || report.token_in_argv_url_or_git_config
    || report.token_in_files
    || report.token_in_report
  ) {
    throw new Error("credential boundary spike failed");
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
