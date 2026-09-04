import { execFile, spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { verificationProfilesForPaths } from "./verification-change-impact.mjs";

const execFileAsync = promisify(execFile);
const git = process.platform === "win32" ? "git.exe" : "git";

function parseArguments(arguments_) {
  let base = process.env.GITPM_VERIFY_BASE || "main";
  let lowImpact = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    if (arguments_[index] === "--base") {
      base = arguments_[index + 1] ?? "";
      index += 1;
    } else if (arguments_[index] === "--low-impact") {
      lowImpact = true;
    } else {
      throw new Error(`Unknown changed-verification option: ${arguments_[index]}`);
    }
  }
  if (!base) throw new Error("Verification base must not be empty");
  return { base, lowImpact };
}

async function gitNames(args) {
  const { stdout } = await execFileAsync(git, args, { cwd: process.cwd(), encoding: "buffer", maxBuffer: 16 * 1024 * 1024 });
  return stdout.toString("utf8").split("\0").filter(Boolean);
}

export async function changedPaths(base) {
  const groups = await Promise.all([
    gitNames(["diff", "--name-only", "-z", `${base}...HEAD`]),
    gitNames(["diff", "--name-only", "-z"]),
    gitNames(["diff", "--cached", "--name-only", "-z"]),
    gitNames(["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  return [...new Set(groups.flat())].sort();
}

async function runProfile(profile, index, lowImpact) {
  const args = ["scripts/run-local-verification.mjs", "--profile", profile];
  if (index === 0) args.push("--install");
  if (lowImpact) args.push("--low-impact");
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: process.cwd(), env: process.env, stdio: "inherit", windowsHide: true });
    child.once("error", () => resolve(1));
    child.once("close", (code) => resolve(code ?? 1));
  });
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    const paths = await changedPaths(options.base);
    const profiles = verificationProfilesForPaths(paths);
    console.log(`[verify:changed] base=${options.base}; changed=${paths.length}; profiles=${profiles.join(",")}`);
    for (const file of paths) console.log(`[verify:changed] ${file}`);
    for (let index = 0; index < profiles.length; index += 1) {
      const code = await runProfile(profiles[index], index, options.lowImpact);
      if (code !== 0) {
        process.exitCode = code;
        return;
      }
    }
  } catch (error) {
    console.error(`[verify:changed] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
