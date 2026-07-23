declare const __GITPM_BUILD_VERSION__: string | undefined;

const UNAVAILABLE = "—";

// `typeof` must wrap the global directly so the reference is never evaluated
// when the Vite `define` replacement is absent (tests, local REPL).
const rawVersion = typeof __GITPM_BUILD_VERSION__ === "string" ? __GITPM_BUILD_VERSION__ : "";

/**
 * Build version (`YYYY.MM.DD HHMM`) captured from the current Git commit into
 * `build-version.json`. Inlined at build time by Vite `define`. Shown as `—`
 * when no version was captured (tests, local REPL, unbuilt contexts).
 */
export const BUILD_VERSION = rawVersion.length > 0 ? rawVersion : UNAVAILABLE;
