import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Build version, formatted from the current Git commit's author date as
 * `YYYY.MM.DD HHMM` (UTC), e.g. `2026.07.23 1045`.
 *
 * There is a single source of truth: the captured `build-version.json` file.
 * The running application reads ONLY that file (see `readBuildVersion`); it
 * never calls Git itself. The file is produced once, where Git is available,
 * by `scripts/generate-build-version.mjs` (see `captureVersionFromGit`). If the
 * file is absent, the version is reported as unavailable (`—`) rather than
 * guessed from another source.
 */

export const VERSION_UNAVAILABLE = "—";

export function formatBuildVersion(commitDateIso) {
  const parsed = new Date(commitDateIso);
  if (Number.isNaN(parsed.getTime())) return VERSION_UNAVAILABLE;
  const pad = (value) => String(value).padStart(2, "0");
  const date = `${parsed.getUTCFullYear()}.${pad(parsed.getUTCMonth() + 1)}.${pad(parsed.getUTCDate())}`;
  const time = `${pad(parsed.getUTCHours())}${pad(parsed.getUTCMinutes())}`;
  return `${date} ${time}`;
}

/**
 * Read the version straight from Git. This is the producer side and runs only
 * where `.git` is present (the host). Returns `null` when Git is unavailable so
 * the caller can leave any previously captured file untouched.
 */
export function captureVersionFromGit(cwd = process.cwd()) {
  const git = spawnSync("git", ["-C", cwd, "log", "-1", "--format=%cI%n%h"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (git.status !== 0 || typeof git.stdout !== "string") return null;
  const [dateLine, hashLine] = git.stdout.split("\n");
  const commitDate = (dateLine ?? "").trim();
  const commit = (hashLine ?? "").trim();
  if (commitDate.length === 0) return null;
  return { version: formatBuildVersion(commitDate), commit, commitDate };
}

/**
 * Read the captured build version. This is the single consumer side used by the
 * running application. Returns `null` when no version has been captured.
 */
export function readBuildVersion(cwd = process.cwd()) {
  try {
    const data = JSON.parse(readFileSync(path.join(cwd, "build-version.json"), "utf8"));
    if (data !== null && typeof data === "object" && typeof data.version === "string" && data.version.length > 0) {
      return {
        version: data.version,
        commit: typeof data.commit === "string" ? data.commit : "",
        commitDate: typeof data.commitDate === "string" ? data.commitDate : "",
      };
    }
  } catch {
    // No captured version available.
  }
  return null;
}

const isMainEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainEntry) {
  const info = readBuildVersion() ?? captureVersionFromGit();
  console.log(info === null ? VERSION_UNAVAILABLE : info.version);
}
