import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, formatApiError, HttpGitPmApi, listAllProjectTimeEntries, type TimeEntryResult } from "./api.js";
import { ApiContractError } from "@gitpm/contracts";
import type { EntityResult } from "./types.js";

describe("HttpGitPmApi request bodies", () => {
  afterEach(() => vi.unstubAllGlobals());

  const draftStatus = {
    draft_id: "DRF-1",
    owner_gitlab_user_id: "42",
    branch: "gitpm/42/DRF-1",
    base_commit: "a".repeat(40),
    writer_mode: "ui",
    state: "open",
    fingerprint: "b".repeat(64),
    created_at: "2026-07-23T00:00:00.000Z",
    updated_at: "2026-07-23T00:00:00.000Z",
  };

  it("does not declare JSON for a request without a body", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(draftStatus), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await new HttpGitPmApi().closeDraft("DRF-1");

    expect(fetchMock).toHaveBeenCalledWith("/api/drafts/DRF-1/close", expect.objectContaining({ method: "POST" }));
    const headers = new Headers(fetchMock.mock.calls[0]![1]?.headers);
    expect(headers.has("content-type")).toBe(false);
  });

  it("declares JSON when a request has a JSON body", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(draftStatus), {
      status: 201,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await new HttpGitPmApi().createDraft("DRF-1");

    expect(fetchMock).toHaveBeenCalledWith("/api/drafts", expect.objectContaining({ method: "POST" }));
    const headers = new Headers(fetchMock.mock.calls[0]![1]?.headers);
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("decodes the project time-entry envelope and serializes filters", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      total: 1,
      offset: 0,
      limit: 10,
      items: [{ document: { schema: "gitpm/time-entry@1", id: "E-26-AAAAAA", project: "P-26-MGP84K", task: "T-26-P9G3P8", person: "U-26-5EBAE3", performed_on: "2026-09-01", hours: 1, category: "regular", created_at: "2026-09-01T00:00:00.000Z", state: "active" }, path: "projects/P-26-MGP84K/time-entries/T-26-P9G3P8/E-26-AAAAAA.yaml", blob_id: "a".repeat(40), draft_fingerprint: "b".repeat(64) }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new HttpGitPmApi().listProjectTimeEntries("DRF-1", "P-26-MGP84K", { task: "T-26-P9G3P8", state: "active", limit: 10 });

    expect(result).toMatchObject({ total: 1, items: [expect.objectContaining({ document: expect.objectContaining({ id: "E-26-AAAAAA" }) })] });
    expect(fetchMock).toHaveBeenCalledWith("/api/drafts/DRF-1/projects/P-26-MGP84K/time-entries?task=T-26-P9G3P8&state=active&limit=10", expect.objectContaining({ credentials: "include" }));
  });

  it("reads project time entries sequentially until the reported total", async () => {
    const entry = (index: number): TimeEntryResult => ({
      document: { schema: "gitpm/time-entry@1", id: `E-26-${String(index).padStart(6, "0")}`, project: "P-26-MGP84K", task: "T-26-P9G3P8", person: "U-26-5EBAE3", performed_on: "2026-09-01", hours: 1, category: "regular", created_at: "2026-09-01T00:00:00.000Z", state: "active" },
      path: `${index}.yaml`, blob_id: "a".repeat(40), draft_fingerprint: "b".repeat(64),
    });
    const all = Array.from({ length: 201 }, (_, index) => entry(index));
    const listProjectTimeEntries = vi.fn(async (_draftId: string, _projectId: string, filters?: { readonly offset?: number; readonly limit?: number }) => {
      const offset = filters?.offset ?? 0; const limit = filters?.limit ?? 200;
      return { items: all.slice(offset, offset + limit), total: all.length, offset, limit };
    });

    const result = await listAllProjectTimeEntries({ listProjectTimeEntries }, "DRF-1", "P-26-MGP84K");

    expect(result).toHaveLength(201);
    expect(listProjectTimeEntries.mock.calls.map((call) => call[2]?.offset)).toEqual([0, 200]);
  });

  it("downloads binary exports and preserves the server filename", async () => {
    const fetchMock = vi.fn(async () => new Response(new Blob(["%PDF"]), {
      status: 200,
      headers: {
        "content-disposition": 'attachment; filename="gitpm-20260725-deadbeef-portfolio.pdf"',
        "content-type": "application/pdf",
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new HttpGitPmApi().exportData("DRF-1", {
      format: "pdf",
      locale: "ru",
      sections: ["projects", "people", "gantt"],
    });

    expect(result.filename).toBe("gitpm-20260725-deadbeef-portfolio.pdf");
    expect(result.blob.type).toBe("application/pdf");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/drafts/DRF-1/export?format=pdf&locale=ru&sections=projects%2Cpeople%2Cgantt",
      { credentials: "include" },
    );
  });

  it("downloads worktree files and decodes UTF-8 attachment names", async () => {
    const fetchMock = vi.fn(async () => new Response(new Blob([new Uint8Array([0, 1, 2, 3])]), {
      status: 200,
      headers: {
        "content-disposition": "attachment; filename=\"____.bin\"; filename*=UTF-8''%D0%BE%D1%82%D1%87%D1%91%D1%82.bin",
        "content-type": "application/octet-stream",
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new HttpGitPmApi().downloadWorktreeFile("DRF-1", "docs/отчёт.bin");

    expect(result.filename).toBe("отчёт.bin");
    expect(result.blob.type).toBe("application/octet-stream");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/drafts/DRF-1/worktree/file/download?path=docs%2F%D0%BE%D1%82%D1%87%D1%91%D1%82.bin",
      { credentials: "include" },
    );
  });

  it("preserves structured error details and sends explicit unlink confirmation", async () => {
    const details = [{ path: "teams/G-26-CORE.yaml", label: "Core" }];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "DELETE_RESTRICTED", message: "referenced", details } }), {
        status: 409,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ deleted: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);
    const entity = { document: { schema: "gitpm/person@1", id: "U-26-5EBAE3" }, path: "people/U-26-5EBAE3.yaml", blob_id: "a".repeat(40), draft_fingerprint: "b".repeat(64) } as EntityResult;
    const api = new HttpGitPmApi();

    await expect(api.deleteEntity("DRF-1", "people", entity, entity.draft_fingerprint)).rejects.toEqual(expect.objectContaining({
      code: "DELETE_RESTRICTED",
      details,
    }));
    await api.deleteEntity("DRF-1", "people", entity, entity.draft_fingerprint, true);

    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]?.body))).toMatchObject({ unlink_references: true });
  });

  it("sends explicit project cascade confirmation separately from unlink confirmation", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ deleted: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const entity = { document: { schema: "gitpm/project@2", id: "P-26-111111" }, path: "projects/P-26-111111/project.yaml", blob_id: "a".repeat(40), draft_fingerprint: "b".repeat(64) } as EntityResult;

    await new HttpGitPmApi().deleteEntity("DRF-1", "projects", entity, entity.draft_fingerprint, false, true);

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
    expect(body).toMatchObject({ cascade_references: true });
    expect(body).not.toHaveProperty("unlink_references");
  });

  it("formats API validation errors with their stable code, path, field and expectation", () => {
    const message = formatApiError(new ApiError("VALIDATION_FAILED", "Repository validation failed", [
      {
        code: "REPOSITORY_TOP_LEVEL",
        path: "legacy-exports",
        message: 'Unknown top-level directory "legacy-exports"',
      },
      {
        code: "SCHEMA_INVALID",
        path: "projects/P-26-111111/project.yaml",
        field: "group",
        message: "must match pattern",
        expected: "a non-empty group name",
      },
    ]));

    expect(message).toBe([
      "[VALIDATION_FAILED] Repository validation failed",
      '- [REPOSITORY_TOP_LEVEL] legacy-exports — Unknown top-level directory "legacy-exports"',
      "- [SCHEMA_INVALID] projects/P-26-111111/project.yaml · field group — must match pattern; expected a non-empty group name",
    ].join("\n"));
  });

  it("accepts configuration documents without entity identity fields", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      document: {
        schema: "gitpm/statuses@2",
        statuses: [{ slug: "backlog", title: "Backlog", color: "gray", active: true, category: "backlog" }],
      },
      path: ".gitpm/statuses.yaml",
      blob_id: "a".repeat(40),
      draft_fingerprint: "b".repeat(64),
    }), { status: 200, headers: { "content-type": "application/json" } })));

    const result = await new HttpGitPmApi().getConfiguration("DRF-1", "statuses");

    expect(result.document).toEqual({
      schema: "gitpm/statuses@2",
      statuses: [{ slug: "backlog", title: "Backlog", color: "gray", active: true, category: "backlog" }],
    });
  });

  it("loads the repository default calendar through its strict response contract", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      document: { schema: "gitpm/repository@1", default_branch: "main", default_calendar: "C-26-QD7FJ4", allowed_top_level_files: ["README.md"], ui_poll_interval_seconds: 5 },
      path: ".gitpm/repository.yaml", blob_id: "a".repeat(40), draft_fingerprint: "b".repeat(64),
    }), { status: 200, headers: { "content-type": "application/json" } })));

    const result = await new HttpGitPmApi().getRepositoryConfiguration("DRF-1");

    expect(result.document.default_calendar).toBe("C-26-QD7FJ4");
  });

  it("updates repository configuration with optimistic file metadata", async () => {
    const entity = { document: { schema: "gitpm/repository@1" as const, default_branch: "main", default_calendar: "C-26-QD7FJ4", allowed_top_level_files: ["README.md"], ui_poll_interval_seconds: 5 }, path: ".gitpm/repository.yaml", blob_id: "a".repeat(40), draft_fingerprint: "b".repeat(64) };
    const next = { ...entity.document, ui_poll_interval_seconds: 7 };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ...entity, document: next }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await new HttpGitPmApi().updateRepositoryConfiguration("DRF-1", entity, entity.draft_fingerprint, next);
    expect(result.document.ui_poll_interval_seconds).toBe(7);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/config/repository"), expect.objectContaining({ method: "PUT", body: expect.stringContaining(`\"expected_blob_id\":\"${entity.blob_id}\"`) }));
  });

  it("decodes configuration reference impact", async () => {
    const impact = { blocking: true, issues: [{ code: "CONFIG_REFERENCE", path: "projects/P-26-MGP84K/project.yaml", field: "status", message: "Status in-progress is still in use" }] };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(impact), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const document = { schema: "gitpm/statuses@2" as const, statuses: [{ slug: "backlog", title: "Backlog", color: "gray", active: true, category: "backlog" as const }] };
    expect(await new HttpGitPmApi().getConfigurationImpact("DRF-1", "statuses", document)).toEqual(impact);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/config/statuses/impact"), expect.objectContaining({ method: "POST" }));
  });

  it("loads the shared workload report with repository filters", async () => {
    const report = {
      formula: "equal-assignee-share/equal-person-working-day/v1",
      weeks: ["2026-07-06"],
      rows: [{ person_id: "U-26-5EBAE3", person_name: "Anna", week: "2026-07-06", allocated_hours: 8, capacity_hours: 40, utilization_percent: 20, task_ids: ["T-26-P9G3P8"], task_allocations: [{ task_id: "T-26-P9G3P8", allocated_hours: 8 }] }],
      included_tasks: 1,
      exclusions: { archived: 0, undated: 0, unestimated: 0, unassigned: 0, unavailable_assignees: 0 },
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(report), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await new HttpGitPmApi().workload("DRF-1", { project: "P-26-MGP84K", team: "G-26-XB86WT" })).toEqual(report);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/workload?project=P-26-MGP84K&team=G-26-XB86WT"), expect.anything());
  });

  it("serializes and decodes an atomic time-entry replacement", async () => {
    const original = { document: { schema: "gitpm/time-entry@1" as const, id: "E-26-AAAAAA", project: "P-26-MGP84K", task: "T-26-P9G3P8", person: "U-26-5EBAE3", performed_on: "2026-09-01", hours: 1, category: "regular", created_at: "2026-09-01T00:00:00.000Z", state: "active" as const }, path: "old.yaml", blob_id: "a".repeat(40), draft_fingerprint: "b".repeat(64) };
    const replacement = { ...original, document: { ...original.document, id: "E-26-BBBBBB", hours: 2 }, path: "new.yaml" };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ voided: { ...original, document: { ...original.document, state: "voided", replacement: replacement.document.id, voided_at: "2026-09-02T00:00:00.000Z", voided_by: { provider: "git", subject: "ada@example.test", display_name: "Ada" } } }, created: replacement }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new HttpGitPmApi().replaceTimeEntry("DRF-1", original.document.project, original.document.task, original, original.draft_fingerprint, { person: original.document.person, performed_on: original.document.performed_on, hours: 2, category: "regular" });

    expect(result.voided.document.replacement).toBe("E-26-BBBBBB");
    expect(result.created.document.hours).toBe(2);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/E-26-AAAAAA/replace"), expect.objectContaining({ method: "POST" }));
  });

  it("rejects entity responses that violate the shared runtime contract", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{
      document: { schema: "gitpm/statuses@2", statuses: [] },
      path: ".gitpm/statuses.yaml",
      blob_id: "a".repeat(40),
      draft_fingerprint: "b".repeat(64),
    }]), { status: 200, headers: { "content-type": "application/json" } })));

    await expect(new HttpGitPmApi().listEntities("DRF-1", "people")).rejects.toBeInstanceOf(ApiContractError);
  });
});
