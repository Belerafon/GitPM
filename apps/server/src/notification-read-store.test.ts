import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileNotificationReadStore } from "./notification-read-store.js";

const roots: string[] = [];

afterEach(async () => Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))));

describe("file notification read store", () => {
  it("persists exact per-person keys across store instances without touching a draft worktree", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gitpm-notification-reads-"));
    roots.push(root);
    const personId = "U-26-5EBAE3";
    const repository = "D:/portfolios/alpha";
    const repositoryNamespace = createHash("sha256").update(repository).digest("hex").slice(0, 32);
    const first = new FileNotificationReadStore(root, repository);

    await first.markRead(personId, ["N-26-ABC123:2026-07-20T10:05:00.000Z"]);
    await first.markRead(personId, ["N-26-ABC123:2026-07-20T10:05:00.000Z", "N-26-DEF456:2026-07-21T10:05:00.000Z"]);

    const restored = await new FileNotificationReadStore(root, repository).read(personId);
    expect([...restored].sort()).toEqual([
      "N-26-ABC123:2026-07-20T10:05:00.000Z",
      "N-26-DEF456:2026-07-21T10:05:00.000Z",
    ]);
    expect(JSON.parse(await readFile(path.join(root, "notifications", "read", repositoryNamespace, `${personId}.json`), "utf8"))).toMatchObject({
      version: 1,
      person_id: personId,
      read_keys: expect.any(Array),
    });
    expect(await new FileNotificationReadStore(root, "D:/portfolios/beta").read(personId)).toEqual(new Set());
  });
});
