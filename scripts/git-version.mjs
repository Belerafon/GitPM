import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Build version derived from the current Git commit's author date.
 *
 * The version keeps the base semver from package.json and appends build metadata
 * derived from the commit timestamp (UTC) plus the short hash, e.g.
 * `0.1.0+20260723.1045.eb7f057`. When Git is unavailable (for example in a
 * stripped CI image), it falls back to `<base>+dev`.
 */

const DEV_TAG = "dev";

export function readBaseVersion(cwd) {
  let directory = cwd;
  while (directory && directory !== path.dirname(directory)) {
    try {
      const pkgPath = path.join(directory, "package.json");
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (typeof pkg.version === "string" && pkg.version.length > 0) return pkg.version;
    } catch {
      // No package.json here — keep walking up.
    }
    directory = path.dirname(directory);
  }
  return "0.0.0";
}

export function formatBuildVersion(baseVersion, commitDateIso, commit) {
  const parsed = new Date(commitDateIso);
  if (Number.isNaN(parsed.getTime())) return `${baseVersion}+${DEV_TAG}`;
  const pad = (value) => String(value).padStart(2, "0");
  const stamp =
    `${parsed.getUTCFullYear()}${pad(parsed.getUTCMonth() + 1)}${pad(parsed.getUTCDate())}` +
    `.${pad(parsed.getUTCHours())}${pad(parsed.getUTCMinutes())}`;
  const hash = typeof commit === "string" ? commit.trim() : "";
  const suffix = hash.length > 0 ? `.${hash}` : "";
  return `${baseVersion}+${stamp}${suffix}`;
}

export function readGitBuildInfo(cwd = process.cwd()) {
  const baseVersion = readBaseVersion(cwd);
  const envCommit = process.env.GITPM_BUILD_COMMIT?.trim();
  const envDate = process.env.GITPM_BUILD_DATE?.trim();

  let commit = "";
  let commitDateIso = "";
  const git = spawnSync("git", ["-C", cwd, "log", "-1", "--format=%cI%n%h"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (git.status === 0 && typeof git.stdout === "string") {
    const [dateLine, hashLine] = git.stdout.split("\n");
    commitDateIso = (dateLine ?? "").trim();
    commit = (hashLine ?? "").trim();
  }

  if (envCommit) commit = envCommit;
  if (envDate) commitDateIso = envDate;

  if (commitDateIso.length === 0) {
    return { baseVersion, version: `${baseVersion}+${DEV_TAG}`, commit: commit || DEV_TAG, commitDate: "" };
  }
  return {
    baseVersion,
    version: formatBuildVersion(baseVersion, commitDateIso, commit),
    commit: commit || DEV_TAG,
    commitDate: commitDateIso,
  };
}

const isMainEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainEntry) {
  console.log(JSON.stringify(readGitBuildInfo(), null, 2));
}
