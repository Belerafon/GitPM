import { spawn } from "node:child_process";
import { lstat, mkdtemp, readFile, readdir, readlink, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ExportError } from "./types.js";
import { createZip, type ZipEntry } from "./zip.js";

async function filesystemEntries(rootInput: string, options: { readonly excludeGit: boolean; readonly prefix?: string }): Promise<ZipEntry[]> {
  const root = await realpath(rootInput);
  const entries: ZipEntry[] = [];
  const visit = async (absolute: string, relative: string): Promise<void> => {
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      if (options.excludeGit && entry.name === ".git") continue;
      const childRelative = relative === "" ? entry.name : `${relative}/${entry.name}`;
      const name = options.prefix ? `${options.prefix}/${childRelative}` : childRelative;
      const child = path.join(absolute, entry.name);
      const metadata = await lstat(child);
      if (metadata.isSymbolicLink()) {
        entries.push({ name, content: Buffer.from(await readlink(child), "utf8"), date: metadata.mtime, mode: 0o120777 });
      } else if (metadata.isDirectory()) {
        entries.push({ name, directory: true, date: metadata.mtime, mode: 0o40755 });
        await visit(child, childRelative);
      } else if (metadata.isFile()) {
        entries.push({ name, content: await readFile(child), date: metadata.mtime, mode: 0o100000 | (metadata.mode & 0o777) });
      }
    }
  };
  await visit(root, "");
  return entries;
}

async function runGit(args: readonly string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", args, {
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { if (stderr.length < 16_384) stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new ExportError("EXPORT_GIT_CLONE_FAILED", `Git exited with ${code}: ${stderr.trim()}`)));
  });
}

export async function repositoryZip(root: string, includeGit: boolean): Promise<Buffer> {
  const workingEntries = await filesystemEntries(root, { excludeGit: true });
  if (!includeGit) return createZip(workingEntries);
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "gitpm-export-"));
  const clone = path.join(temporaryRoot, "repository");
  try {
    await runGit(["clone", "--no-hardlinks", "--no-checkout", "--", root, clone]);
    await runGit(["-C", clone, "read-tree", "HEAD"]);
    await runGit(["-C", clone, "remote", "remove", "origin"]);
    await rm(path.join(clone, ".git", "logs"), { recursive: true, force: true });
    const gitEntries = await filesystemEntries(path.join(clone, ".git"), { excludeGit: false, prefix: ".git" });
    return createZip([...workingEntries, { name: ".git", directory: true, mode: 0o40755 }, ...gitEntries]);
  } finally {
    const resolvedTemporaryRoot = path.resolve(temporaryRoot);
    if (resolvedTemporaryRoot.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolvedTemporaryRoot).startsWith("gitpm-export-")) {
      await rm(resolvedTemporaryRoot, { recursive: true, force: true });
    }
  }
}
