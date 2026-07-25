import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DraftManager } from "@gitpm/drafts";
import type { GitClient } from "@gitpm/git-client";
import { ExportService } from "./index.js";
import { createZip } from "./zip.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe("ZIP writer", () => {
  it("creates a UTF-8 archive consumable by the platform extractor", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gitpm-zip-test-"));
    roots.push(root);
    const archive = path.join(root, "export.zip");
    const destination = path.join(root, "out");
    await writeFile(archive, createZip([
      { name: "данные", directory: true },
      { name: "данные/people.csv", content: Buffer.from("\uFEFFname\r\nАда\r\n", "utf8") },
    ]));
    await mkdir(destination);
    const { execFile } = await import("node:child_process");
    await new Promise<void>((resolve, reject) => execFile(
      process.platform === "win32" ? "powershell" : "unzip",
      process.platform === "win32"
        ? ["-NoProfile", "-Command", "& { param($archive,$destination) Expand-Archive -LiteralPath $archive -DestinationPath $destination }", archive, destination]
        : ["-q", archive, "-d", destination],
      (error) => error ? reject(error) : resolve(),
    ));
    expect(await readFile(path.join(destination, "данные", "people.csv"), "utf8")).toContain("Ада");
  });
});

describe("ExportService", () => {
  const fixture = path.resolve("fixtures/schema-v1/demo");
  const manager = {
    getWorkspace: async () => ({ worktree_path: fixture }),
  } as unknown as DraftManager;
  const git = {
    history: async () => [{
      commit: "deadbeef".padEnd(40, "0"),
      parents: [],
      author_name: "Ada",
      author_email: "ada@example.test",
      authored_at: "2026-07-25T12:00:00.000Z",
      subject: "demo",
    }],
  } as unknown as GitClient;
  const service = new ExportService(manager, git, () => new Date("2026-07-26T10:00:00.000Z"));

  it("renders a safe standalone HTML site with all read-only views", async () => {
    const artifact = await service.create("DRF-1", { format: "html", locale: "ru" });
    const html = artifact.content.toString("utf8");

    expect(artifact.filename).toBe("gitpm-20260725-deadbeef-static.html");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Портфель GitPM");
    expect(html).toContain('class="board"');
    expect(html).toContain('class="gantt"');
    expect(html).not.toContain("<button");
  });

  it("renders PDF defaults and optional project pages with Cyrillic-capable fonts", async () => {
    const artifact = await service.create("DRF-1", {
      format: "pdf",
      locale: "ru",
      sections: ["projects", "people", "project-details", "gantt"],
    });

    expect(artifact.filename).toBe("gitpm-20260725-deadbeef-portfolio.pdf");
    expect(artifact.content.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(artifact.content.length).toBeGreaterThan(5_000);
  });

  it("exports every repository schema into UTF-8 CSV files", async () => {
    const artifact = await service.create("DRF-1", { format: "csv", locale: "en" });

    expect(artifact.filename).toBe("gitpm-20260725-deadbeef-csv.zip");
    expect(artifact.content.readUInt32LE(0)).toBe(0x04034b50);
    expect(artifact.content.toString("utf8")).toContain("projects.csv");
    expect(artifact.content.toString("utf8")).toContain("saved-views.csv");
  });

  it("archives the repository without .git by default", async () => {
    const artifact = await service.create("DRF-1", { format: "repository", locale: "en" });
    const raw = artifact.content.toString("utf8");

    expect(artifact.filename).toBe("gitpm-20260725-deadbeef-repository.zip");
    expect(raw).toContain(".gitpm/repository.yaml");
    expect(raw).not.toContain(".git/config");
  });

  it("creates portable Git history without retaining a local origin URL", async () => {
    const repository = await mkdtemp(path.join(os.tmpdir(), "gitpm-export-repository-"));
    const destination = await mkdtemp(path.join(os.tmpdir(), "gitpm-export-unpack-"));
    roots.push(repository, destination);
    await cp(fixture, repository, { recursive: true });
    const { execFile } = await import("node:child_process");
    const execute = async (file: string, args: readonly string[]) => await new Promise<void>((resolve, reject) => execFile(file, [...args], { windowsHide: true }, (error) => error ? reject(error) : resolve()));
    await execute("git", ["init", "-b", "main", repository]);
    await execute("git", ["-C", repository, "add", "."]);
    await execute("git", ["-C", repository, "-c", "user.name=Export Test", "-c", "user.email=export@example.test", "commit", "-m", "fixture"]);
    const repositoryManager = { getWorkspace: async () => ({ worktree_path: repository }) } as unknown as DraftManager;
    const repositoryService = new ExportService(repositoryManager, git, () => new Date("2026-07-26T10:00:00.000Z"));
    const artifact = await repositoryService.create("DRF-1", { format: "repository", include_git: true });
    const archive = path.join(destination, "repository.zip");
    const unpacked = path.join(destination, "out");
    await writeFile(archive, artifact.content);
    await mkdir(unpacked);
    await execute(
      process.platform === "win32" ? "powershell" : "unzip",
      process.platform === "win32"
        ? ["-NoProfile", "-Command", "& { param($archive,$destination) Expand-Archive -LiteralPath $archive -DestinationPath $destination }", archive, unpacked]
        : ["-q", archive, "-d", unpacked],
    );

    expect(await readFile(path.join(unpacked, ".git", "HEAD"), "utf8")).toContain("refs/heads/");
    expect(await readFile(path.join(unpacked, ".git", "config"), "utf8")).not.toContain("url =");
    await expect(readFile(path.join(unpacked, ".git", "logs", "HEAD"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(unpacked, ".gitpm", "repository.yaml"), "utf8")).toContain("gitpm/repository@1");
  });
});
