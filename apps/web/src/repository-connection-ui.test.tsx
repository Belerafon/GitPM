// @vitest-environment jsdom
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type GitPmApi } from "./api.js";
import { RepositoryConnectionSettings } from "./repository-connection-ui.js";
import type { RepositoryConnectionStatus } from "./types.js";

const baseStatus = (overrides: Partial<RepositoryConnectionStatus> = {}): RepositoryConnectionStatus => ({
  repository_path: "D:/portfolio",
  repository_mode: "direct",
  default_branch: "main",
  remote_source: "config",
  remote_editable: true,
  gitlab_editable: true,
  gitlab: { configured: false },
  ...overrides,
}) as RepositoryConnectionStatus;

function mockApi(status: RepositoryConnectionStatus, update: (status: RepositoryConnectionStatus) => void = () => undefined): GitPmApi {
  return {
    repositoryConnection: vi.fn(async () => status),
    updateRepositoryConnection: vi.fn(async () => { update(status); return status; }),
    testRepositoryConnection: vi.fn(async () => ({ ok: true as const, branch: "main", commit: "a".repeat(40) })),
    login: vi.fn(async () => "https://gitlab.example/oauth/authorize"),
  } as unknown as GitPmApi;
}

afterEach(cleanup);

describe("RepositoryConnectionSettings", () => {
  it("shows the SSH provider, the SSH credential note, and an enabled test button", async () => {
    const api = mockApi(baseStatus({
      repository_url: "ssh://git@gitlab.example/group/portfolio.git",
      transport: "ssh",
    }));
    const view = render(<RepositoryConnectionSettings api={api} locale="en" maintainer={true} />);
    expect(await screen.findByText("SSH (administrator key)")).toBeTruthy();
    expect(screen.getByText(/SSH, access is provided by an administrator-provisioned key/)).toBeTruthy();
    const testButton = Array.from(view.container.querySelectorAll("button")).find((button) => button.textContent === "Test connection") as HTMLButtonElement;
    expect(testButton.disabled).toBe(false);
    expect(screen.getByText(/Merge Requests are supported only for GitLab/)).toBeTruthy();
  });

  it("accepts the SCP-style SSH remote documented by the form", async () => {
    const api = mockApi(baseStatus());
    const view = render(<RepositoryConnectionSettings api={api} locale="en" maintainer={true} />);
    await screen.findByText("Local (no remote)");
    const input = screen.getByRole("textbox", { name: "Origin URL" });
    fireEvent.change(input, { target: { value: "git@gitlab.example:group/portfolio.git" } });

    expect((input as HTMLInputElement).checkValidity()).toBe(true);
    fireEvent.submit(view.container.querySelector("form") as HTMLFormElement);

    await waitFor(() => expect(api.updateRepositoryConnection).toHaveBeenCalledWith(expect.objectContaining({
      repository_url: "git@gitlab.example:group/portfolio.git",
    })));
  });

  it("shows a plain HTTP remote as the administrator-token provider", async () => {
    const api = mockApi(baseStatus({
      repository_url: "http://gitlab.local/group/portfolio.git",
      transport: "http",
    }));
    render(<RepositoryConnectionSettings api={api} locale="en" maintainer={true} />);
    expect(await screen.findByText("HTTP(S) (administrator token)")).toBeTruthy();
    expect(screen.getByText(/Plain HTTP sends it without transport encryption/)).toBeTruthy();
  });

  it("shows the GitLab provider and the OAuth credential note", async () => {
    const api = mockApi(baseStatus({
      repository_url: "https://gitlab.example/group/portfolio.git",
      transport: "https",
      gitlab: { configured: true, base_url: "https://gitlab.example", project: "group/portfolio", client_id: "app" },
    }));
    render(<RepositoryConnectionSettings api={api} locale="en" maintainer={true} />);
    expect(await screen.findByText("GitLab (OAuth)")).toBeTruthy();
    expect(screen.getByText(/Do not enter passwords or tokens here/)).toBeTruthy();
  });

  it("shows an HTTP GitLab connection as the GitLab OAuth provider", async () => {
    const api = mockApi(baseStatus({
      repository_url: "http://gitlab.local/group/portfolio.git",
      transport: "http",
      gitlab: { configured: true, base_url: "http://gitlab.local", project: "group/portfolio", client_id: "app" },
    }));
    render(<RepositoryConnectionSettings api={api} locale="en" maintainer={true} />);
    expect(await screen.findByText("GitLab (OAuth)")).toBeTruthy();
    expect(screen.getByText(/Plain HTTP sends credentials and repository data without encryption/)).toBeTruthy();
  });

  it("explains the separated identity and Project Access Token mode", async () => {
    const api = mockApi(baseStatus({
      repository_mode: "worktree",
      repository_url: "https://gitlab.example/group/portfolio.git",
      transport: "https",
      remote_source: "environment",
      remote_editable: false,
      gitlab_editable: false,
      gitlab: {
        configured: true,
        base_url: "https://gitlab.example",
        project: "group/portfolio",
        client_id: "app",
        auth_mode: "oauth-identity-project-token",
      },
    }));
    render(<RepositoryConnectionSettings api={api} locale="en" maintainer={true} />);
    expect(await screen.findByText(/OAuth is used only for your identity/)).toBeTruthy();
    expect(screen.getByText(/Public email is required/)).toBeTruthy();
  });

  it("shows the local provider with a disabled test button when no remote is configured", async () => {
    const api = mockApi(baseStatus({ remote_source: "none" }));
    const view = render(<RepositoryConnectionSettings api={api} locale="en" maintainer={true} />);
    expect(await screen.findByText("Local (no remote)")).toBeTruthy();
    const buttons = view.container.querySelectorAll("button");
    const testButton = Array.from(buttons).find((button) => button.textContent === "Test connection") as HTMLButtonElement;
    expect(testButton.disabled).toBe(true);
  });

  it("localizes a known server error code when saving fails", async () => {
    const api = mockApi(baseStatus());
    (api.updateRepositoryConnection as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new ApiError("GITLAB_CONFIGURATION_INCOMPLETE", "raw server text"),
    );
    const view = render(<RepositoryConnectionSettings api={api} locale="en" maintainer={true} />);
    await screen.findByText("Local (no remote)");
    fireEvent.submit(view.container.querySelector("form") as HTMLFormElement);
    await waitFor(() => {
      expect(screen.getByText(/all three fields are required/)).toBeTruthy();
    });
  });
});
