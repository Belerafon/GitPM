import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { GitClient, GitCommandError } from "./index.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return result.stdout.trim();
}

async function remoteFixture(): Promise<{ root: string; source: string; remote: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gitpm-git-client-"));
  roots.push(root);
  const source = path.join(root, "source");
  const remote = path.join(root, "remote.git");
  await mkdir(source);
  await git(source, "init", "-b", "main");
  await writeFile(path.join(source, "README.md"), "first\n", "utf8");
  await git(source, "add", ".");
  await git(source, "-c", "user.name=GitPM Test", "-c", "user.email=gitpm@example.test", "commit", "-m", "first");
  await git(root, "init", "--bare", remote);
  await git(source, "remote", "add", "origin", remote);
  await git(source, "push", "-u", "origin", "main");
  return { root, source, remote };
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("controlled Git client", () => {
  it("fetches before creating a worktree from exact current remote main", async () => {
    const fixture = await remoteFixture();
    const commands: string[][] = [];
    const client = new GitClient({
      dataDirectory: path.join(fixture.root, "data"),
      remoteUrl: fixture.remote,
      defaultBranch: "main",
      allowLocalTestRemote: true,
      onCommand: (record) => commands.push([...record.args]),
    });
    await client.initialize();
    const first = await client.fetch();

    await writeFile(path.join(fixture.source, "README.md"), "second\n", "utf8");
    await git(fixture.source, "add", ".");
    await git(fixture.source, "-c", "user.name=GitPM Test", "-c", "user.email=gitpm@example.test", "commit", "-m", "second");
    await git(fixture.source, "push", "origin", "main");
    const remoteHead = await git(fixture.source, "rev-parse", "HEAD");

    const fetched = await client.fetch();
    expect(fetched).toBe(remoteHead);
    expect(fetched).not.toBe(first);
    const worktree = await client.addWorktree("gitpm/42/DRF-001", "DRF-001", fetched);
    expect(await client.headCommit(worktree)).toBe(remoteHead);
    expect(commands.findIndex((args) => args.includes("fetch"))).toBeLessThan(commands.findIndex((args) => args.includes("worktree")));
  });

  it("does not fall back to a stale commit when fetch fails", async () => {
    const fixture = await remoteFixture();
    const client = new GitClient({
      dataDirectory: path.join(fixture.root, "data"),
      remoteUrl: fixture.remote,
      defaultBranch: "main",
      allowLocalTestRemote: true,
    });
    await client.initialize();
    await client.fetch();
    await rm(fixture.remote, { recursive: true, force: true });
    await expect(client.fetch()).rejects.toBeInstanceOf(GitCommandError);
  });

  it("computes Git blob IDs for optimistic revisions", async () => {
    const fixture = await remoteFixture();
    const client = new GitClient({
      dataDirectory: path.join(fixture.root, "data"),
      remoteUrl: fixture.remote,
      defaultBranch: "main",
      allowLocalTestRemote: true,
    });
    await client.initialize();
    const contentFile = path.join(fixture.source, "content.txt");
    await writeFile(contentFile, "content\n", "utf8");
    const actual = await client.hashObject("content\n");
    const expected = await git(fixture.source, "hash-object", contentFile);
    expect(actual).toMatch(/^[0-9a-f]{40}$/u);
    expect(actual).toBe(expected);
  });

  it("computes multiple working-tree blob IDs in one Git command", async () => {
    const fixture = await remoteFixture();
    const commands: string[][] = [];
    const client = new GitClient({
      dataDirectory: path.join(fixture.root, "data"),
      remoteUrl: fixture.remote,
      defaultBranch: "main",
      allowLocalTestRemote: true,
      onCommand: (record) => commands.push([...record.args]),
    });
    await client.initialize();
    await writeFile(path.join(fixture.source, "second.txt"), "second\n", "utf8");
    commands.length = 0;

    const actual = await client.hashFiles(fixture.source, ["README.md", "second.txt"]);
    const batchCommands = [...commands];

    expect(actual.get("README.md")).toBe(await client.hashObject(await readFile(path.join(fixture.source, "README.md"), "utf8")));
    expect(actual.get("second.txt")).toBe(await client.hashObject(await readFile(path.join(fixture.source, "second.txt"), "utf8")));
    expect(batchCommands).toEqual([expect.arrayContaining(["hash-object", "--stdin-paths"])]);
  });
});
