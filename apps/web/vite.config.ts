import { defineConfig } from "vite";

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

export default defineConfig({
  server: { proxy },
  preview: { proxy },
});
