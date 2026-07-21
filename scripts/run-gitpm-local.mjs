import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { isTcpPortAvailable, waitForGitPmServices } from "./gitpm-readiness.mjs";
import { prepareGitPmRuntime } from "./configure-gitpm-runtime.mjs";

const isWindows = process.platform === "win32";
const isProduction = process.env.GITPM_RUNTIME_MODE === "production";
const bindHost = process.env.GITPM_BIND_HOST ?? "127.0.0.1";
const serverPort = process.env.GITPM_SERVER_PORT ?? "3000";
const webPort = process.env.GITPM_WEB_PORT ?? "5173";
const serverUrl = `http://127.0.0.1:${serverPort}`;
const webUrl = `http://127.0.0.1:${webPort}`;
const serverCwd = resolve(process.cwd(), "apps/server");
const webCwd = resolve(process.cwd(), "apps/web");
const serverRequire = createRequire(resolve(serverCwd, "package.json"));
const webRequire = createRequire(resolve(webCwd, "package.json"));
const tsxCli = serverRequire.resolve("tsx/cli");
const viteCli = resolve(dirname(webRequire.resolve("vite")), "../../bin/vite.js");
const children = new Set();
let stopping = false;
let exitCode = 0;

// Windows uses this NTSTATUS when a console process is stopped with Ctrl+C.
// Depending on the layer reporting it, it can be represented as unsigned or signed.
const windowsControlCExitCodes = new Set([0xC000013A, -1073741510]);

function isWindowsControlCExit(code, signal) {
  return isWindows && signal === null && code !== null && windowsControlCExitCodes.has(code);
}

function start(label, cwd, args, extraEnv = {}) {
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...process.env, ...extraEnv },
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
      // There is still a small race when the terminal itself broadcasts a
      // control event (for example while closing an older console window).
      // Treat its native status as the same successful user-requested stop.
      if (isWindowsControlCExit(code, signal)) {
        shutdown();
        return;
      }
      // On Windows all console processes receive Ctrl+C together. Give this
      // supervisor's signal handler one event-loop turn before deciding that
      // a child which exited first was an application failure.
      setTimeout(() => {
        if (stopping) return;
        const reason = signal === null ? `код ${code ?? 1}` : `сигнал ${signal}`;
        console.error(`[GitPM] ${label} неожиданно завершился (${reason}).`);
        exitCode = code && code !== 0 ? code : 1;
        shutdown();
      }, isWindows ? 50 : 0);
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

const shutdownSignals = isWindows
  ? ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]
  : ["SIGINT", "SIGTERM", "SIGHUP"];

for (const signal of shutdownSignals) {
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

const ports = [
  { label: "API-сервер", host: "127.0.0.1", port: serverPort, environment: "GITPM_SERVER_PORT" },
  { label: "web-интерфейс", host: "127.0.0.1", port: webPort, environment: "GITPM_WEB_PORT" },
];
const unavailable = (await Promise.all(ports.map(async (service) => ({
  ...service,
  available: await isTcpPortAvailable(service),
})))).filter((service) => !service.available);
if (unavailable.length > 0) {
  for (const service of unavailable) {
    console.error(`[GitPM] ${service.label} не запущен: порт ${service.host}:${service.port} уже занят.`);
  }
  console.error("[GitPM] Закройте предыдущий экземпляр GitPM или задайте другие порты через GITPM_SERVER_PORT/GITPM_WEB_PORT.");
  process.exit(1);
}

start("сервер", serverCwd, isProduction ? ["dist/index.js"] : [tsxCli, "watch", "src/index.ts"], {
  HOST: bindHost,
  PORT: serverPort,
  GITPM_WEB_URL: webUrl,
  ...runtime.environment,
});
start("web-интерфейс", webCwd, [
  viteCli,
  ...(isProduction ? ["preview"] : []),
  "--host", bindHost, "--port", webPort, "--strictPort",
], { GITPM_API_TARGET: serverUrl });
void openWhenReady();
