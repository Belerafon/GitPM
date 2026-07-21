// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitPmApi } from "./api.js";
import { NotificationsMenu } from "./notifications-ui.js";
import { TaskComments } from "./task-comments-ui.js";
import type { CommentResult, DraftStatus, EntityResult } from "./types.js";

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
    const api = {
      listComments: vi.fn(async () => []),
      createComment: vi.fn(async (_draftId: string, _projectId: string, _taskId: string, _fingerprint: string, body: string) => {
        submittedBody = body;
        return { ...created, document: { ...created.document, body_markdown: body } };
      }),
    } as unknown as GitPmApi;

    render(<TaskComments api={api} confirmDelete={() => true} draft={draft} fingerprint={draft.fingerprint} locale="en" onFingerprintChange={async () => undefined} onNavigate={() => undefined} people={[anna]} projectId="P-26-MGP84K" readOnly={false} taskId="T-26-P9G3P8" />);
    await screen.findByText("No comments yet.");
    const composer = screen.getByLabelText("Add comment");
    fireEvent.change(composer, { target: { value: "Please review @Ann", selectionStart: 18 } });
    fireEvent.click(await screen.findByRole("option", { name: /Anna Petrova/iu }));
    expect(composer).toHaveProperty("value", "Please review @[Anna Petrova](person:U-26-5EBAE3) ");
    fireEvent.click(screen.getByRole("button", { name: /^Comment/iu }));

    await waitFor(() => expect(api.createComment).toHaveBeenCalledOnce());
    expect(submittedBody).toBe("Please review @[Anna Petrova](person:U-26-5EBAE3) ");
    expect(await screen.findByRole("button", { name: "@Anna Petrova" })).toBeTruthy();
  });
});

describe("mention notifications", () => {
  it("shows unread mentions, marks one read and opens its task", async () => {
    const onNavigate = vi.fn();
    const api = {
      notifications: vi.fn(async () => ({
        recipient_person_id: "U-26-5EBAE3",
        items: [{
          key: "N-26-ABC123:2026-07-20T10:05:00.000Z",
          person_id: "U-26-5EBAE3",
          mentioned_at: "2026-07-20T10:05:00.000Z",
          project_id: "P-26-MGP84K",
          task_id: "T-26-P9G3P8",
          task_title: "Approve schema v1",
          comment_id: "N-26-ABC123",
          author: { provider: "git" as const, subject: "boris@example.test", display_name: "Boris" },
          excerpt: "Please review @Anna Petrova",
        }],
      })),
    } as unknown as GitPmApi;

    render(<NotificationsMenu api={api} draft={draft} locale="en" namespace="test" onNavigate={onNavigate} />);
    await waitFor(() => expect(api.notifications).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByLabelText("Notifications"));
    fireEvent.click(await screen.findByRole("button", { name: /Approve schema v1/iu }));
    expect(onNavigate).toHaveBeenCalledWith("tasks", { projectId: "P-26-MGP84K", taskId: "T-26-P9G3P8", query: { comment: ["N-26-ABC123"] } });
    expect(JSON.parse(localStorage.getItem("gitpm.notifications.read:test") ?? "[]")).toEqual(["N-26-ABC123:2026-07-20T10:05:00.000Z"]);
  });
});
