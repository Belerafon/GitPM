// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotificationsMenu } from "./notifications-ui.js";
import { TaskComments } from "./task-comments-ui.js";
import { gitPmApi } from "./test-gitpm-api.js";
import type { CommentResult, DraftStatus, EntityResult } from "./types.js";
import type { ProjectFileList } from "@gitpm/contracts";
import type { ProjectFileReferenceContext } from "./project-file-reference-ui.js";

const draft: DraftStatus = {
  draft_id: "DRF-COMMENTS",
  owner_gitlab_user_id: "42",
  branch: "gitpm/42/DRF-COMMENTS",
  base_commit: "a".repeat(40),
  writer_mode: "ui",
  state: "open",
  fingerprint: "b".repeat(64),
  created_at: "2026-07-20T10:00:00.000Z",
  updated_at: "2026-07-20T10:00:00.000Z",
};

const anna: EntityResult = {
  document: { schema: "gitpm/person@1", id: "U-26-5EBAE3", name: "Anna Petrova", email: "anna@example.test", weekly_capacity_hours: 40, calendar: "C-26-QD7FJ4", lifecycle: "active" },
  path: "people/U-26-5EBAE3.yaml",
  blob_id: "c".repeat(40),
  draft_fingerprint: draft.fingerprint,
};

const files: ProjectFileList = {
  project_id: "P-26-MGP84K", count: 2, total_size_bytes: 3, draft_fingerprint: draft.fingerprint,
  items: [
    { name: "ТЗ @team [финал].pdf", path: "projects/P-26-MGP84K/files/ТЗ @team [финал].pdf", size_bytes: 1, media_type: "application/pdf", disposition: "inline", modified_at: "2026-08-13T00:00:00Z", modified_at_source: "working_copy_filesystem" },
    { name: "Документ.docx", path: "projects/P-26-MGP84K/files/Документ.docx", size_bytes: 2, media_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", disposition: "attachment", modified_at: "2026-08-13T00:00:00Z", modified_at_source: "working_copy_filesystem" },
  ],
};
const fileContext: ProjectFileReferenceContext = { draftId: draft.draft_id, projectId: files.project_id, files, loadState: { status: "ready" }, locale: "en", onReload: vi.fn() };

function comment(id: string, body: string | undefined, state: "active" | "deleted" = "active"): CommentResult {
  const document: CommentResult["document"] = state === "deleted"
    ? { schema: "gitpm/comment@1", id, project: files.project_id, task: "T-26-P9G3P8", author: { provider: "git", subject: "boris@example.test", display_name: "Boris" }, created_at: "2026-07-20T10:05:00.000Z", state, deleted_at: "2026-07-20T10:06:00.000Z", deleted_by: { provider: "git", subject: "boris@example.test", display_name: "Boris" }, mentions: [] }
    : { schema: "gitpm/comment@1", id, project: files.project_id, task: "T-26-P9G3P8", author: { provider: "git", subject: "boris@example.test", display_name: "Boris" }, created_at: "2026-07-20T10:05:00.000Z", state, body_markdown: body ?? "", mentions: [] };
  return {
    document,
    path: `projects/${files.project_id}/comments/T-26-P9G3P8/${id}.yaml`, blob_id: "d".repeat(40), draft_fingerprint: "e".repeat(64), can_edit: state === "active", can_delete: state === "active",
  };
}

afterEach(() => { cleanup(); sessionStorage.clear(); localStorage.clear(); });

describe("task comments", () => {
  it("inserts a stable person mention and submits the comment", async () => {
    let submittedBody = "";
    const created: CommentResult = {
      document: {
        schema: "gitpm/comment@1",
        id: "N-26-ABC123",
        project: "P-26-MGP84K",
        task: "T-26-P9G3P8",
        author: { provider: "git", subject: "boris@example.test", display_name: "Boris" },
        created_at: "2026-07-20T10:05:00.000Z",
        state: "active",
        body_markdown: "",
        mentions: [{ person: "U-26-5EBAE3", mentioned_at: "2026-07-20T10:05:00.000Z" }],
      },
      path: "projects/P-26-MGP84K/comments/T-26-P9G3P8/N-26-ABC123.yaml",
      blob_id: "d".repeat(40),
      draft_fingerprint: "e".repeat(64),
      can_edit: true,
      can_delete: true,
    };
    const api = gitPmApi({
      listComments: vi.fn(async () => []),
      createComment: vi.fn(async (_draftId: string, _projectId: string, _taskId: string, _fingerprint: string, body: string) => {
        submittedBody = body;
        return { ...created, document: { ...created.document, body_markdown: body } };
      }),
    });

    render(<TaskComments api={api} confirmDelete={() => true} draft={draft} fingerprint={draft.fingerprint} locale="en" onFingerprintChange={async () => undefined} onNavigate={() => undefined} people={[anna]} projectId="P-26-MGP84K" readOnly={false} taskId="T-26-P9G3P8" />);
    const toggle = await screen.findByRole("button", { name: "Discussion" });
    await waitFor(() => expect(screen.getByRole("region", { name: "Discussion" }).getAttribute("aria-busy")).toBe("false"));
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByLabelText("Discussion: 0")).toBeTruthy();
    expect(screen.queryByLabelText("Add comment")).toBeNull();
    fireEvent.click(toggle);
    const composer = screen.getByLabelText("Add comment");
    expect(document.activeElement).not.toBe(composer);
    fireEvent.change(composer, { target: { value: "Please review @Ann", selectionStart: 18 } });
    fireEvent.click(await screen.findByRole("option", { name: /Anna Petrova/iu }));
    expect(composer).toHaveProperty("value", "Please review @[Anna Petrova](person:U-26-5EBAE3) ");
    fireEvent.click(screen.getByRole("button", { name: /^Comment/iu }));

    await waitFor(() => expect(api.createComment).toHaveBeenCalledOnce());
    expect(submittedBody).toBe("Please review @[Anna Petrova](person:U-26-5EBAE3) ");
    expect(await screen.findByRole("button", { name: "@Anna Petrova" })).toBeTruthy();
  });

  it("keeps the composer visible when comments already exist", async () => {
    const existing: CommentResult = {
      document: {
        schema: "gitpm/comment@1",
        id: "N-26-ABC123",
        project: "P-26-MGP84K",
        task: "T-26-P9G3P8",
        author: { provider: "git", subject: "boris@example.test", display_name: "Boris" },
        created_at: "2026-07-20T10:05:00.000Z",
        state: "active",
        body_markdown: "Already discussed",
        mentions: [],
      },
      path: "projects/P-26-MGP84K/comments/T-26-P9G3P8/N-26-ABC123.yaml",
      blob_id: "d".repeat(40),
      draft_fingerprint: "e".repeat(64),
      can_edit: true,
      can_delete: true,
    };
    const api = gitPmApi({
      listComments: vi.fn(async () => [existing]),
    });

    render(<TaskComments api={api} confirmDelete={() => true} draft={draft} fingerprint={draft.fingerprint} locale="en" onFingerprintChange={async () => undefined} onNavigate={() => undefined} people={[]} projectId="P-26-MGP84K" readOnly={false} taskId="T-26-P9G3P8" />);

    expect(await screen.findByText("Already discussed")).toBeTruthy();
    expect(screen.getByLabelText("Add comment")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add comment" })).toBeNull();
  });

  it("collapses and expands via the heading toggle", async () => {
    const existing: CommentResult = {
      document: {
        schema: "gitpm/comment@1",
        id: "N-26-COLLAP",
        project: "P-26-MGP84K",
        task: "T-26-P9G3P8",
        author: { provider: "git", subject: "boris@example.test", display_name: "Boris" },
        created_at: "2026-07-20T10:05:00.000Z",
        state: "active",
        body_markdown: "Keep this visible",
        mentions: [],
      },
      path: "projects/P-26-MGP84K/comments/T-26-P9G3P8/N-26-COLLAP.yaml",
      blob_id: "d".repeat(40),
      draft_fingerprint: "e".repeat(64),
      can_edit: true,
      can_delete: true,
    };
    const api = gitPmApi({ listComments: vi.fn(async () => [existing]) });

    render(<TaskComments api={api} confirmDelete={() => true} draft={draft} fingerprint={draft.fingerprint} locale="en" onFingerprintChange={async () => undefined} onNavigate={() => undefined} people={[]} projectId="P-26-MGP84K" readOnly={false} taskId="T-26-P9G3P8" />);

    const toggle = await screen.findByRole("button", { name: /^Discussion$/iu });
    expect(await screen.findByText("Keep this visible")).toBeTruthy();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByLabelText("Discussion: 1")).toBeTruthy();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Keep this visible")).toBeNull();
    fireEvent.click(toggle);
    expect(await screen.findByText("Keep this visible")).toBeTruthy();
  });

  it("renders file references and person mentions together without interpreting @ inside a filename", async () => {
    const active = comment("N-26-FILES1", "@[Anna Petrova](person:U-26-5EBAE3) см. [[file:ТЗ @team \\[финал\\].pdf]] и [[file:missing.txt]] <img src=x>");
    const deleted = comment("N-26-FILES2", "[[file:Документ.docx]] secret", "deleted");
    const api = gitPmApi({ listComments: vi.fn(async () => [active, deleted]), listProjectFiles: vi.fn() });

    const rendered = render(<TaskComments api={api} confirmDelete={() => true} draft={draft} fileContext={fileContext} fingerprint={draft.fingerprint} locale="en" onFingerprintChange={async () => undefined} onNavigate={() => undefined} people={[anna]} projectId={files.project_id} readOnly={false} taskId="T-26-P9G3P8" />);

    expect(await screen.findByRole("button", { name: "@Anna Petrova" })).toBeTruthy();
    const fileLink = screen.getByRole("link", { name: "Open ТЗ @team [финал].pdf in a new tab" });
    expect(fileLink.textContent).toContain("@team");
    expect(screen.queryByRole("button", { name: /@team/iu })).toBeNull();
    expect(screen.getByRole("note", { name: "Broken file reference: missing.txt" })).toBeTruthy();
    expect(rendered.container.textContent).toContain("<img src=x>");
    expect(rendered.container.querySelector("img,script,svg")).toBeNull();
    expect(screen.getByText("Comment deleted.")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Download Документ.docx" })).toBeNull();
    expect(api.listProjectFiles).not.toHaveBeenCalled();
  });

  it("inserts canonical Unicode file references into create and edit flows and preserves fingerprints", async () => {
    const existing = comment("N-26-EDIT1", "Before selected after");
    const created = comment("N-26-NEWFILE", "");
    const createComment = vi.fn(async (_d: string, _p: string, _t: string, _fingerprint: string, body: string) => ({ ...created, document: { ...created.document, body_markdown: body }, draft_fingerprint: "f".repeat(64) }));
    const updateComment = vi.fn(async (_d: string, _p: string, _t: string, original: CommentResult, _fingerprint: string, body: string) => ({ ...original, document: { ...original.document, body_markdown: body }, draft_fingerprint: "9".repeat(64) }));
    const onFingerprintChange = vi.fn(async () => undefined);
    const api = gitPmApi({ listComments: vi.fn(async () => [existing]), createComment, updateComment });

    render(<TaskComments api={api} confirmDelete={() => true} draft={draft} fileContext={fileContext} fingerprint={draft.fingerprint} locale="en" onFingerprintChange={onFingerprintChange} onNavigate={() => undefined} people={[anna]} projectId={files.project_id} readOnly={false} taskId="T-26-P9G3P8" />);
    const composer = await screen.findByLabelText("Add comment") as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "Согласно  и @Ann", selectionStart: 10 } });
    composer.setSelectionRange(9, 9);
    fireEvent.click(screen.getAllByRole("button", { name: "Insert file" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Insert a link to ТЗ @team [финал].pdf" }));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(composer.value).toContain("[[file:ТЗ @team \\[финал\\].pdf]]");
    fireEvent.click(screen.getByRole("button", { name: /^Comment/iu }));
    await waitFor(() => expect(createComment).toHaveBeenCalledWith(draft.draft_id, files.project_id, "T-26-P9G3P8", existing.draft_fingerprint, expect.stringContaining("[[file:ТЗ @team \\[финал\\].pdf]]")));
    await waitFor(() => expect(onFingerprintChange).toHaveBeenCalledWith("f".repeat(64)));

    const existingArticle = document.getElementById(`comment-${existing.document.id}`)!;
    fireEvent.click(within(existingArticle).getByLabelText("Comment actions"));
    fireEvent.click(within(existingArticle).getByRole("button", { name: "Edit" }));
    const editor = screen.getByLabelText("Edit") as HTMLTextAreaElement;
    editor.setSelectionRange(7, 15);
    fireEvent.click(within(existingArticle).getByRole("button", { name: "Insert file" }));
    fireEvent.click(within(existingArticle).getByRole("button", { name: "Insert a link to Документ.docx" }));
    fireEvent.click(within(existingArticle).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateComment).toHaveBeenCalledWith(draft.draft_id, files.project_id, "T-26-P9G3P8", existing, "f".repeat(64), "Before [[file:Документ.docx]] after"));
    expect(onFingerprintChange).toHaveBeenLastCalledWith("9".repeat(64));
  });

  it("keeps file references neutral during loading and disables picker in read-only comments", async () => {
    const existing = comment("N-26-READ01", "[[file:Документ.docx]]");
    const api = gitPmApi({ listComments: vi.fn(async () => [existing]) });
    render(<TaskComments api={api} confirmDelete={() => true} draft={draft} fileContext={{ ...fileContext, files: null, loadState: { status: "loading" } }} fingerprint={draft.fingerprint} locale="en" onFingerprintChange={async () => undefined} onNavigate={() => undefined} people={[]} projectId={files.project_id} readOnly taskId="T-26-P9G3P8" />);
    expect(await screen.findByLabelText("File reference not checked: Документ.docx")).toBeTruthy();
    expect(screen.queryByLabelText("Add comment")).toBeNull();
    expect(screen.queryByRole("button", { name: "Insert file" })).toBeNull();
  });
});

describe("mention notifications", () => {
  it("shows unread mentions, marks one read and opens its task", async () => {
    const onNavigate = vi.fn();
    const notification = {
      key: "N-26-ABC123:2026-07-20T10:05:00.000Z",
      read: false,
      person_id: "U-26-5EBAE3",
      mentioned_at: "2026-07-20T10:05:00.000Z",
      project_id: "P-26-MGP84K",
      task_id: "T-26-P9G3P8",
      task_title: "Approve schema v1",
      comment_id: "N-26-ABC123",
      author: { provider: "git" as const, subject: "boris@example.test", display_name: "Boris" },
      excerpt: "Please review @Anna Petrova",
    };
    const api = gitPmApi({
      notifications: vi.fn(async () => ({
        recipient_person_id: "U-26-5EBAE3",
        items: [notification],
      })),
      markNotificationsRead: vi.fn(async () => ({ recipient_person_id: "U-26-5EBAE3", items: [{ ...notification, read: true }] })),
    });

    render(<NotificationsMenu api={api} draft={draft} locale="en" namespace="test" onNavigate={onNavigate} />);
    await waitFor(() => expect(api.notifications).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByLabelText("Notifications"));
    fireEvent.click(await screen.findByRole("button", { name: /Approve schema v1/iu }));
    expect(onNavigate).toHaveBeenCalledWith("tasks", { projectId: "P-26-MGP84K", taskId: "T-26-P9G3P8", query: { comment: ["N-26-ABC123"] } });
    await waitFor(() => expect(api.markNotificationsRead).toHaveBeenCalledWith(draft.draft_id, [notification.key]));
    expect(localStorage.getItem("gitpm.notifications.read:test")).toBeNull();
  });

  it("migrates legacy browser keys to the server once", async () => {
    const key = "N-26-ABC123:2026-07-20T10:05:00.000Z";
    const notification = { key, read: false, person_id: "U-26-5EBAE3", mentioned_at: "2026-07-20T10:05:00.000Z", project_id: "P-26-MGP84K", task_id: "T-26-P9G3P8", task_title: "Approve schema v1", comment_id: "N-26-ABC123", author: { provider: "git" as const, subject: "boris@example.test", display_name: "Boris" }, excerpt: "Please review" };
    localStorage.setItem("gitpm.notifications.read:test", JSON.stringify([key]));
    const api = gitPmApi({
      notifications: vi.fn(async () => ({ recipient_person_id: "U-26-5EBAE3", items: [notification] })),
      markNotificationsRead: vi.fn(async () => ({ recipient_person_id: "U-26-5EBAE3", items: [{ ...notification, read: true }] })),
    });

    render(<NotificationsMenu api={api} draft={draft} locale="en" namespace="test" onNavigate={vi.fn()} />);

    await waitFor(() => expect(api.markNotificationsRead).toHaveBeenCalledWith(draft.draft_id, [key]));
    expect(localStorage.getItem("gitpm.notifications.read:test")).toBeNull();
  });
});
