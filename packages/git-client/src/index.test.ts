import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { GitClient, GitCommandError } from "./index.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
let templateRoot: string;
let templateSource: string;
let templateRemote: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return result.stdout.trim();
}

beforeAll(async () => {
  templateRoot = await mkdtemp(path.join(os.tmpdir(), "gitpm-git-client-template-"));
  templateSource = path.join(templateRoot, "source");
  templateRemote = path.join(templateRoot, "remote.git");
  await mkdir(templateSource);
  await git(templateSource, "init", "-b", "main");
  await writeFile(path.join(templateSource, "README.md"), "first\n", "utf8");
  await git(templateSource, "add", ".");
  await git(templateSource, "-c", "user.name=GitPM Test", "-c", "user.email=gitpm@example.test", "commit", "-m", "first");
  await git(templateRoot, "init", "--bare", templateRemote);
  await git(templateSource, "remote", "add", "origin", templateRemote);
  await git(templateSource, "push", "-u", "origin", "main");
});

afterAll(async () => rm(templateRoot, { recursive: true, force: true }));

async function remoteFixture(): Promise<{ root: string; source: string; remote: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gitpm-git-client-"));
  roots.push(root);
  const source = path.join(root, "source");
  const remote = path.join(root, "remote.git");
  await Promise.all([
    cp(templateSource, source, { recursive: true }),
    cp(templateRemote, remote, { recursive: true }),
  ]);
  await git(source, "remote", "set-url", "origin", remote);
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

  it("skips paths absent from HEAD when reading HEAD files in batch", async () => {
    const fixture = await remoteFixture();
    const client = new GitClient({
      dataDirectory: path.join(fixture.root, "data"),
      remoteUrl: fixture.remote,
      defaultBranch: "main",
      allowLocalTestRemote: true,
    });
    await client.initialize();

    const headFiles = await client.showHeadFiles(fixture.source, ["README.md", "never-committed.yaml"]);
    expect(headFiles.get("README.md")).toBe("first\n");
    expect(headFiles.has("never-committed.yaml")).toBe(false);
  });
});

describe("direct-mode checkout", () => {
  it("uses the selected checkout in place", async () => {
    const fixture = await remoteFixture();
    const client = new GitClient({
      dataDirectory: path.join(fixture.root, "data"),
      remoteUrl: fixture.source,
      pushRemoteUrl: fixture.remote,
      defaultBranch: "main",
      allowLocalTestRemote: true,
    });
    const checkout = await client.checkoutRealPath(fixture.source);
    expect(await git(checkout, "rev-parse", "--is-inside-work-tree")).toBe("true");
    expect(await client.checkoutCurrentBranch(checkout)).toBe("main");
    expect(checkout).toBe(path.resolve(fixture.source));
  });

  it("preserves existing changes and local commits", async () => {
    const fixture = await remoteFixture();
    const client = new GitClient({
      dataDirectory: path.join(fixture.root, "data"),
      remoteUrl: fixture.source,
      pushRemoteUrl: fixture.remote,
      defaultBranch: "main",
      allowLocalTestRemote: true,
    });
    const first = await client.checkoutRealPath(fixture.source);
    await writeFile(path.join(first, "uncommitted.txt"), "local\n", "utf8");
    await git(first, "add", ".");
    await git(first, "-c", "user.name=Local", "-c", "user.email=local@example.test", "commit", "-m", "local commit");
    const localCommit = await git(first, "rev-parse", "HEAD");

    const reused = await client.checkoutRealPath(fixture.source);
    expect(reused).toBe(first);
    expect(await readFile(path.join(reused, "uncommitted.txt"), "utf8")).toBe("local\n");
    expect(await client.headCommit(reused)).toBe(localCommit);
  });

  it("reports ahead/behind against origin/defaultBranch after fetch", async () => {
    const fixture = await remoteFixture();
    const client = new GitClient({
      dataDirectory: path.join(fixture.root, "data"),
      remoteUrl: fixture.source,
      pushRemoteUrl: fixture.remote,
      defaultBranch: "main",
      allowLocalTestRemote: true,
    });
    const checkout = await client.checkoutRealPath(fixture.source);
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
      remoteUrl: fixture.source,
      pushRemoteUrl: fixture.remote,
      defaultBranch: "main",
      allowLocalTestRemote: true,
      askPassPath: path.resolve("scripts", "git-askpass.mjs"),
    });
    const checkout = await client.checkoutRealPath(fixture.source);
    await writeFile(path.join(checkout, "feature.txt"), "f\n", "utf8");
    await client.commitAll(checkout, "direct feature commit", "GitPM Direct", "direct@example.test", []);
    await client.fetchCheckoutRemote(checkout);
    const result = await client.pushMainFastForward(checkout, "unused-local-token");
    expect(result.branch).toBe("main");
    expect(await git(fixture.remote, "rev-parse", "main")).toBe(result.commit);
  });

  it("refuses to publish when the selected checkout is not on the configured default branch", async () => {
    const fixture = await remoteFixture();
    const client = new GitClient({
      dataDirectory: path.join(fixture.root, "data"),
      remoteUrl: fixture.source,
      pushRemoteUrl: fixture.remote,
      defaultBranch: "main",
      allowLocalTestRemote: true,
      askPassPath: path.resolve("scripts", "git-askpass.mjs"),
    });
    const remoteMain = await git(fixture.remote, "rev-parse", "main");
    await git(fixture.source, "checkout", "-b", "feature/not-main");
    await writeFile(path.join(fixture.source, "feature.txt"), "feature\n", "utf8");
    await client.commitAll(fixture.source, "feature commit", "GitPM Direct", "direct@example.test", []);

    await expect(client.assertCheckoutOnDefaultBranch(fixture.source))
      .rejects.toMatchObject({ code: "GIT_WRONG_BRANCH" });
    await expect(client.pushMainFastForward(fixture.source, "unused-local-token"))
      .rejects.toMatchObject({ code: "GIT_WRONG_BRANCH" });
    expect(await git(fixture.remote, "rev-parse", "main")).toBe(remoteMain);
  });

  it("refuses non-fast-forward push instead of force pushing", async () => {
    const fixture = await remoteFixture();
    const client = new GitClient({
      dataDirectory: path.join(fixture.root, "data"),
      remoteUrl: fixture.source,
      pushRemoteUrl: fixture.remote,
      defaultBranch: "main",
      allowLocalTestRemote: true,
      askPassPath: path.resolve("scripts", "git-askpass.mjs"),
    });
    const checkout = await client.checkoutRealPath(fixture.source);

    // Diverge the remote independently of the checkout.
    const other = path.join(fixture.root, "other");
    await git(fixture.root, "clone", "--branch", "main", fixture.remote, other);
    await writeFile(path.join(other, "remote-only.txt"), "r\n", "utf8");
    await git(other, "add", ".");
    await git(other, "-c", "user.name=Remote", "-c", "user.email=remote@example.test", "commit", "-m", "remote only");
    await git(other, "push", "origin", "main");

    await writeFile(path.join(checkout, "local-only.txt"), "l\n", "utf8");
    await client.commitAll(checkout, "local only", "GitPM Direct", "direct@example.test", []);
    await client.fetchCheckoutRemote(checkout);
    await expect(client.pushMainFastForward(checkout, "unused-local-token")).rejects.toMatchObject({ code: "GIT_NON_FAST_FORWARD" });
  });

  it("reconfigures origin in place and publishes the selected checkout", async () => {
    const fixture = await remoteFixture();
    const upstream = path.join(fixture.root, "upstream.git");
    await git(fixture.root, "clone", "--bare", fixture.remote, upstream);
    const client = new GitClient({
      dataDirectory: path.join(fixture.root, "data"),
      remoteUrl: fixture.source,
      pushRemoteUrl: upstream,
      defaultBranch: "main",
      allowLocalTestRemote: true,
      askPassPath: path.resolve("scripts", "git-askpass.mjs"),
    });
    const checkout = await client.checkoutRealPath(fixture.source);
    await client.configureCheckoutPublishingRemote(checkout);

    expect(await git(checkout, "remote", "get-url", "origin")).toBe(path.resolve(upstream));
    expect((await git(checkout, "remote")).split(/\r?\n/u)).toEqual(["origin"]);
    await writeFile(path.join(checkout, "upstream-only.txt"), "published\n", "utf8");
    await client.commitAll(checkout, "publish upstream", "GitPM Direct", "direct@example.test", []);
    await client.fetchCheckoutRemote(checkout, "unused-local-token");
    const result = await client.pushMainFastForward(checkout, "unused-local-token");

    expect(await git(fixture.root, "--git-dir", upstream, "rev-parse", "main")).toBe(result.commit);
  });

  it("diffFiles falls back to per-file diffs when the combined batch exceeds the output limit", async () => {
    const fixture = await remoteFixture();
    const client = new GitClient({
      dataDirectory: path.join(fixture.root, "data"),
      remoteUrl: fixture.remote,
      defaultBranch: "main",
      allowLocalTestRemote: true,
    });
    const block = (count: number) => `${Array.from({ length: count }, (_, index) => `line-${index}-${"x".repeat(20)}`).join("\n")}\n`;
    const targets = ["big-a.txt", "big-b.txt", "big-c.txt"];
    for (const target of targets) await writeFile(path.join(fixture.source, target), "base\n", "utf8");
    await git(fixture.source, "add", ".");
    await git(fixture.source, "-c", "user.name=GitPM Test", "-c", "user.email=gitpm@example.test", "commit", "-m", "big bases");
    await git(fixture.source, "push", "origin", "main");

    await client.initialize();
    const fetched = await client.fetch();
    const worktree = await client.addWorktree("gitpm/42/DRF-BIG", "DRF-BIG", fetched);
    for (const target of targets) await writeFile(path.join(worktree, target), block(15000), "utf8");

    const diffs = await client.diffFiles(worktree, targets, 1);
    expect(diffs.size).toBe(targets.length);
    for (const target of targets) expect(diffs.get(target)?.startsWith(`diff --git a/${target} b/${target}`)).toBe(true);
  });

  it("diffFiles omits a single file whose diff exceeds the output limit", async () => {
    const fixture = await remoteFixture();
    const client = new GitClient({
      dataDirectory: path.join(fixture.root, "data"),
      remoteUrl: fixture.remote,
      defaultBranch: "main",
      allowLocalTestRemote: true,
    });
    const block = (count: number) => `${Array.from({ length: count }, (_, index) => `line-${index}-${"x".repeat(20)}`).join("\n")}\n`;
    await writeFile(path.join(fixture.source, "huge.txt"), "base\n", "utf8");
    await git(fixture.source, "add", ".");
    await git(fixture.source, "-c", "user.name=GitPM Test", "-c", "user.email=gitpm@example.test", "commit", "-m", "huge base");
    await git(fixture.source, "push", "origin", "main");

    await client.initialize();
    const fetched = await client.fetch();
    const worktree = await client.addWorktree("gitpm/42/DRF-HUGE", "DRF-HUGE", fetched);
    await writeFile(path.join(worktree, "huge.txt"), block(38000), "utf8");

    const diffs = await client.diffFiles(worktree, ["huge.txt"], 1);
    expect(diffs.size).toBe(0);
  });
});
