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

describe("direct-mode checkout", () => {
  it("clones a normal checkout with .git when absent", async () => {
    const fixture = await remoteFixture();
    const client = new GitClient({
      dataDirectory: path.join(fixture.root, "data"),
      remoteUrl: fixture.remote,
      defaultBranch: "main",
      allowLocalRepository: true,
    });
    const checkout = await client.cloneOrReuseCheckout(path.join(fixture.root, "checkout"));
    expect(await git(checkout, "rev-parse", "--is-inside-work-tree")).toBe("true");
    expect(await client.checkoutCurrentBranch(checkout)).toBe("main");
    expect(await client.headCommit(checkout)).toBe(await git(fixture.source, "rev-parse", "HEAD"));
  });

  it("reuses an existing checkout and preserves uncommitted changes and local commits", async () => {
    const fixture = await remoteFixture();
    const client = new GitClient({
      dataDirectory: path.join(fixture.root, "data"),
      remoteUrl: fixture.remote,
      defaultBranch: "main",
      allowLocalRepository: true,
    });
    const checkoutPath = path.join(fixture.root, "checkout");
    const first = await client.cloneOrReuseCheckout(checkoutPath);
    await writeFile(path.join(first, "uncommitted.txt"), "local\n", "utf8");
    await git(first, "add", ".");
    await git(first, "-c", "user.name=Local", "-c", "user.email=local@example.test", "commit", "-m", "local commit");
    const localCommit = await git(first, "rev-parse", "HEAD");

    const reused = await client.cloneOrReuseCheckout(checkoutPath);
    expect(reused).toBe(first);
    expect(await readFile(path.join(reused, "uncommitted.txt"), "utf8")).toBe("local\n");
    expect(await client.headCommit(reused)).toBe(localCommit);
  });

  it("reports ahead/behind against origin/defaultBranch after fetch", async () => {
    const fixture = await remoteFixture();
    const client = new GitClient({
      dataDirectory: path.join(fixture.root, "data"),
      remoteUrl: fixture.remote,
      defaultBranch: "main",
      allowLocalRepository: true,
    });
    const checkout = await client.cloneOrReuseCheckout(path.join(fixture.root, "checkout"));
    await writeFile(path.join(checkout, "extra.txt"), "x\n", "utf8");
    await git(checkout, "add", ".");
    await git(checkout, "-c", "user.name=Local", "-c", "user.email=local@example.test", "commit", "-m", "local extra");
    const status = await client.checkoutAheadBehind(checkout);
    expect(status.behind).toBe(0);
    expect(status.ahead).toBe(1);
  });

  it("pushes main fast-forward to origin/main", async () => {
    const fixture = await remoteFixture();
    const client = new GitClient({
      dataDirectory: path.join(fixture.root, "data"),
      remoteUrl: fixture.remote,
      defaultBranch: "main",
      allowLocalRepository: true,
      askPassPath: path.resolve("scripts", "git-askpass.mjs"),
    });
    const checkout = await client.cloneOrReuseCheckout(path.join(fixture.root, "checkout"));
    await writeFile(path.join(checkout, "feature.txt"), "f\n", "utf8");
    await client.commitAll(checkout, "direct feature commit", "GitPM Direct", "direct@example.test", []);
    await client.fetchCheckoutRemote(checkout);
    const result = await client.pushMainFastForward(checkout, "unused-local-token");
    expect(result.branch).toBe("main");
    expect(await git(fixture.remote, "rev-parse", "main")).toBe(result.commit);
  });

  it("refuses non-fast-forward push instead of force pushing", async () => {
    const fixture = await remoteFixture();
    const client = new GitClient({
      dataDirectory: path.join(fixture.root, "data"),
      remoteUrl: fixture.remote,
      defaultBranch: "main",
      allowLocalRepository: true,
      askPassPath: path.resolve("scripts", "git-askpass.mjs"),
    });
    const checkout = await client.cloneOrReuseCheckout(path.join(fixture.root, "checkout"));

    // Diverge the remote independently of the checkout.
    await writeFile(path.join(fixture.source, "remote-only.txt"), "r\n", "utf8");
    await git(fixture.source, "add", ".");
    await git(fixture.source, "-c", "user.name=Remote", "-c", "user.email=remote@example.test", "commit", "-m", "remote only");
    await git(fixture.source, "push", "origin", "main");

    await writeFile(path.join(checkout, "local-only.txt"), "l\n", "utf8");
    await client.commitAll(checkout, "local only", "GitPM Direct", "direct@example.test", []);
    await client.fetchCheckoutRemote(checkout);
    await expect(client.pushMainFastForward(checkout, "unused-local-token")).rejects.toMatchObject({ code: "GIT_NON_FAST_FORWARD" });
  });
});
