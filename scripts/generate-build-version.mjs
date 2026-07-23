import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { captureVersionFromGit } from "./git-version.mjs";

/**
 * Capture the build version into `build-version.json`. This is the only
 * producer and runs where Git is available (the host). When Git is unavailable
 * it writes nothing, leaving any previously captured file untouched — so it is
 * safe to re-run inside a Docker build, where the file was already shipped via
 * the build context.
 */
export function generateBuildVersion(cwd = process.cwd()) {
  const info = captureVersionFromGit(cwd);
  if (info === null) return null;
  writeFileSync(path.join(cwd, "build-version.json"), `${JSON.stringify(info, null, 2)}\n`);
  return info;
}

const isMainEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainEntry) {
  const info = generateBuildVersion();
  if (info === null) {
    console.log("build-version.json not written: Git unavailable");
    process.exitCode = 1;
  } else {
    console.log(`build-version.json -> ${info.version}`);
  }
}
