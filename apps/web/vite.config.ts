import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { readGitBuildInfo } from "../../scripts/git-version.mjs";

const apiTarget = process.env.GITPM_API_TARGET;
if (!apiTarget && process.env.GITPM_RUNTIME_MODE === "production") {
  console.warn("[GitPM] GITPM_API_TARGET is not set; web UI will proxy /api to http://127.0.0.1:3000 (single-host only).");
}

const proxy = {
  "/api": {
    target: apiTarget ?? "http://127.0.0.1:3000",
    changeOrigin: false,
  },
};

const projectDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(projectDir, "../..");
const buildInfo = readGitBuildInfo(repoRoot);

export default defineConfig({
  define: {
    __GITPM_BUILD_VERSION__: JSON.stringify(buildInfo.version),
    __GITPM_BUILD_COMMIT__: JSON.stringify(buildInfo.commit),
    __GITPM_BUILD_COMMIT_DATE__: JSON.stringify(buildInfo.commitDate),
  },
  server: { proxy },
  preview: { proxy },
});
