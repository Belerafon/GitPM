#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const PROJECT_COUNT = 30;
export const PERSON_COUNT = 30;
export const TASK_COUNT = 3000;
export const TASKS_PER_PROJECT = TASK_COUNT / PROJECT_COUNT;

function suffix(input) {
  let value = BigInt(input);
  let result = "";
  while (value > 0n) {
    result = `${ALPHABET[Number(value % 32n)]}${result}`;
    value /= 32n;
  }
  return result.padStart(6, "0");
}

export const calendarId = () => `C-26-${suffix(1)}`;
export const personId = (index) => `U-26-${suffix(1000 + index)}`;
export const projectId = (index) => `P-26-${suffix(2000 + index)}`;
export const taskId = (index) => `T-26-${suffix(10_000 + index)}`;
export const taskRelativePath = (index) => {
  const projectIndex = Math.floor((index - 1) / TASKS_PER_PROJECT) + 1;
  return `projects/${projectId(projectIndex)}/tasks/${taskId(index)}.yaml`;
};

async function put(root, relative, content) {
  const target = path.join(root, ...relative.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

export async function generatePerformanceFixture(root) {
  await put(root, ".gitpm/repository.yaml", [
    "schema: gitpm/repository@1",
    "default_branch: main",
    `default_calendar: ${calendarId()}`,
    "allowed_top_level_files: []",
    "ui_poll_interval_seconds: 5",
    "",
  ].join("\n"));
  await put(root, ".gitpm/statuses.yaml", [
    "schema: gitpm/statuses@1",
    "statuses:",
    "  - slug: backlog",
    "    title: Backlog",
    "    color: gray",
    "    active: true",
    "  - slug: in-progress",
    "    title: In progress",
    "    color: blue",
    "    active: true",
    "  - slug: done",
    "    title: Done",
    "    color: green",
    "    active: true",
    "",
  ].join("\n"));
  await put(root, ".gitpm/issue-types.yaml", [
    "schema: gitpm/issue-types@1",
    "issue_types:",
    "  - slug: task",
    "    title: Task",
    "    color: blue",
    "    active: true",
    "",
  ].join("\n"));
  await put(root, `calendars/${calendarId()}.yaml`, [
    "schema: gitpm/calendar@1",
    `id: ${calendarId()}`,
    "name: Performance calendar",
    "working_weekdays:",
    "  - 1", "  - 2", "  - 3", "  - 4", "  - 5",
    "holidays: []",
    "lifecycle: active",
    "",
  ].join("\n"));

  for (let index = 1; index <= PERSON_COUNT; index += 1) {
    await put(root, `people/${personId(index)}.yaml`, [
      "schema: gitpm/person@1",
      `id: ${personId(index)}`,
      `name: Performance Person ${String(index).padStart(2, "0")}`,
      "weekly_capacity_hours: 40",
      `calendar: ${calendarId()}`,
      "lifecycle: active",
      "",
    ].join("\n"));
  }

  for (let projectIndex = 1; projectIndex <= PROJECT_COUNT; projectIndex += 1) {
    const project = projectId(projectIndex);
    await put(root, `projects/${project}/project.yaml`, [
      "schema: gitpm/project@1",
      `id: ${project}`,
      `name: Performance Project ${String(projectIndex).padStart(2, "0")}`,
      "status: in-progress",
      "lifecycle: active",
      `owner: ${personId(projectIndex)}`,
      "",
    ].join("\n"));
    const firstTask = (projectIndex - 1) * TASKS_PER_PROJECT + 1;
    const writes = [];
    for (let offset = 0; offset < TASKS_PER_PROJECT; offset += 1) {
      const index = firstTask + offset;
      writes.push(put(root, taskRelativePath(index), [
        "schema: gitpm/task@1",
        `id: ${taskId(index)}`,
        `project: ${project}`,
        `title: Task ${String(index).padStart(4, "0")}`,
        "type: task",
        `status: ${index % 3 === 0 ? "done" : index % 3 === 1 ? "backlog" : "in-progress"}`,
        "lifecycle: active",
        "assignees:",
        `  - ${personId(((index - 1) % PERSON_COUNT) + 1)}`,
        `estimate_hours: ${(index % 32) + 1}`,
        "start: 2026-07-01",
        "due: 2026-07-31",
        "labels:",
        `  - batch-${projectIndex}`,
        "",
      ].join("\n")));
    }
    await Promise.all(writes);
  }

  return {
    projects: PROJECT_COUNT,
    people: PERSON_COUNT,
    tasks: TASK_COUNT,
    yaml_documents: 3 + 1 + PERSON_COUNT + PROJECT_COUNT + TASK_COUNT,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const target = process.argv[2];
  if (!target) throw new Error("usage: generate-performance-fixture.mjs <target-directory>");
  console.log(JSON.stringify(await generatePerformanceFixture(path.resolve(target)), null, 2));
}
