import { execFile } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { calendarPreset, type CALENDAR_PRESETS } from "@gitpm/calendar";
import type { GitPmDocument } from "@gitpm/contracts";
import { formatYamlDocument, RepositoryFormatError } from "@gitpm/repository-format";
import { ENTITY_ID_PREFIX, newEntityId } from "@gitpm/shared";

export interface InitCommandDependencies {
  readonly now?: () => Date;
  readonly randomIndex?: () => number;
}

export interface InitCommandResult {
  readonly exitCode: number;
  readonly output: string;
}

const execFileAsync = promisify(execFile);

const initRepositoryYaml = (calendarId: string, calendarName: string) => `schema: gitpm/repository@1
default_branch: main
default_calendar: ${calendarId} # calendar: ${calendarName}
default_person_name_format: full
allowed_top_level_files:
  - README.md
  - .gitignore
  - .ignore
allowed_top_level_directories:
  - uploads
ui_poll_interval_seconds: 5
`;

const INIT_STATUSES_YAML = `schema: gitpm/statuses@2
statuses:
  - slug: backlog
    title: Backlog
    color: gray
    active: true
    category: backlog
  - slug: in-progress
    title: In progress
    color: blue
    active: true
    category: active
  - slug: done
    title: Done
    color: green
    active: true
    category: done
`;

const INIT_SCHEDULE_TRACKS_YAML = `schema: gitpm/schedule-tracks@1
tracks:
  - slug: plan
    title: Working plan
    kind: manual
    capabilities:
      - dates
      - effort
      - dependencies
  - slug: actual
    title: Actual activity
    kind: actual
    source: time_entries
defaults:
  enabled_tracks:
    - plan
    - actual
  primary_track: plan
  workload_track: plan
  dashboard_tracks:
    - plan
    - actual
`;

const INIT_WORK_CATEGORIES_YAML = `schema: gitpm/work-categories@1
categories:
  - slug: regular
    title: Regular work
    active: true
  - slug: rework
    title: Rework
    active: true
  - slug: warranty
    title: Warranty
    active: true
  - slug: support
    title: Support
    active: true
`;

const INIT_ISSUE_TYPES_YAML = `schema: gitpm/issue-types@1
issue_types:
  - slug: task
    title: Task
    color: blue
    active: true
  - slug: bug
    title: Bug
    color: red
    active: true
`;

const initCalendarYaml = (calendarId: string, preset: (typeof CALENDAR_PRESETS)[number]) => formatYamlDocument({
  schema: "gitpm/calendar@1",
  id: calendarId,
  name: preset.default_name,
  working_weekdays: [...preset.working_weekdays],
  holidays: [...preset.holidays],
  lifecycle: "active",
} as GitPmDocument);

const INIT_README_MD = `# Project portfolio managed by GitPM

This repository was initialised by \`gitpm init\`. Use the GitPM web UI or CLI
to create projects, people, availability events, teams, calendars and tasks. See
https://github.com/Belerafon/GitPM for details.

Place local source documents in \`uploads/\`. Git ignores their contents; convert
them to temporary CLI input instead of committing them as GitPM business data.
`;

const INIT_GITIGNORE = `# User-supplied artefacts are local inputs, not GitPM business data.
/uploads/*
!/uploads/.gitkeep
`;

const INIT_IGNORE = `# Keep uploads searchable by ripgrep-based agent tools even though Git ignores them.
!uploads/
!uploads/**
`;

const INIT_KEEPERS = ["people", "teams", "projects", "availability"] as const;

async function directoryIsEmpty(directory: string): Promise<boolean> {
  try {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      return false;
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

function flagValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

export async function runInitCommand(
  args: readonly string[],
  cwd: string,
  dependencies: InitCommandDependencies = {},
): Promise<InitCommandResult> {
  const preset = calendarPreset(flagValue(args, "--calendar-preset") ?? "standard-five-day");
  const positionals = args.filter((argument, index) => !argument.startsWith("-") && args[index - 1] !== "--calendar-preset");
  const target = positionals[0] !== undefined ? path.resolve(cwd, positionals[0]) : path.resolve(cwd);
  const calendarId = newEntityId(
    ENTITY_ID_PREFIX.calendar,
    dependencies.randomIndex,
    dependencies.now?.() ?? new Date(),
  );
  await mkdir(target, { recursive: true });
  if (!(await directoryIsEmpty(target))) {
    throw new RepositoryFormatError("INIT_TARGET_NOT_EMPTY", `Target directory is not empty (excluding .git): ${target}`);
  }
  await mkdir(path.join(target, ".gitpm"), { recursive: true });
  await mkdir(path.join(target, "calendars"), { recursive: true });
  await mkdir(path.join(target, "uploads"), { recursive: true });
  for (const sub of INIT_KEEPERS) {
    const directory = path.join(target, sub);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, ".gitkeep"), "", "utf8");
  }
  await writeFile(path.join(target, ".gitpm", "repository.yaml"), initRepositoryYaml(calendarId, preset.default_name), "utf8");
  await writeFile(path.join(target, ".gitpm", "statuses.yaml"), INIT_STATUSES_YAML, "utf8");
  await writeFile(path.join(target, ".gitpm", "issue-types.yaml"), INIT_ISSUE_TYPES_YAML, "utf8");
  await writeFile(path.join(target, ".gitpm", "schedule-tracks.yaml"), INIT_SCHEDULE_TRACKS_YAML, "utf8");
  await writeFile(path.join(target, ".gitpm", "work-categories.yaml"), INIT_WORK_CATEGORIES_YAML, "utf8");
  await writeFile(path.join(target, "calendars", `${calendarId}.yaml`), initCalendarYaml(calendarId, preset), "utf8");
  await writeFile(path.join(target, "README.md"), INIT_README_MD, "utf8");
  await writeFile(path.join(target, ".gitignore"), INIT_GITIGNORE, "utf8");
  await writeFile(path.join(target, ".ignore"), INIT_IGNORE, "utf8");
  await writeFile(path.join(target, "uploads", ".gitkeep"), "", "utf8");

  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" };
  const branch = process.env.GITPM_INIT_BRANCH?.trim() || "main";
  try {
    await execFileAsync("git", ["-C", target, "rev-parse", "--git-dir"], { windowsHide: true });
  } catch {
    await execFileAsync("git", ["init", "-b", branch, target], { windowsHide: true, env: gitEnv });
  }
  await execFileAsync("git", ["-C", target, "add", "."], { windowsHide: true, env: gitEnv });
  const authorName = process.env.GITPM_INIT_AUTHOR_NAME?.trim() || "GitPM";
  const authorEmail = process.env.GITPM_INIT_AUTHOR_EMAIL?.trim() || "gitpm@localhost";
  const message = process.env.GITPM_INIT_MESSAGE?.trim() || "Initialise GitPM repository";
  await execFileAsync(
    "git",
    ["-C", target, "-c", `user.name=${authorName}`, "-c", `user.email=${authorEmail}`, "commit", "-m", message],
    { windowsHide: true, env: gitEnv },
  );
  const { stdout: commit } = await execFileAsync("git", ["-C", target, "rev-parse", "HEAD"], { windowsHide: true });
  const payload = { ok: true, code: "OK", path: target, commit: commit.trim(), calendar_preset: preset.id };
  return {
    exitCode: 0,
    output: args.includes("--json")
      ? JSON.stringify(payload, null, 2)
      : `Initialised GitPM repository at ${target} with ${preset.id} (${commit.trim()})`,
  };
}
