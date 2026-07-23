import { GitLabHttpProtocol, type GitLabMergeRequestProtocol } from "@gitpm/gitlab";

export function mergeRequestProtocolFromEnvironment(
  environment: NodeJS.ProcessEnv,
  fetchImplementation?: typeof globalThis.fetch,
): GitLabMergeRequestProtocol | undefined {
  const baseUrl = environment.GITPM_GITLAB_URL?.trim();
  const project = environment.GITPM_GITLAB_PROJECT?.trim();
  if (!baseUrl || !project) return undefined;
  return new GitLabHttpProtocol({
    baseUrl,
    project,
    clientId: environment.GITPM_GITLAB_CLIENT_ID?.trim() ?? "",
    ...(fetchImplementation === undefined ? {} : { fetch: fetchImplementation }),
  });
}
