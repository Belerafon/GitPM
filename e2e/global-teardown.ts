import { rm } from "node:fs/promises";
import path from "node:path";

export default async function globalTeardown(): Promise<void> {
  await Promise.all([
    rm(path.resolve(".tmp", "playwright-local"), { recursive: true, force: true }),
    rm(path.resolve(".tmp", "playwright-persistence"), { recursive: true, force: true }),
  ]);
}
