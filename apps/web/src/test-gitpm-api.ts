import type { GitPmApi } from "./api.js";

const unsupported = async (..._args: readonly unknown[]): Promise<never> => {
  throw new Error("Unexpected GitPmApi call in test double");
};

const fallback = {
  session: unsupported,
  login: unsupported,
  logout: unsupported,
  repositoryConnection: unsupported,
  updateRepositoryConnection: unsupported,
  testRepositoryConnection: unsupported,
  listDrafts: unsupported,
  createDraft: unsupported,
  snapshot: unsupported,
  setWriterMode: unsupported,
  acknowledgeExternalChanges: unsupported,
  closeDraft: unsupported,
  reopenDraft: unsupported,
  cleanupDraft: unsupported,
  exportData: unsupported,
  listEntities: unsupported,
  searchEntities: unsupported,
  getEntity: unsupported,
  projectWorkspace: unsupported,
  listProjectFiles: unsupported,
  projectFileReferences: unsupported,
  replaceProjectFile: unsupported,
  uploadProjectFile: unsupported,
  renameProjectFile: unsupported,
  deleteProjectFile: unsupported,
  createEntity: unsupported,
  updateEntity: unsupported,
  moveTask: unsupported,
  archiveEntity: unsupported,
  restoreEntity: unsupported,
  deleteEntity: unsupported,
  getConfiguration: unsupported,
  getPersonNameFormat: unsupported,
  getRepositoryConfiguration: unsupported,
  getConfigurationImpact: unsupported,
  updateConfiguration: unsupported,
  updateRepositoryConfiguration: unsupported,
  listChanges: unsupported,
  listWorktree: unsupported,
  readWorktreeFile: unsupported,
  downloadWorktreeFile: unsupported,
  deleteWorktreeEntry: unsupported,
  createWorktreeDirectory: unsupported,
  uploadWorktreeFile: unsupported,
  moveWorktreeEntry: unsupported,
  semanticChanges: unsupported,
  restoreFile: unsupported,
  restoreHunk: unsupported,
  discardAll: unsupported,
  commitAll: unsupported,
  push: unsupported,
  createMergeRequest: unsupported,
  pollMergeRequest: unsupported,
  history: unsupported,
  commitDetail: unsupported,
  commitFileDiff: unsupported,
  fileHistory: unsupported,
  createRevertDraft: unsupported,
  restoreCommitFiles: unsupported,
  revertDirect: unsupported,
  listComments: unsupported,
  createComment: unsupported,
  updateComment: unsupported,
  deleteComment: unsupported,
  notifications: unsupported,
  markNotificationsRead: unsupported,
  listTimeEntries: unsupported,
  listProjectTimeEntries: unsupported,
  createTimeEntry: unsupported,
  voidTimeEntry: unsupported,
  replaceTimeEntry: unsupported,
} satisfies GitPmApi;

/**
 * Builds a complete API from a checked partial double. Missing capabilities
 * fail loudly if a test unexpectedly reaches them. Prototype methods are
 * delegated as well, so stateful fixture classes remain useful.
 */
export function gitPmApi<Overrides extends Partial<GitPmApi>>(overrides: Overrides): GitPmApi & Overrides;
export function gitPmApi(overrides: Partial<GitPmApi>): GitPmApi {
  return new Proxy({ ...fallback }, {
    get(target, property, receiver) {
      const decorated = Reflect.get(target, property, receiver);
      if (decorated !== unsupported) return decorated;
      if (Reflect.has(overrides, property)) {
        const value = Reflect.get(overrides, property);
        if (Object.prototype.hasOwnProperty.call(overrides, property)) return value;
        return typeof value === "function" ? value.bind(overrides) : value;
      }
      return Reflect.get(target, property, receiver);
    },
  });
}
