import { spawnSync } from "node:child_process";

const isWindows = process.platform === "win32";
let valid = true;

function fail(message, hint) {
  console.error(`      ОШИБКА: ${message}`);
  if (hint) console.error(`      ${hint}`);
  valid = false;
}

function run(command, args) {
  return spawnSync(command, args, {
    encoding: "utf8",
    shell: isWindows,
    windowsHide: true,
  });
}

const [major = 0, minor = 0, patch = 0] = process.versions.node.split(".").map(Number);
if (major !== 20 || minor < 19 || (minor === 19 && patch < 2)) {
  fail(
    `установлена неподдерживаемая версия Node.js v${process.versions.node}.`,
    "Требуется Node.js от 20.19.2 до 20.x включительно: https://nodejs.org/",
  );
} else {
  console.log(`      Node.js v${process.versions.node} найден.`);
}

const corepack = run("corepack", ["--version"]);
if (corepack.status !== 0) {
  fail(
    "Corepack не найден или не запускается.",
    "Переустановите Node.js 20.19.2 с Corepack или выполните: npm install -g corepack",
  );
} else {
  console.log(`      Corepack ${corepack.stdout.trim()} найден.`);

  const pnpm = run("corepack", ["pnpm", "--version"]);
  const pnpmVersion = pnpm.stdout.trim();
  if (pnpm.status !== 0) {
    fail(
      "pnpm недоступен через Corepack.",
      "Выполните: corepack prepare pnpm@10.12.1 --activate",
    );
  } else if (pnpmVersion !== "10.12.1") {
    fail(
      `Corepack запустил pnpm ${pnpmVersion}, а требуется 10.12.1.`,
      "Выполните: corepack prepare pnpm@10.12.1 --activate",
    );
  } else {
    console.log(`      pnpm ${pnpmVersion} найден.`);
  }
}

const git = run("git", ["--version"]);
if (git.status !== 0) {
  fail("Git не найден.", "Установите Git for Windows: https://git-scm.com/download/win");
} else {
  console.log(`      ${git.stdout.trim()} найден.`);
}

process.exitCode = valid ? 0 : 1;
