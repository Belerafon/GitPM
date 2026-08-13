export const MAX_PROJECT_FILE_NAME_UTF16_LENGTH = 255;

export type ProjectFileNameInvalidReason =
  | "empty"
  | "path_segment"
  | "invalid_character"
  | "trailing_character"
  | "reserved_name"
  | "too_long";

const WINDOWS_INVALID_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f]/u;
const WINDOWS_RESERVED_DEVICE_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9\u00b9\u00b2\u00b3]|LPT[1-9\u00b9\u00b2\u00b3])(?:\..*)?$/iu;

/**
 * Validates one flat Project file name against the portable subset supported by
 * ordinary Windows filesystems. The value must be a name, never a path.
 */
export function projectFileNameInvalidReason(name: string): ProjectFileNameInvalidReason | undefined {
  if (name.length === 0) return "empty";
  if (name === "." || name === "..") return "path_segment";
  if (name.length > MAX_PROJECT_FILE_NAME_UTF16_LENGTH) return "too_long";
  if (WINDOWS_INVALID_CHARACTERS.test(name)) return "invalid_character";
  if (/[ .]$/u.test(name)) return "trailing_character";
  if (WINDOWS_RESERVED_DEVICE_NAME.test(name)) return "reserved_name";
  return undefined;
}

/** Returns the cross-platform key used to enforce case-insensitive uniqueness. */
export function projectFileNameComparisonKey(name: string): string {
  return name.toLowerCase();
}
