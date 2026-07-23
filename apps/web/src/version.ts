declare const __GITPM_BUILD_VERSION__: string | undefined;
declare const __GITPM_BUILD_COMMIT__: string | undefined;
declare const __GITPM_BUILD_COMMIT_DATE__: string | undefined;

const DEV_FALLBACK = "dev";

// `typeof` guards must wrap each global directly so the reference is never
// evaluated when the Vite `define` replacement is absent (tests, local REPL).
const rawVersion = typeof __GITPM_BUILD_VERSION__ === "string" ? __GITPM_BUILD_VERSION__ : "";
const rawCommit = typeof __GITPM_BUILD_COMMIT__ === "string" ? __GITPM_BUILD_COMMIT__ : "";
const rawCommitDate = typeof __GITPM_BUILD_COMMIT_DATE__ === "string" ? __GITPM_BUILD_COMMIT_DATE__ : "";

/**
 * Build version derived from the current Git commit's author date (UTC), e.g.
 * `0.1.0+20260723.1045.eb7f057`. Inlined at build time by Vite `define`.
 * Falls back to `dev` when the build metadata is absent (tests, local REPL).
 */
export const BUILD_VERSION = rawVersion.length > 0 ? rawVersion : DEV_FALLBACK;
export const BUILD_COMMIT = rawCommit.length > 0 ? rawCommit : DEV_FALLBACK;
export const BUILD_COMMIT_DATE = rawCommitDate;
