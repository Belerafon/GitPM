import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const sourceRoots = ["apps/cli/src", "apps/server/src", "apps/web/src", "packages"];
const sourceFile = /(?<!\.test)\.(?:ts|tsx|js|mjs|cjs)$/u;
const checks = [
  { name: "map.plan", pattern: /\bmap\.plan\b/u, message: "Do not read the plan track implicitly; resolve the configured track." },
  { name: "first schedule window", pattern: /Object\.values\([^\n]*\.schedules[^\n]*\)\s*\[\s*0\s*\]/u, message: "Do not select a schedule window by object order; use an explicit track." },
  { name: "literal done status", pattern: /\bstatus\s*===\s*["']done["']/u, message: "Use status category semantics instead of the done slug." },
  { name: "local Gantt domain builder", pattern: /(?:function|const)\s+\w*(?:build|Build)\w*Gantt\w*/u, message: "Web UI must project an exported @gitpm/scheduling model, not build one locally." },
  { name: "form schedules replacement", pattern: /(?:setSchedules|onChange)\s*\(\s*\{\s*\[[^\]]+\]\s*:/u, message: "Schedule form mutations must preserve neighboring windows through updateScheduleWindow or setScheduleDependencies." },
];

async function files(directory) {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(relative));
    else if (sourceFile.test(entry.name) && !relative.includes("/dist/") && !relative.includes("/generated/")) result.push(relative);
  }
  return result;
}

const violations = [];
for (const relative of (await Promise.all(sourceRoots.map(files))).flat()) {
  const content = await readFile(path.join(root, relative), "utf8");
  for (const check of checks) {
    if (check.name === "local Gantt domain builder" && !relative.startsWith("apps/web/src/")) continue;
    if (!check.pattern.test(content)) continue;
    const line = content.slice(0, content.search(check.pattern)).split("\n").length;
    violations.push(`${relative}:${line}: ${check.name}: ${check.message}`);
  }
}
if (violations.length > 0) throw new Error(`Scheduling regression check failed:\n${violations.join("\n")}`);
