// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import type { GitPmApi } from "./api.js";
import { POLL_INTERVAL_MS } from "./draft-context.js";
import { assertLocalePacks, formatDateOnly, formatDurationHours, formatNumber, localeRegistry, LOCALE_STORAGE_KEY, message, pluralCategory, registerLocale, selectLocale } from "./i18n.js";
import type { ChangesList, CommitHistoryDetail, CommitResult, DraftSnapshot, DraftStatus, EntityResult, GitPmDocument, MergeRequestStatus, PublicSession, PushResult, RevertDraftResult, SemanticDiff, WriterMode } from "./types.js";

const session: PublicSession = {
  user: { id: "42", username: "developer" },
  role: "Maintainer",
  expires_at: "2026-07-10T18:00:00.000Z",
};

function draft(overrides: Partial<DraftStatus> = {}): DraftStatus {
  return {
    draft_id: "DRF-WEB",
    owner_gitlab_user_id: "42",
    branch: "gitpm/42/DRF-WEB",
    base_commit: "a".repeat(40),
    writer_mode: "ui",
    state: "open",
    fingerprint: "b".repeat(64),
    created_at: "2026-07-10T10:00:00.000Z",
    updated_at: "2026-07-10T10:00:00.000Z",
    ...overrides,
  };
}

class FakeApi implements GitPmApi {
  currentSession: PublicSession | null = session;
  drafts: DraftStatus[] = [];
  entities: EntityResult[] = [];
  snapshotCalls = 0;
  payloads: unknown[] = [];
  async session() { return this.currentSession; }
  async login() { return "https://gitlab.example.test/oauth/authorize"; }
  async logout() { this.currentSession = null; }
  async listDrafts() { return this.drafts; }
  async createDraft(draftId: string) { const created = draft({ draft_id: draftId, branch: `gitpm/42/${draftId}` }); this.payloads.push({ draft_id: draftId }); this.drafts = [...this.drafts, created]; return created; }
  async snapshot(draftId: string): Promise<DraftSnapshot> {
    this.snapshotCalls += 1;
    const current = this.drafts.find((item) => item.draft_id === draftId) ?? draft({ draft_id: draftId });
    return { draft: current, changes: { changed_files_count: 2 }, validation: { valid: true, error_count: 0, warning_count: 1, document_count: 14 } };
  }
  async setWriterMode(draftId: string, mode: WriterMode) { return this.replace(draftId, { writer_mode: mode }); }
  async closeDraft(draftId: string) { return this.replace(draftId, { state: "closed" }); }
  async reopenDraft(draftId: string) { return this.replace(draftId, { state: "open" }); }
  async cleanupDraft(draftId: string) { this.drafts = this.drafts.filter((item) => item.draft_id !== draftId); }
  async listEntities(_draftId: string, type: string, project?: string) {
    const schemas: Record<string, string> = { projects: "gitpm/project@1", milestones: "gitpm/milestone@1", tasks: "gitpm/task@1" };
    return this.entities.filter((item) => item.document.schema === schemas[type] && (project === undefined || item.document.project === project));
  }
  async projectWorkspace(draftId: string, projectId: string) {
    const project = (await this.listEntities(draftId, "projects")).find((item) => item.document.id === projectId);
    if (project === undefined) throw new Error("project not found");
    return { project, milestones: await this.listEntities(draftId, "milestones", projectId), tasks: await this.listEntities(draftId, "tasks", projectId), draft_fingerprint: project.draft_fingerprint };
  }
  async createEntity(): Promise<EntityResult> { throw new Error("not used"); }
  async updateEntity(): Promise<EntityResult> { throw new Error("not used"); }
  async moveTask(): Promise<EntityResult> { throw new Error("not used"); }
  async archiveEntity(): Promise<EntityResult> { throw new Error("not used"); }
  async deleteEntity() { /* not used */ }
  async getConfiguration(_draftId: string, kind: "statuses" | "issue-types"): Promise<EntityResult> {
    const document = (kind === "statuses"
      ? { schema: "gitpm/statuses@1", id: "CONFIG-STATUSES", lifecycle: "active", statuses: [{ slug: "backlog", title: "Backlog", active: true }] }
      : { schema: "gitpm/issue-types@1", id: "CONFIG-TYPES", lifecycle: "active", issue_types: [{ slug: "task", title: "Task", active: true }] }) as GitPmDocument;
    return { document, path: kind, blob_id: "a".repeat(40), draft_fingerprint: "b".repeat(64) };
  }
  async updateConfiguration(): Promise<EntityResult> { throw new Error("not used"); }
  async listChanges(): Promise<ChangesList> { throw new Error("not used"); }
  async semanticChanges(): Promise<SemanticDiff> { throw new Error("not used"); }
  async restoreFile() { throw new Error("not used"); }
  async restoreHunk() { throw new Error("not used"); }
  async discardAll() { throw new Error("not used"); }
  async commitAll(): Promise<CommitResult> { throw new Error("not used"); }
  async push(): Promise<PushResult> { throw new Error("not used"); }
  async createMergeRequest(): Promise<MergeRequestStatus> { throw new Error("not used"); }
  async pollMergeRequest(): Promise<MergeRequestStatus> { throw new Error("not used"); }
  async history() { return []; }
  async commitDetail(): Promise<CommitHistoryDetail> { throw new Error("not used"); }
  async fileHistory() { return []; }
  async createRevertDraft(): Promise<RevertDraftResult> { throw new Error("not used"); }
  private replace(draftId: string, values: Partial<DraftStatus>) { const next = { ...(this.drafts.find((item) => item.draft_id === draftId) ?? draft({ draft_id: draftId })), ...values }; this.drafts = [next]; return next; }
}

beforeEach(() => { window.history.replaceState({}, "", "/"); });
afterEach(() => { cleanup(); vi.useRealTimers(); localStorage.clear(); });

describe("localization runtime", () => {
  it("keeps en and mandatory ru packs complete and placeholder-compatible", () => {
    expect(() => assertLocalePacks()).not.toThrow();
    expect(Object.keys(localeRegistry.ru.messages)).toEqual(Object.keys(localeRegistry.en.messages));
    expect(message("ru", "drafts.validationInvalid", { count: 3 })).toBe("Ошибок: 3");
  });

  it("selects stored locale first and otherwise the first supported browser locale", () => {
    expect(selectLocale("en", ["ru-RU"], "ru")).toBe("en");
    expect(selectLocale(null, ["de-DE", "ru-RU"], "en")).toBe("ru");
    expect(selectLocale(null, ["de-DE"], "ru")).toBe("ru");
  });

  it("uses Russian date, number, duration and plural rules", () => {
    expect(formatDateOnly("ru", "2026-07-13")).toMatch(/13.*июл.*2026/iu);
    expect(formatNumber("ru", 1234.5)).toMatch(/1[\s\u00a0\u202f]234,5/u);
    expect(formatDurationHours("ru", 2)).toMatch(/2 часа/iu);
    expect([1, 2, 5].map((value) => pluralCategory("ru", value))).toEqual(["one", "few", "many"]);
  });

  it("enables a synthetic locale by registering pack metadata only", async () => {
    const synthetic = Object.fromEntries(Object.entries(localeRegistry.en.messages).map(([key, value]) => [key, `T ${value}`])) as typeof localeRegistry.en.messages;
    const unregister = registerLocale("tt", { languageTag: "tt", direction: "ltr", labelKey: "locale.en", messages: synthetic });
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, "tt");
      render(<App api={new FakeApi()} />);
      expect(await screen.findByRole("heading", { name: "T Working copies" })).toBeTruthy();
      expect(document.documentElement.lang).toBe("tt");
    } finally {
      cleanup();
      unregister();
    }
  });
});

describe("frontend draft lifecycle", () => {
  it("restores a project milestone deep link with project tabs and task navigation", async () => {
    const api = new FakeApi();
    api.currentSession = { ...session, mode: "repository", repository: { name: "portfolio", path: "D:\\portfolio", has_remote: false }, gitlab: { configured: false } };
    api.drafts = [draft({ draft_id: "DRF-LOCAL" })];
    api.entities = [
      { document: { schema: "gitpm/project@1", id: "P-26-7K4M9Q", name: "Alpha", status: "backlog", lifecycle: "active" }, path: "project.yaml", blob_id: "a".repeat(40), draft_fingerprint: "b".repeat(64) },
      { document: { schema: "gitpm/milestone@1", id: "M-26-3RC7NA", project: "P-26-7K4M9Q", name: "Launch", lifecycle: "active", due: "2026-08-01" }, path: "milestone.yaml", blob_id: "c".repeat(40), draft_fingerprint: "b".repeat(64) },
      { document: { schema: "gitpm/task@1", id: "T-26-X8D2FW", project: "P-26-7K4M9Q", milestone: "M-26-3RC7NA", title: "First task", type: "task", status: "backlog", lifecycle: "active" }, path: "task.yaml", blob_id: "d".repeat(40), draft_fingerprint: "b".repeat(64) },
    ];
    window.history.replaceState({}, "", "/projects/P-26-7K4M9Q/stages/M-26-3RC7NA");
    render(<App api={api} browserLanguages={["en"]} />);

    expect(await screen.findByRole("heading", { level: 1, name: "Plan" })).toBeTruthy();
    expect(await screen.findByRole("heading", { level: 2, name: "Launch" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Project navigation" })).toBeTruthy();
    const breadcrumbs = screen.getByRole("navigation", { name: "Breadcrumbs" });
    expect((await within(breadcrumbs).findByText("Alpha")).getAttribute("aria-current")).toBe("page");
    fireEvent.click(screen.getByRole("button", { name: /First task/u }));
    expect(`${window.location.pathname}${window.location.search}`).toBe("/projects/P-26-7K4M9Q/tasks/T-26-X8D2FW");
    expect((await screen.findByRole("button", { name: /First task/u })).getAttribute("aria-current")).toBe("true");
  });

  it("opens the responsive navigation by keyboard, closes it with Escape, and restores scroll and focus after navigation", async () => {
    const api = new FakeApi();
    render(<App api={api} browserLanguages={["en"]} />);
    await screen.findByRole("heading", { name: "Working copies" });
    expect(screen.queryByText("Work")).toBeNull();
    expect(screen.queryByText("Git")).toBeNull();
    expect(screen.getAllByRole("button", { name: /Projects|Team|Repository|Statuses/u })).toHaveLength(4);
    expect(screen.getByRole("button", { name: "Team" })).toBeTruthy();
    const menuButton = screen.getByRole("button", { name: "Open navigation" });

    fireEvent.click(menuButton);
    expect(menuButton.getAttribute("aria-expanded")).toBe("true");
    expect(document.body.style.overflow).toBe("hidden");
    expect(screen.getAllByRole("button", { name: "Close navigation" }).some((button) => button.classList.contains("navigation-close"))).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Repository" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(menuButton.getAttribute("aria-expanded")).toBe("false");
    expect(document.body.style.overflow).toBe("");
    expect(document.activeElement).toBe(menuButton);

    document.documentElement.scrollTop = 500;
    fireEvent.click(menuButton);
    fireEvent.click(screen.getByRole("button", { name: "Projects" }));
    await screen.findByRole("heading", { level: 1, name: "Projects" });
    expect(document.documentElement.scrollTop).toBe(0);
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1, name: "Projects" }));
    expect(menuButton.getAttribute("aria-expanded")).toBe("false");
  });

  it("starts loading on navigation and never renders unknown totals as zero", async () => {
    let releaseProjects!: () => void;
    const projectsGate = new Promise<void>((resolve) => { releaseProjects = resolve; });
    class DelayedApi extends FakeApi {
      projectRequests = 0;
      override async listEntities(draftId: string, type: string, project?: string) {
        if (type === "projects") { this.projectRequests += 1; await projectsGate; }
        return await super.listEntities(draftId, type, project);
      }
    }
    const api = new DelayedApi();
    api.drafts = [draft()];
    api.entities = [{
      document: { schema: "gitpm/project@1", id: "P-26-7K4M9Q", name: "Alpha", status: "backlog", lifecycle: "active" },
      path: "projects/P-26-7K4M9Q/project.yaml", blob_id: "a".repeat(40), draft_fingerprint: "b".repeat(64),
    }];
    render(<App api={api} browserLanguages={["en"]} />);

    await screen.findByRole("heading", { name: "Working copies" });
    fireEvent.click(screen.getByRole("button", { name: "Projects" }));

    expect(api.projectRequests).toBe(1);
    expect(screen.getByRole("status").textContent).toContain("Loading");
    expect(screen.queryByText("Active projects")).toBeNull();

    releaseProjects();
    const projectsStat = await screen.findByText("Active projects");
    expect(within(projectsStat.parentElement!).getByText("1")).toBeTruthy();
  });

  it("keeps Tasks inside the selected project workspace", async () => {
    const api = new FakeApi();
    api.currentSession = {
      ...session,
      user: { id: "local-user", username: "local" },
      mode: "repository",
      repository: { name: "portfolio", path: "D:\\portfolio", has_remote: false },
      gitlab: { configured: false },
    };
    api.drafts = [draft({ draft_id: "DRF-LOCAL", owner_gitlab_user_id: "local-user" })];
    api.entities = [
      {
        document: { schema: "gitpm/project@1", id: "P-26-7K4M9Q", name: "Alpha", status: "backlog", lifecycle: "active" },
        path: "projects/P-26-7K4M9Q/project.yaml", blob_id: "a".repeat(40), draft_fingerprint: "b".repeat(64),
      },
      {
        document: { schema: "gitpm/milestone@1", id: "M-26-3RC7NA", project: "P-26-7K4M9Q", name: "Launch", lifecycle: "active" },
        path: "projects/P-26-7K4M9Q/milestones/M-26-3RC7NA.yaml", blob_id: "c".repeat(40), draft_fingerprint: "b".repeat(64),
      },
      {
        document: { schema: "gitpm/task@1", id: "T-26-X8D2FW", project: "P-26-7K4M9Q", title: "First task", type: "task", status: "backlog", lifecycle: "active" },
        path: "projects/P-26-7K4M9Q/tasks/T-26-X8D2FW.yaml", blob_id: "d".repeat(40), draft_fingerprint: "b".repeat(64),
      },
    ];
    render(<App api={api} browserLanguages={["en"]} />);

    expect(await screen.findByRole("heading", { name: "Projects" })).toBeTruthy();
    expect(`${window.location.pathname}${window.location.search}`).toBe("/projects");
    expect(await screen.findByRole("button", { name: /New project/u })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create task" })).toBeNull();

    const projectsStat = await screen.findByText("Active projects");
    expect(within(projectsStat.parentElement!).getByText("1")).toBeTruthy();
    expect(await screen.findByText("Alpha")).toBeTruthy();
    expect(screen.getByText("P-26-7K4M9Q")).toBeTruthy();
    expect(screen.getByRole("button", { name: /New project/u })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create task" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Alpha/u }));
    expect(await screen.findByRole("heading", { name: "Plan" })).toBeTruthy();
    expect(`${window.location.pathname}${window.location.search}`).toBe("/projects/P-26-7K4M9Q");
    let breadcrumbs = screen.getByRole("navigation", { name: "Breadcrumbs" });
    expect(within(breadcrumbs).getByRole("button", { name: "Projects" })).toBeTruthy();
    expect((await within(breadcrumbs).findByText("Alpha")).getAttribute("aria-current")).toBe("page");
    expect(document.querySelector(".project-plan-header")).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Work plan" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect((await screen.findAllByRole("button", { name: /New task/u })).length).toBeGreaterThan(0);
    expect(await screen.findByText("First task")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /New project/u })).toBeNull();

    fireEvent.change(screen.getByLabelText("Filter tasks"), { target: { value: "backlog" } });
    expect(`${window.location.pathname}${window.location.search}`).toBe("/projects/P-26-7K4M9Q?status=backlog");
    fireEvent.click(await screen.findByRole("button", { name: /First task/u }));
    expect(`${window.location.pathname}${window.location.search}`).toBe("/projects/P-26-7K4M9Q/tasks/T-26-X8D2FW?status=backlog");
    expect(await screen.findByRole("heading", { level: 1, name: "Plan" })).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "Task details" })).toBeTruthy();
    expect(screen.getByLabelText("Milestone")).toHaveProperty("value", "");
    expect(screen.getByRole("button", { name: /First task/u }).getAttribute("aria-current")).toBe("true");
    breadcrumbs = screen.getByRole("navigation", { name: "Breadcrumbs" });
    expect(within(breadcrumbs).getByText("Alpha").getAttribute("aria-current")).toBe("page");
  });

  it("labels a repository session and does not offer a meaningless sign-out action", async () => {
    const api = new FakeApi();
    api.currentSession = {
      ...session,
      user: { id: "local-user", username: "local" },
      mode: "repository",
      repository: { name: "portfolio", path: "D:\\portfolio", has_remote: false },
      gitlab: { configured: false },
    };
    api.drafts = [draft({ draft_id: "DRF-LOCAL", owner_gitlab_user_id: "local-user" })];
    render(<App api={api} browserLanguages={["en"]} />);
    expect(await screen.findByText("Local mode · Role: Maintainer")).toBeTruthy();
    expect(screen.getByText("Repository details")).toBeTruthy();
    expect(screen.getByText("D:\\portfolio")).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Projects" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Repository" })).toBeTruthy();
    expect((screen.getByRole("combobox", { name: "Current working copy" }) as HTMLSelectElement).value).toBe("DRF-LOCAL");
    expect(screen.getByRole("button", { name: "Projects" }).className).toContain("active");
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign in with GitLab" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Repository" }));
    expect(await screen.findByRole("heading", { name: "Working copies" })).toBeTruthy();
    expect(screen.getAllByText("Main local copy").length).toBeGreaterThan(0);
    expect(screen.getAllByText("DRF-LOCAL").length).toBeGreaterThan(0);
  });

  it("persists locale and changes lang/dir without changing API payloads", async () => {
    const api = new FakeApi();
    localStorage.setItem(LOCALE_STORAGE_KEY, "ru");
    render(<App api={api} />);
    expect(await screen.findByRole("heading", { name: "Рабочие копии" })).toBeTruthy();
    expect(document.documentElement.lang).toBe("ru");
    fireEvent.change(screen.getByLabelText("Язык"), { target: { value: "en" } });
    expect(await screen.findByRole("heading", { name: "Working copies" })).toBeTruthy();
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("en");
    expect(document.documentElement).toMatchObject({ lang: "en", dir: "ltr" });
    expect(api.payloads).toEqual([]);
  });

  it("creates, polls, switches writer mode, closes, reopens and removes a working copy", async () => {
    const api = new FakeApi();
    render(<App api={api} browserLanguages={["en"]} confirmAction={() => true} />);
    await screen.findAllByText("No working copies yet.");
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    expect((screen.getByLabelText("Working copy ID") as HTMLInputElement).value).toMatch(/^DRF-\d{8}-[A-Z0-9]{4}$/u);
    fireEvent.change(screen.getByLabelText("Working copy ID"), { target: { value: "DRF-WEB" } });
    fireEvent.click(screen.getByRole("button", { name: "Create working copy" }));
    expect((await screen.findAllByText("gitpm/42/DRF-WEB")).length).toBeGreaterThan(0);
    expect(screen.getByText("Changed files").nextElementSibling?.textContent).toBe("2");
    expect(screen.getByText("Valid")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Switch to external writer" }));
    expect(await screen.findByText("External writer mode is active. Editing actions are read-only.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close for editing" }));
    expect(await screen.findByRole("button", { name: "Reopen" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    expect(await screen.findByRole("button", { name: "Close for editing" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close for editing" }));
    await screen.findByRole("button", { name: "Remove working copy" });
    fireEvent.click(screen.getByRole("button", { name: "Remove working copy" }));
    expect((await screen.findAllByText("No working copies yet.")).length).toBeGreaterThan(0);
  });

  it("refreshes an active draft every three seconds", async () => {
    vi.useFakeTimers();
    const api = new FakeApi();
    api.drafts = [draft()];
    render(<App api={api} browserLanguages={["en"]} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(api.snapshotCalls).toBeGreaterThanOrEqual(1);
    const before = api.snapshotCalls;
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); });
    expect(api.snapshotCalls).toBeGreaterThan(before);
  });
});
