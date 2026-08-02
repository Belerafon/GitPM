import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWriteDomainFile, resolveDomainPath } from "@gitpm/security";

interface NotificationReadState {
  readonly version: 1;
  readonly person_id: string;
  readonly read_keys: readonly string[];
}

export interface NotificationReadStore {
  read(personId: string): Promise<ReadonlySet<string>>;
  markRead(personId: string, keys: readonly string[]): Promise<ReadonlySet<string>>;
}

class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    let release = (): void => undefined;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const previous = this.tail;
    this.tail = previous.then(() => current);
    await previous;
    try { return await operation(); }
    finally { release(); }
  }
}

export class MemoryNotificationReadStore implements NotificationReadStore {
  private readonly states = new Map<string, Set<string>>();

  async read(personId: string): Promise<ReadonlySet<string>> {
    return new Set(this.states.get(personId) ?? []);
  }

  async markRead(personId: string, keys: readonly string[]): Promise<ReadonlySet<string>> {
    const next = new Set(this.states.get(personId) ?? []);
    for (const key of keys) next.add(key);
    this.states.set(personId, next);
    return new Set(next);
  }
}

export class FileNotificationReadStore implements NotificationReadStore {
  private readonly root: string;
  private readonly repositoryNamespace: string;
  private readonly locks = new Map<string, AsyncMutex>();

  constructor(dataDirectory: string, repositoryIdentity: string) {
    this.root = path.resolve(dataDirectory);
    this.repositoryNamespace = createHash("sha256").update(repositoryIdentity).digest("hex").slice(0, 32);
  }

  private lock(personId: string): AsyncMutex {
    let lock = this.locks.get(personId);
    if (lock === undefined) {
      lock = new AsyncMutex();
      this.locks.set(personId, lock);
    }
    return lock;
  }

  private relativePath(personId: string): string {
    if (!/^U-[0-9]{2}-[0-9A-HJKMNP-TV-Z]{6}$/u.test(personId)) throw new Error("notification read-state person identity is invalid");
    return `notifications/read/${this.repositoryNamespace}/${personId}.json`;
  }

  private async prepareDirectory(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const notifications = await resolveDomainPath(this.root, "notifications");
    await mkdir(notifications, { recursive: true, mode: 0o700 });
    const read = await resolveDomainPath(this.root, "notifications/read");
    await mkdir(read, { recursive: true, mode: 0o700 });
    const repository = await resolveDomainPath(this.root, `notifications/read/${this.repositoryNamespace}`);
    await mkdir(repository, { recursive: true, mode: 0o700 });
    await resolveDomainPath(this.root, `notifications/read/${this.repositoryNamespace}`);
  }

  private async readUnlocked(personId: string): Promise<Set<string>> {
    await this.prepareDirectory();
    const relative = this.relativePath(personId);
    const absolute = await resolveDomainPath(this.root, relative);
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(absolute, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
      throw error;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("notification read-state document is invalid");
    const state = parsed as Partial<NotificationReadState>;
    if (state.version !== 1 || state.person_id !== personId || !Array.isArray(state.read_keys) || state.read_keys.some((key) => typeof key !== "string")) {
      throw new Error("notification read-state document is invalid");
    }
    return new Set(state.read_keys);
  }

  async read(personId: string): Promise<ReadonlySet<string>> {
    return await this.lock(personId).run(async () => await this.readUnlocked(personId));
  }

  async markRead(personId: string, keys: readonly string[]): Promise<ReadonlySet<string>> {
    return await this.lock(personId).run(async () => {
      const next = await this.readUnlocked(personId);
      for (const key of keys) next.add(key);
      const state: NotificationReadState = { version: 1, person_id: personId, read_keys: [...next].sort() };
      await atomicWriteDomainFile(this.root, this.relativePath(personId), `${JSON.stringify(state, null, 2)}\n`);
      return new Set(next);
    });
  }
}
