import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CONFIG_PATH = path.resolve(".gitpm", "config.json");
const BUNDLED_DEMO_TEMPLATE = path.resolve("demo", "portfolio");
const BUNDLED_DEMO_REPOSITORY = path.resolve(".gitpm", "demo-repository");
const BUNDLED_DEMO_VERSION_PATH = path.resolve(".gitpm", "demo-repository.version");
const BUNDLED_DEMO_DATA_DIRECTORY = path.resolve(".gitpm", "demo-runtime");

async function git(repository, ...args) {
  const result = await execFileAsync("git", ["-C", repository, ...args], { windowsHide: true });
  return result.stdout.trim();
}

async function validRepository(candidate) {
  if (typeof candidate !== "string" || candidate.trim() === "") return undefined;
  try {
    if (!(await stat(candidate)).isDirectory()) return undefined;
    const repository = await realpath(candidate);
    const root = await realpath(await git(repository, "rev-parse", "--show-toplevel"));
    await git(root, "rev-parse", "HEAD^{commit}");
    return root === repository ? repository : undefined;
  } catch {
    return undefined;
  }
}

async function readConfiguration() {
  try {
    const parsed = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error(`Не удалось прочитать ${CONFIG_PATH}: ${error.message}`);
  }
}

async function saveConfiguration(configuration) {
  await mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, `${JSON.stringify(configuration, null, 2)}\n`, "utf8");
}

export async function directoryFingerprint(directory) {
  const hash = createHash("sha256");

  async function visit(current, relative) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name === right.name ? 0 : left.name < right.name ? -1 : 1);
    for (const entry of entries) {
      const entryRelative = path.join(relative, entry.name);
      const normalized = entryRelative.split(path.sep).join("/");
      if (entry.isDirectory()) {
        hash.update(`directory:${normalized}\0`);
        await visit(path.join(current, entry.name), entryRelative);
      } else if (entry.isFile()) {
        hash.update(`file:${normalized}\0`);
        hash.update(await readFile(path.join(current, entry.name)));
        hash.update("\0");
      } else {
        throw new Error(`Неподдерживаемый элемент в шаблоне демо: ${entryRelative}`);
      }
    }
  }

  await visit(directory, "");
  return hash.digest("hex");
}

async function readBundledDemoVersion() {
  try {
    const raw = (await readFile(BUNDLED_DEMO_VERSION_PATH, "utf8")).trim();
    if (raw.startsWith("{")) {
      const parsed = JSON.parse(raw);
      return {
        fingerprint: typeof parsed.fingerprint === "string" ? parsed.fingerprint : undefined,
        mode: REPOSITORY_MODES.includes(parsed.mode) ? parsed.mode : undefined,
      };
    }
    // Backwards compatibility with the old plain-fingerprint marker.
    return { fingerprint: raw || undefined, mode: undefined };
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function initializeBundledDemoRepository(templateVersion, mode) {
  await rm(BUNDLED_DEMO_REPOSITORY, { recursive: true, force: true });
  await rm(BUNDLED_DEMO_DATA_DIRECTORY, { recursive: true, force: true });
  await mkdir(path.dirname(BUNDLED_DEMO_REPOSITORY), { recursive: true });
  await cp(BUNDLED_DEMO_TEMPLATE, BUNDLED_DEMO_REPOSITORY, { recursive: true });
  const commands = [
    ["init", "-b", "main"],
    ["add", "."],
    ["-c", "user.name=GitPM Демо", "-c", "user.email=demo@localhost", "commit", "-m", "Создать русскоязычный демонстрационный портфель"],
  ];
  for (const args of commands) await execFileAsync("git", args, { cwd: BUNDLED_DEMO_REPOSITORY, windowsHide: true });
  await writeFile(BUNDLED_DEMO_VERSION_PATH, `${JSON.stringify({ fingerprint: templateVersion, mode })}\n`, "utf8");
  console.log(`[GitPM] Создан рабочий демо-репозиторий: ${BUNDLED_DEMO_REPOSITORY}`);
}

export function inferGitLabRemote(remoteUrl) {
  const safeRemote = credentialFreeHttpsRemote(remoteUrl);
  if (safeRemote === undefined) return undefined;
  try {
    const url = new URL(safeRemote);
    const project = url.pathname.replace(/^\//u, "").replace(/\.git$/u, "");
    if (!project || !url.hostname.toLowerCase().includes("gitlab")) return undefined;
    return { baseUrl: url.origin, project };
  } catch {
    return undefined;
  }
}

export function credentialFreeHttpsRemote(remoteUrl) {
  if (typeof remoteUrl !== "string") return undefined;
  try {
    const url = new URL(remoteUrl);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || url.pathname === "/") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export function localServerLogLevel(environment = process.env) {
  const configured = environment.LOG_LEVEL?.trim();
  return configured || "error";
}

const REPOSITORY_MODES = ["direct", "worktree"];
export function resolveRepositoryMode(configValue, envValue) {
  const env = typeof envValue === "string" ? envValue.trim() : "";
  if (env !== "") {
    if (!REPOSITORY_MODES.includes(env)) {
      throw new Error(`Unknown repository mode "${env}". Expected one of: ${REPOSITORY_MODES.join(", ")}.`);
    }
    return env;
  }
  if (configValue === undefined || configValue === null) return "direct";
  if (!REPOSITORY_MODES.includes(configValue)) {
    throw new Error(`Unknown repository mode "${String(configValue)}". Expected one of: ${REPOSITORY_MODES.join(", ")}.`);
  }
  return configValue;
}

export async function prepareGitPmRuntime() {
  const configuration = await readConfiguration();
  const repositoryMode = resolveRepositoryMode(configuration.repositoryMode, process.env.GITPM_REPOSITORY_MODE);
  const defaultBranch = (typeof configuration.defaultBranch === "string" && configuration.defaultBranch.trim() !== ""
    ? configuration.defaultBranch.trim()
    : process.env.GITPM_DEFAULT_BRANCH?.trim() || "main");
  const requestedPath = process.env.GITPM_REPOSITORY_PATH ?? configuration.repository;
  const configuredPath = typeof requestedPath === "string" && requestedPath.trim() !== ""
    ? requestedPath
    : BUNDLED_DEMO_REPOSITORY;
  const usesBundledDemo = path.resolve(configuredPath) === BUNDLED_DEMO_REPOSITORY;
  let repository = await validRepository(configuredPath);
  if (usesBundledDemo) {
    const templateVersion = await directoryFingerprint(BUNDLED_DEMO_TEMPLATE);
    const installedVersion = await readBundledDemoVersion();
    const stale = installedVersion === undefined
      || installedVersion.fingerprint !== templateVersion
      || installedVersion.mode !== repositoryMode;
    if (stale) {
      if (installedVersion === undefined) {
        console.log("[GitPM] Подготавливаю актуальную версию встроенного демо...");
      } else if (installedVersion.mode !== repositoryMode) {
        console.log(`[GitPM] Режим репозитория изменился (${installedVersion.mode ?? "unknown"} → ${repositoryMode}) — пересоздаю демо-runtime...`);
      } else {
        console.log("[GitPM] Шаблон встроенного демо изменился — обновляю рабочую копию...");
      }
      await initializeBundledDemoRepository(templateVersion, repositoryMode);
    }
    repository = await validRepository(BUNDLED_DEMO_REPOSITORY);
  }
  if (repository === undefined) {
    const reason = `Указанная папка не является корнем непустого Git-репозитория: ${configuredPath}`;
    throw new Error(`${reason}\n[GitPM] Укажите путь в ${CONFIG_PATH}\n[GitPM] Пример: { "repository": "D:\\\\projects\\\\portfolio-data" }`);
  }

  const discoveredRemote = await git(repository, "remote", "get-url", "origin").catch(() => undefined);
  const remoteUrl = credentialFreeHttpsRemote(discoveredRemote);
  const inferredGitLab = inferGitLabRemote(remoteUrl);
  const nextConfiguration = {
    ...configuration,
    repository,
    repositoryMode,
    defaultBranch,
    ...(inferredGitLab === undefined ? {} : { gitlab: { ...inferredGitLab, ...(configuration.gitlab ?? {}) } }),
  };
  await saveConfiguration(nextConfiguration);
  const gitlab = nextConfiguration.gitlab;
  const environment = {
    GITPM_REPOSITORY_PATH: repository,
    GITPM_REPOSITORY_MODE: repositoryMode,
    GITPM_DEFAULT_BRANCH: defaultBranch,
    ...(usesBundledDemo ? { GITPM_DATA_DIR: BUNDLED_DEMO_DATA_DIRECTORY } : {}),
    LOG_LEVEL: localServerLogLevel(),
    ...(remoteUrl === undefined ? {} : { GITPM_PUSH_REMOTE_URL: remoteUrl }),
    ...(gitlab?.baseUrl ? { GITPM_GITLAB_URL: String(gitlab.baseUrl) } : {}),
    ...(gitlab?.project ? { GITPM_GITLAB_PROJECT: String(gitlab.project) } : {}),
    ...(gitlab?.clientId ? { GITPM_GITLAB_CLIENT_ID: String(gitlab.clientId) } : {}),
  };
  return { configuration: nextConfiguration, environment, remoteUrl, repositoryMode, defaultBranch };
}
