import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, formatApiError, HttpGitPmApi, listAllProjectTimeEntries, projectFileContentUrl, projectFileDownloadUrl, type TimeEntryResult } from "./api.js";
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

  it("marks notification keys read through the authenticated server action", async () => {
    const result = { recipient_person_id: "U-26-5EBAE3", items: [] };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await new HttpGitPmApi().markNotificationsRead("DRF-1", ["N-26-ABC123:2026-07-20T10:05:00.000Z"]);

    expect(fetchMock).toHaveBeenCalledWith("/api/drafts/DRF-1/notifications/read", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ keys: ["N-26-ABC123:2026-07-20T10:05:00.000Z"] }),
    }));
  });

  it("encodes global-search input and decodes the compact result contract", async () => {
    const payload = { query: "Анна + QA", items: [{ entity_type: "person", id: "U-26-5EBAE3", title: "Анна", context: "anna@example.test", lifecycle: "active" }], total: 1 };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new HttpGitPmApi().searchEntities("DRF-1", "Анна + QA", 8);

    expect(result).toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith("/api/drafts/DRF-1/search?q=%D0%90%D0%BD%D0%BD%D0%B0+%2B+QA&limit=8", expect.objectContaining({ credentials: "include" }));
  });

  it("encodes Project file-list scope and decodes the shared response contract", async () => {
    const payload = { project_id: "P-26-MGP84K", count: 1, total_size_bytes: 12, items: [{ name: "ТЗ <script>.docx", path: "projects/P-26-MGP84K/files/ТЗ <script>.docx", size_bytes: 12, media_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", disposition: "attachment", modified_at: "2026-08-13T10:00:00.000Z", modified_at_source: "working_copy_filesystem" }], draft_fingerprint: "b".repeat(64) };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await new HttpGitPmApi().listProjectFiles("DRF/1", "P-26-MGP84K")).toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith("/api/drafts/DRF%2F1/projects/P-26-MGP84K/files", expect.objectContaining({ credentials: "include" }));
  });

  it("builds encoded Project file URLs without accepting path or target injection", () => {
    expect(projectFileContentUrl("DRF/1", "P-26-MGP84K", "ТЗ </a> #1.pdf")).toBe(`/api/drafts/DRF%2F1/projects/P-26-MGP84K/files/${encodeURIComponent("ТЗ </a> #1.pdf")}/content`);
    expect(projectFileDownloadUrl("DRF/1", "P/26", "..\\secret.txt")).toBe(`/api/drafts/DRF%2F1/projects/P%2F26/files/${encodeURIComponent("..\\secret.txt")}/download`);
  });

  it("loads checked reference consequences and sends explicit checked mutation modes", async () => {
    const location = { entity_type: "task", entity_id: "T-26-P9G3P8", path: "projects/P-26-MGP84K/tasks/T-26-P9G3P8.yaml", field: "description_markdown", start: 0, end: 20 };
    const preview = { project_id: "P-26-MGP84K", file_name: "ТЗ.docx", status: "checked", count: 1, locations: [location], draft_fingerprint: "b".repeat(64) };
    const item = { name: "ТЗ v2.docx", path: "projects/P-26-MGP84K/files/ТЗ v2.docx", size_bytes: 1, media_type: "application/octet-stream", disposition: "attachment", modified_at: "2026-08-13T10:00:00.000Z", modified_at_source: "working_copy_filesystem" };
    const references = { status: "checked", action: "updated", before_count: 1, affected_count: 1, remaining_count: 0, locations: [location] };
    const renamed = { project_id: preview.project_id, operation: "renamed", previous_name: preview.file_name, item, references, draft_fingerprint: "c".repeat(64) };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(preview), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(renamed), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const api = new HttpGitPmApi();
    await expect(api.projectFileReferences("DRF/1", preview.project_id, preview.file_name)).resolves.toEqual(preview);
    await expect(api.renameProjectFile("DRF/1", preview.project_id, preview.file_name, preview.draft_fingerprint, item.name, "update")).resolves.toEqual(renamed);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/drafts/DRF%2F1/projects/${preview.project_id}/files/${encodeURIComponent(preview.file_name)}/references`);
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ body: JSON.stringify({ expected_fingerprint: preview.draft_fingerprint, new_name: item.name, reference_mode: "update" }) }));
  });

  it("renames and deletes Project files with explicit unchecked-reference semantics", async () => {
    const renamed = { project_id: "P-26-MGP84K", operation: "renamed", previous_name: "ТЗ v3.docx", item: { name: "ТЗ V3.docx", path: "projects/P-26-MGP84K/files/ТЗ V3.docx", size_bytes: 12, media_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", disposition: "attachment", modified_at: "2026-08-13T10:00:00.000Z", modified_at_source: "working_copy_filesystem" }, references: { status: "not_checked" }, draft_fingerprint: "c".repeat(64) };
    const deleted = { project_id: "P-26-MGP84K", operation: "deleted", name: renamed.item.name, path: renamed.item.path, size_bytes: 12, references: { status: "not_checked" }, secure_erase: false, draft_fingerprint: "d".repeat(64) };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(renamed), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(deleted), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const api = new HttpGitPmApi();

    expect(await api.renameProjectFile("DRF/1", renamed.project_id, renamed.previous_name, "b".repeat(64), renamed.item.name)).toEqual(renamed);
    expect(await api.deleteProjectFile("DRF/1", renamed.project_id, renamed.item.name, "c".repeat(64), renamed.item.name)).toEqual(deleted);
    expect(fetchMock.mock.calls[0]).toEqual([`/api/drafts/DRF%2F1/projects/P-26-MGP84K/files/${encodeURIComponent(renamed.previous_name)}/rename`, expect.objectContaining({ method: "POST", body: JSON.stringify({ expected_fingerprint: "b".repeat(64), new_name: renamed.item.name, reference_mode: "ignore_unchecked" }) })]);
    expect(fetchMock.mock.calls[1]).toEqual([`/api/drafts/DRF%2F1/projects/P-26-MGP84K/files/${encodeURIComponent(renamed.item.name)}`, expect.objectContaining({ method: "DELETE", body: JSON.stringify({ expected_fingerprint: "c".repeat(64), confirmation_name: renamed.item.name, reference_mode: "ignore_unchecked" }) })]);
  });

  it("rejects invalid file mutation responses and preserves structured server errors", async () => {
    const invalid = { project_id: "P-26-MGP84K", operation: "renamed", previous_name: "a.txt", item: { name: "b.txt", path: "projects/P-26-MGP84K/files/b.txt", size_bytes: 1, media_type: "text/plain", disposition: "inline", modified_at: "2026-08-13T10:00:00.000Z", modified_at_source: "working_copy_filesystem" }, references: { status: "checked" }, draft_fingerprint: "c".repeat(64) };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(invalid), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "PROJECT_FILE_NAME_CONFLICT", message: "Name conflicts", details: [{ field: "new_name" }] } }), { status: 409, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const api = new HttpGitPmApi();

    await expect(api.renameProjectFile("DRF-1", invalid.project_id, "a.txt", "b".repeat(64), "b.txt")).rejects.toBeInstanceOf(ApiContractError);
    await expect(api.deleteProjectFile("DRF-1", invalid.project_id, "a.txt", "b".repeat(64), "a.txt")).rejects.toEqual(expect.objectContaining({ code: "PROJECT_FILE_NAME_CONFLICT", details: [{ field: "new_name" }] }));
  });

  it("uploads exact binary bytes with Unicode metadata and optional large-file confirmation", async () => {
    const bytes = new Uint8Array([0, 255, 17, 128]);
    const file = Object.assign(new Blob([bytes]), { name: "ТЗ <final>.bin", lastModified: 0 }) as File;
    const payload = { project_id: "P-26-MGP84K", operation: "created", item: { name: file.name, path: `projects/P-26-MGP84K/files/${file.name}`, size_bytes: bytes.length, media_type: "application/octet-stream", disposition: "attachment", modified_at: "2026-08-13T10:00:00.000Z", modified_at_source: "working_copy_filesystem" }, references: { status: "not_checked" }, draft_fingerprint: "c".repeat(64) };
    const listeners = new Map<string, () => void>();
    const progressListeners: Array<(event: ProgressEvent) => void> = [];
    const xhr = {
      status: 201, statusText: "Created", responseText: JSON.stringify(payload), withCredentials: false, body: undefined as Document | XMLHttpRequestBodyInit | null | undefined,
      headers: new Map<string, string>(), method: "", path: "",
      upload: { addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => progressListeners.push(listener as (event: ProgressEvent) => void) },
      open(method: string, path: string) { this.method = method; this.path = path; },
      setRequestHeader(name: string, value: string) { this.headers.set(name, value); },
      addEventListener(type: string, listener: EventListenerOrEventListenerObject) { listeners.set(type, listener as () => void); },
      send(body: Document | XMLHttpRequestBodyInit | null) { this.body = body; progressListeners.forEach((listener) => listener({ loaded: 2, total: 4, lengthComputable: true } as ProgressEvent)); listeners.get("load")?.(); },
      abort() { listeners.get("abort")?.(); },
    };
    const XhrConstructor = function XhrConstructor() { return xhr; } as unknown as typeof XMLHttpRequest;
    vi.stubGlobal("XMLHttpRequest", XhrConstructor);
    const onProgress = vi.fn();

    expect(await new HttpGitPmApi().uploadProjectFile("DRF/1", "P-26-MGP84K", "b".repeat(64), file, file.name, "create", { largeFileConfirmation: file.name, onProgress })).toEqual(payload);

    expect(xhr.path).toBe("/api/drafts/DRF%2F1/projects/P-26-MGP84K/files/upload");
    expect(xhr.body).toBe(file);
    expect(xhr.withCredentials).toBe(true);
    expect(xhr.headers.get("content-type")).toBe("application/octet-stream");
    expect(xhr.headers.get("x-gitpm-file-name")).toBe(encodeURIComponent(file.name));
    expect(xhr.headers.get("x-gitpm-upload-size")).toBe("4");
    expect(xhr.headers.get("x-gitpm-expected-fingerprint")).toBe("b".repeat(64));
    expect(xhr.headers.get("x-gitpm-upload-mode")).toBe("create");
    expect(xhr.headers.get("x-gitpm-large-file-confirmation")).toBe(encodeURIComponent(file.name));
    expect(new Uint8Array(await (xhr.body as Blob).arrayBuffer())).toEqual(bytes);
    expect(onProgress).toHaveBeenCalledWith(2, 4);
  });

  it("streams a selected replacement to the project-scoped replace route", async () => {
    const file = new Blob(["new"]);
    const payload = { project_id: "P-26-MGP84K", operation: "replaced", previous_name: "old.txt", item: { name: "new.txt", path: "projects/P-26-MGP84K/files/new.txt", size_bytes: 3, media_type: "text/plain; charset=utf-8", disposition: "inline", modified_at: "2026-08-13T10:00:00.000Z", modified_at_source: "working_copy_filesystem" }, references: { status: "checked", action: "updated", before_count: 1, affected_count: 1, remaining_count: 0, locations: [] }, draft_fingerprint: "c".repeat(64) };
    const listeners = new Map<string, () => void>();
    const xhr = { status: 200, statusText: "OK", responseText: JSON.stringify(payload), path: "", body: undefined as Blob | undefined, withCredentials: false, headers: new Map<string, string>(), upload: { addEventListener: vi.fn() }, open(_method: string, path: string) { this.path = path; }, setRequestHeader(name: string, value: string) { this.headers.set(name, value); }, addEventListener(type: string, listener: EventListenerOrEventListenerObject) { listeners.set(type, listener as () => void); }, send(body: Blob) { this.body = body; listeners.get("load")?.(); }, abort: vi.fn() };
    vi.stubGlobal("XMLHttpRequest", function XhrConstructor() { return xhr; } as unknown as typeof XMLHttpRequest);
    await expect(new HttpGitPmApi().replaceProjectFile("DRF/1", payload.project_id, payload.previous_name, "b".repeat(64), file, payload.item.name)).resolves.toEqual(payload);
    expect(xhr.path).toBe(`/api/drafts/DRF%2F1/projects/${payload.project_id}/files/${payload.previous_name}/replace`);
    expect(xhr.headers.get("x-gitpm-file-name")).toBe(encodeURIComponent(payload.item.name));
    expect(xhr.headers.get("x-gitpm-expected-fingerprint")).toBe("b".repeat(64));
    expect(xhr.body).toBe(file);
  });

  it("uploads a zero-byte file without adding large-file confirmation", async () => {
    const file = Object.assign(new Blob([]), { name: "пустой файл", lastModified: 0 }) as File;
    const payload = { project_id: "P-26-MGP84K", operation: "created", item: { name: file.name, path: `projects/P-26-MGP84K/files/${file.name}`, size_bytes: 0, media_type: "application/octet-stream", disposition: "attachment", modified_at: "2026-08-13T10:00:00.000Z", modified_at_source: "working_copy_filesystem" }, references: { status: "not_checked" }, draft_fingerprint: "c".repeat(64) };
    const listeners = new Map<string, () => void>();
    const xhr = { status: 201, statusText: "Created", responseText: JSON.stringify(payload), withCredentials: false, headers: new Map<string, string>(), upload: { addEventListener: vi.fn() }, open: vi.fn(), setRequestHeader(name: string, value: string) { this.headers.set(name, value); }, addEventListener(type: string, listener: EventListenerOrEventListenerObject) { listeners.set(type, listener as () => void); }, send: vi.fn(() => listeners.get("load")?.()), abort: vi.fn() };
    const XhrConstructor = function XhrConstructor() { return xhr; } as unknown as typeof XMLHttpRequest;
    vi.stubGlobal("XMLHttpRequest", XhrConstructor);

    await new HttpGitPmApi().uploadProjectFile("DRF-1", "P-26-MGP84K", "b".repeat(64), file, file.name, "create");

    expect(xhr.headers.has("x-gitpm-large-file-confirmation")).toBe(false);
  });

  it("decodes structured upload errors returned by the raw XHR route", async () => {
    const listeners = new Map<string, () => void>();
    const xhr = {
      status: 403, statusText: "Forbidden", responseText: JSON.stringify({ error: { code: "FORBIDDEN", message: "Reporter cannot upload", details: [{ field: "role" }] } }), withCredentials: false,
      upload: { addEventListener: vi.fn() }, open: vi.fn(), setRequestHeader: vi.fn(),
      addEventListener(type: string, listener: EventListenerOrEventListenerObject) { listeners.set(type, listener as () => void); },
      send: vi.fn(() => listeners.get("load")?.()), abort: vi.fn(),
    };
    const XhrConstructor = function XhrConstructor() { return xhr; } as unknown as typeof XMLHttpRequest;
    vi.stubGlobal("XMLHttpRequest", XhrConstructor);

    await expect(new HttpGitPmApi().uploadProjectFile("DRF-1", "P-26-MGP84K", "b".repeat(64), new Blob([]), "report.bin", "create")).rejects.toEqual(expect.objectContaining({ code: "FORBIDDEN", message: "Reporter cannot upload", details: [{ field: "role" }] }));
  });

  it("aborts the raw XHR upload through AbortSignal", async () => {
    const listeners = new Map<string, () => void>();
    const xhr = {
      status: 0, statusText: "", responseText: "", withCredentials: false,
      upload: { addEventListener: vi.fn() }, open: vi.fn(), setRequestHeader: vi.fn(),
      addEventListener(type: string, listener: EventListenerOrEventListenerObject) { listeners.set(type, listener as () => void); },
      send: vi.fn(), abort: vi.fn(() => listeners.get("abort")?.()),
    };
    const XhrConstructor = function XhrConstructor() { return xhr; } as unknown as typeof XMLHttpRequest;
    vi.stubGlobal("XMLHttpRequest", XhrConstructor);
    const controller = new AbortController();
    const promise = new HttpGitPmApi().uploadProjectFile("DRF-1", "P-26-MGP84K", "b".repeat(64), new Blob(["data"]), "cancel.bin", "create", { signal: controller.signal });

    controller.abort();

    await expect(promise).rejects.toEqual(expect.objectContaining({ name: "AbortError" }));
    expect(xhr.abort).toHaveBeenCalledOnce();
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
      formula: "equal-assignee-share/capacity-weighted-person-day/v2",
      weeks: ["2026-07-06"],
      rows: [{ person_id: "U-26-5EBAE3", person_name: "Anna", week: "2026-07-06", allocated_hours: 8, base_capacity_hours: 40, capacity_hours: 40, unavailable_hours: 0, utilization_percent: 20, task_ids: ["T-26-P9G3P8"], task_allocations: [{ task_id: "T-26-P9G3P8", allocated_hours: 8 }] }],
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
