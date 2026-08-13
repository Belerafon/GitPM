export const PROJECT_FILE_REFERENCE_PREFIX = "[[file:";

export interface ProjectFileReferenceTextToken {
  readonly kind: "text";
  readonly value: string;
  /** UTF-16 offsets into the unchanged source string. */
  readonly start: number;
  readonly end: number;
}

export interface ProjectFileReferenceToken {
  readonly kind: "file_reference";
  /** Decoded, exact and case-sensitive Project file name. */
  readonly name: string;
  /** The unchanged source spelling, including delimiters and escapes. */
  readonly raw: string;
  /** UTF-16 offsets into the unchanged source string. */
  readonly start: number;
  readonly end: number;
}

export type ProjectFileReferenceSegment = ProjectFileReferenceTextToken | ProjectFileReferenceToken;
export type ProjectFileReferenceResolution = "existing" | "missing";

function isEscapedOpener(source: string, opener: number): boolean {
  let backslashes = 0;
  for (let index = opener - 1; index >= 0 && source[index] === "\\"; index -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

function appendText(
  result: ProjectFileReferenceSegment[],
  source: string,
  start: number,
  end: number,
): void {
  if (end <= start) return;
  const previous = result.at(-1);
  if (previous?.kind === "text" && previous.end === start) {
    result[result.length - 1] = { kind: "text", value: previous.value + source.slice(start, end), start: previous.start, end };
    return;
  }
  result.push({ kind: "text", value: source.slice(start, end), start, end });
}

/**
 * Tokenizes only GitPM Project file references. It does not parse Markdown or
 * produce HTML/URLs. Malformed candidates remain unchanged text.
 *
 * Inside a reference, `\\\\`, `\\[`, and `\\]` decode to `\\`, `[`, and `]`.
 * An unknown escape, control character, unescaped `]`, empty name, or nested
 * `[[file:` makes the whole candidate plain text.
 */
export function tokenizeProjectFileReferences(source: string): readonly ProjectFileReferenceSegment[] {
  const result: ProjectFileReferenceSegment[] = [];
  let textStart = 0;
  let searchFrom = 0;

  while (searchFrom < source.length) {
    const opener = source.indexOf(PROJECT_FILE_REFERENCE_PREFIX, searchFrom);
    if (opener < 0) break;
    if (isEscapedOpener(source, opener)) {
      searchFrom = opener + PROJECT_FILE_REFERENCE_PREFIX.length;
      continue;
    }

    let cursor = opener + PROJECT_FILE_REFERENCE_PREFIX.length;
    let decoded = "";
    let valid = true;
    let closer = -1;
    while (cursor < source.length) {
      if (source.startsWith("]]", cursor)) {
        closer = cursor;
        break;
      }
      if (source.startsWith(PROJECT_FILE_REFERENCE_PREFIX, cursor)) {
        valid = false;
        cursor += PROJECT_FILE_REFERENCE_PREFIX.length;
        continue;
      }
      const character = source[cursor]!;
      if (character === "\\") {
        const escaped = source[cursor + 1];
        if (escaped === "\\" || escaped === "[" || escaped === "]") {
          decoded += escaped;
          cursor += 2;
          continue;
        }
        valid = false;
        cursor += escaped === undefined ? 1 : 2;
        continue;
      }
      if (character === "]" || character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f) valid = false;
      decoded += character;
      cursor += 1;
    }

    if (closer < 0) break;
    const end = closer + 2;
    if (valid && decoded.length > 0) {
      appendText(result, source, textStart, opener);
      result.push({ kind: "file_reference", name: decoded, raw: source.slice(opener, end), start: opener, end });
      textStart = end;
    }
    searchFrom = end;
  }

  appendText(result, source, textStart, source.length);
  return result;
}

/**
 * Creates the canonical lexical spelling for one name. This function does not
 * validate that the name exists or is permitted by the Project storage format.
 */
export function formatProjectFileReference(name: string): string {
  if (name.length === 0 || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new TypeError("Project file reference name must be non-empty text without control characters");
  }
  const escaped = name.replace(/\\/gu, "\\\\").replace(/\[/gu, "\\[").replace(/\]/gu, "\\]");
  return `${PROJECT_FILE_REFERENCE_PREFIX}${escaped}]]`;
}

/** Resolves by exact name within the caller-provided current Project file list. */
export function resolveProjectFileReference(
  name: string,
  currentProjectFileNames: readonly string[],
): ProjectFileReferenceResolution {
  return currentProjectFileNames.some((candidate) => candidate === name) ? "existing" : "missing";
}
