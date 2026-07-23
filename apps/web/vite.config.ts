import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { readBuildVersion, VERSION_UNAVAILABLE } from "../../scripts/git-version.mjs";

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
const buildVersion = readBuildVersion(repoRoot)?.version ?? VERSION_UNAVAILABLE;

export default defineConfig({
  define: {
    __GITPM_BUILD_VERSION__: JSON.stringify(buildVersion),
  },
  server: { proxy },
  preview: { proxy },
});
