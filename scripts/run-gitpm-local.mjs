import { spawn, spawnSync } from "node:child_process";
import { waitForGitPmServices } from "./gitpm-readiness.mjs";
import { prepareGitPmRuntime } from "./configure-gitpm-runtime.mjs";

const isWindows = process.platform === "win32";
const serverPort = process.env.GITPM_SERVER_PORT ?? "3000";
const webPort = process.env.GITPM_WEB_PORT ?? "5173";
const serverUrl = `http://127.0.0.1:${serverPort}`;
const webUrl = `http://127.0.0.1:${webPort}`;
const children = new Set();
let stopping = false;
let exitCode = 0;

function start(label, args, extraEnv = {}) {
  const child = spawn("corepack", args, {
    cwd: process.cwd(),
    env: { ...process.env, ...extraEnv },
    shell: isWindows,
    stdio: "inherit",
    windowsHide: true,
  });

  children.add(child);
  child.once("error", (error) => {
    console.error(`[GitPM] Не удалось запустить ${label}: ${error.message}`);
    exitCode = 1;
    shutdown();
  });
  child.once("exit", (code, signal) => {
    children.delete(child);
    if (!stopping) {
      const reason = signal === null ? `код ${code ?? 1}` : `сигнал ${signal}`;
      console.error(`[GitPM] ${label} неожиданно завершился (${reason}).`);
      exitCode = code && code !== 0 ? code : 1;
      shutdown();
    }
  });
  return child;
}

function terminateTree(child) {
  if (child.pid === undefined || child.killed) return;
  if (isWindows) {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } else {
    child.kill("SIGTERM");
  }
}

function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log("\n[GitPM] Останавливаю приложение...");
  for (const child of children) terminateTree(child);
  children.clear();
  process.exitCode = exitCode;
  setTimeout(() => process.exit(exitCode), 50).unref();
}

async function openWhenReady() {
  const ready = await waitForGitPmServices({
    serverUrl: `${serverUrl}/health/ready`,
    webUrl,
    attempts: 240,
    intervalMs: 250,
    isCancelled: () => stopping,
  });
  if (stopping) return;
  if (!ready) {
    console.error("[GitPM] Сервер или интерфейс не запустился за 60 секунд.");
    exitCode = 1;
    shutdown();
    return;
  }

  console.log(`\n[GitPM] READY — приложение готово: ${webUrl}`);
  if (isWindows && process.env.GITPM_NO_BROWSER !== "1") {
    const opener = spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "start", "", webUrl], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    opener.unref();
  }
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => shutdown());
}
process.once("uncaughtException", (error) => {
  console.error(`[GitPM] Необработанная ошибка: ${error.stack ?? error.message}`);
  exitCode = 1;
  shutdown();
});

let runtime;
try {
  console.log("[GitPM] Читаю конфигурацию репозитория из .gitpm/config.json...");
  runtime = await prepareGitPmRuntime();
} catch (error) {
  console.error(`[GitPM] Не удалось настроить репозиторий: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
console.log(`[GitPM] Репозиторий: ${runtime.configuration.repository}`);
console.log(runtime.remoteUrl === undefined
  ? "[GitPM] Remote не настроен — локальная работа доступна, push отключён."
  : `[GitPM] Remote: ${runtime.remoteUrl}`);
console.log(runtime.environment.GITPM_GITLAB_CLIENT_ID === undefined
  ? "[GitPM] GitLab OAuth не настроен — вход не требуется для локальной работы (настройки: .gitpm/config.json)."
  : "[GitPM] GitLab OAuth доступен и будет запрошен только для remote-операций.");

start("сервер", ["pnpm", "dev:server"], {
  HOST: "127.0.0.1",
  PORT: serverPort,
  GITPM_WEB_URL: webUrl,
  ...runtime.environment,
});
start("web-интерфейс", [
  "pnpm", "--filter", "@gitpm/web", "exec", "vite",
  "--host", "127.0.0.1", "--port", webPort, "--strictPort",
], { GITPM_API_TARGET: serverUrl });
void openWhenReady();
