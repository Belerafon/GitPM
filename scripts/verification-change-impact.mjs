const profileOrder = [
  "guidance",
  "repository",
  "planning-domain",
  "workflow",
  "export",
  "cli",
  "server",
  "web",
  "tooling",
  "e2e-workflow",
  "e2e-ui",
  "docs",
];

const fullGateFiles = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "eslint.config.mjs",
  "playwright.config.ts",
  "vitest.config.ts",
  "tsconfig.json",
  "scripts/run-local-verification.mjs",
  "scripts/run-changed-verification.mjs",
  "scripts/verification-change-impact.mjs",
  "scripts/run-playwright-locked.mjs",
]);

const repositoryPackages = [
  "packages/domain/",
  "packages/repository-format/",
  "packages/task-hierarchy/",
  "packages/validation/",
];
const planningPackages = [
  "packages/calendar/",
  "packages/scheduling/",
  "packages/time-entries/",
  "packages/workload/",
];
const workflowPackages = [
  "packages/agent/",
  "packages/changes/",
  "packages/drafts/",
  "packages/git-client/",
  "packages/gitlab/",
  "packages/history/",
  "packages/logging/",
  "packages/publishing/",
  "packages/security/",
];

function add(profiles, ...names) {
  for (const name of names) profiles.add(name);
}

export function verificationProfilesForPaths(inputPaths) {
  const paths = [...new Set(inputPaths.map((file) => file.replaceAll("\\", "/")))];
  if (paths.length === 0) return ["docs"];
  if (paths.some((file) => fullGateFiles.has(file) || /^(tsconfig|vitest|playwright|eslint)[^/]*\./u.test(file))) {
    return ["full"];
  }

  const profiles = new Set();
  for (const file of paths) {
    if (file.startsWith("docs/") || file === "AGENTS.md" || file.endsWith(".md")) {
      add(profiles, "docs");
    } else if (file.startsWith("apps/web/")) {
      add(profiles, "web", "e2e-ui");
    } else if (file.startsWith("apps/server/")) {
      add(profiles, "server", "e2e-workflow");
    } else if (file.startsWith("apps/cli/")) {
      add(profiles, "cli");
    } else if (file.startsWith("packages/contracts/") || file.startsWith("packages/shared/")) {
      add(profiles, "repository", "cli", "server", "web");
    } else if (repositoryPackages.some((prefix) => file.startsWith(prefix))) {
      add(profiles, "repository");
    } else if (planningPackages.some((prefix) => file.startsWith(prefix))) {
      add(profiles, "planning-domain");
    } else if (workflowPackages.some((prefix) => file.startsWith(prefix))) {
      add(profiles, file.includes("guidance") ? "guidance" : "workflow");
    } else if (file.startsWith("packages/export/")) {
      add(profiles, "export");
    } else if (file.startsWith("e2e/")) {
      add(profiles, file.includes("project-files-changes") || file.includes("app-ui") || file.includes("gantt") || file.includes("geometry") || file.includes("schedule-preservation") ? "e2e-ui" : "e2e-workflow");
    } else if (file.startsWith("scripts/") || file.startsWith("schemas/") || file.startsWith("fixtures/")) {
      add(profiles, "tooling");
    } else {
      return ["full"];
    }
  }

  const selected = profileOrder.filter((profile) => profiles.has(profile));
  return selected.length > 4 ? ["full"] : selected;
}

export function stepAffectedByPaths(stepName, inputPaths) {
  if (inputPaths.length === 0) return false;
  const paths = inputPaths.map((file) => file.replaceAll("\\", "/"));
  const dependencyChange = paths.some((file) => file === "package.json" || file === "pnpm-lock.yaml" || file.endsWith("/package.json"));
  const rootConfigurationChange = paths.some((file) => fullGateFiles.has(file) || /^(tsconfig|vitest|playwright|eslint)[^/]*\./u.test(file));
  const e2eOnly = paths.every((file) => file.startsWith("e2e/") || file === "playwright.config.ts");
  const documentationOnly = paths.every((file) => file.startsWith("docs/") || file === "AGENTS.md" || file.endsWith(".md"));

  if (stepName === "frozen install") return dependencyChange;
  if (documentationOnly) return stepName === "diff whitespace";
  if (rootConfigurationChange) return true;
  if (stepName === "clean" || stepName.startsWith("build")) return !e2eOnly;
  if (stepName.includes("lint") || stepName.includes("typecheck")) return true;
  if (stepName === "tests" || stepName === "thematic tests") return !e2eOnly;
  if (stepName === "e2e" || stepName.includes("browser tests")) return true;
  if (stepName === "smoke") return paths.some((file) => file.startsWith("apps/server/") || file.startsWith("scripts/smoke"));
  if (stepName === "schemas" || stepName === "schema contracts") return paths.some((file) => file.startsWith("schemas/") || file.startsWith("packages/contracts/") || file.startsWith("scripts/generate-contract"));
  if (stepName === "security report") return paths.some((file) => file.startsWith("packages/security/") || file.startsWith("scripts/security"));
  if (stepName === "planning" || stepName === "planning validators") return paths.some((file) => planningPackages.some((prefix) => file.startsWith(prefix)) || file.startsWith("scripts/validate_planning") || file.startsWith("scripts/test_planning"));
  return true;
}
