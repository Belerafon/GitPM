import { defineConfig } from "vite";

const proxy = {
  "/api": {
    target: process.env.GITPM_API_TARGET ?? "http://127.0.0.1:3000",
    changeOrigin: false,
  },
};

export default defineConfig({
  server: { proxy },
  preview: { proxy },
});
