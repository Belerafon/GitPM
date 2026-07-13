import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { GitClient } from "./index.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const inheritedKeys = [
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0",
  "GIT_CONFIG_KEY_1", "GIT_CONFIG_VALUE_1",
  "GIT_CONFIG_KEY_2", "GIT_CONFIG_VALUE_2",
  "GIT_EXTERNAL_DIFF",
] as const;
const originalEnvironment = new Map(inheritedKeys.map((key) => [key, process.env[key]]));

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return result.stdout.trim();
}

afterEach(async () => {
  for (const key of inheritedKeys) {
    const value = originalEnvironment.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("P13A malicious repository boundary", () => {
  it("does not execute inherited hooks, filters, textconv or external diff", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gitpm-p13a-malicious-"));
    roots.push(root);
    const source = path.join(root, "source");
    const remote = path.join(root, "remote.git");
    const data = path.join(root, "data");
    const attackScript = path.join(root, "attack.mjs");
    const marker = path.join(root, "executed.txt");
    const hooks = path.join(root, "hooks");
    await mkdir(source);
    await mkdir(hooks);
    await writeFile(path.join(source, ".gitattributes"), "*.yaml diff=owned filter=owned\n", "utf8");
    await writeFile(path.join(source, ".gitmodules"), "[submodule \"owned\"]\n\tpath = owned\n\turl = file:///tmp/owned.git\n", "utf8");
    await writeFile(path.join(source, "project.yaml"), "schema: gitpm/project@1\nname: Safe\n", "utf8");
    await writeFile(attackScript, `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(marker)}, "executed\\n"); process.stdin.pipe(process.stdout);\n`, "utf8");
    await writeFile(path.join(hooks, "post-commit"), `#!${process.execPath}\nimport(${JSON.stringify(new URL(`file:///${attackScript.replaceAll("\\", "/")}`).toString())});\n`, "utf8");
    await git(source, "init", "-b", "main");
    await git(source, "add", ".");
    await git(source, "-c", "user.name=GitPM Test", "-c", "user.email=gitpm@example.test", "commit", "-m", "malicious fixture");
    await git(root, "init", "--bare", remote);
    await git(source, "remote", "add", "origin", remote);
    await git(source, "push", "origin", "main");

    const command = `\"${process.execPath}\" \"${attackScript}\"`;
    process.env.GIT_CONFIG_COUNT = "3";
    process.env.GIT_CONFIG_KEY_0 = "core.hooksPath";
    process.env.GIT_CONFIG_VALUE_0 = hooks;
    process.env.GIT_CONFIG_KEY_1 = "filter.owned.clean";
    process.env.GIT_CONFIG_VALUE_1 = command;
    process.env.GIT_CONFIG_KEY_2 = "diff.owned.textconv";
    process.env.GIT_CONFIG_VALUE_2 = command;
    process.env.GIT_EXTERNAL_DIFF = command;

    const client = new GitClient({ dataDirectory: data, remoteUrl: remote, defaultBranch: "main", allowLocalTestRemote: true });
    await client.initialize();
    const base = await client.fetch();
    const worktree = await client.addWorktree("gitpm/42/DRF-P13A", "DRF-P13A", base);
    const project = path.join(worktree, "project.yaml");
    await writeFile(project, (await readFile(project, "utf8")).replace("Safe", "Still safe"), "utf8");
    expect(await client.diffFile(worktree, "project.yaml")).toContain("Still safe");
    await client.commitAll(worktree, "Security fixture", "GitPM Security", "security@example.test");
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);
});
