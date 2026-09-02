export const GITPM_VERSION = "0.1.0";

export const PERSON_NAME_FORMATS = ["full", "family-initials"] as const;
export type PersonNameFormat = (typeof PERSON_NAME_FORMATS)[number];
export const DEFAULT_PERSON_NAME_FORMAT: PersonNameFormat = "full";

export interface PersonNameFields {
  readonly name?: unknown;
  readonly family_name?: unknown;
  readonly middle_name?: unknown;
  readonly display_name_format?: unknown;
}

export function isPersonNameFormat(value: unknown): value is PersonNameFormat {
  return typeof value === "string" && (PERSON_NAME_FORMATS as readonly string[]).includes(value);
}

const normalizedNamePart = (value: unknown): string => typeof value === "string" ? value.trim().replaceAll(/\s+/gu, " ") : "";
const initial = (value: string): string => value === "" ? "" : `${Array.from(value)[0]}.`;

/** Builds the only employee label used by UI, search, planning and exports. */
export function formatPersonName(person: PersonNameFields | Readonly<Record<string, unknown>>, defaultFormat: PersonNameFormat = DEFAULT_PERSON_NAME_FORMAT): string {
  const fields = person as Readonly<Record<string, unknown>>;
  const name = normalizedNamePart(fields.name);
  const familyName = normalizedNamePart(fields.family_name);
  const middleName = normalizedNamePart(fields.middle_name);
  const format = isPersonNameFormat(fields.display_name_format) ? fields.display_name_format : defaultFormat;
  if (format === "family-initials" && familyName !== "") {
    return [familyName, [initial(name), initial(middleName)].filter(Boolean).join(" ")].filter(Boolean).join(" ");
  }
  return [familyName, name, middleName].filter(Boolean).join(" ");
}

export function personNameSearchText(person: PersonNameFields | Readonly<Record<string, unknown>>, defaultFormat: PersonNameFormat = DEFAULT_PERSON_NAME_FORMAT): string {
  const fields = person as Readonly<Record<string, unknown>>;
  return [formatPersonName(fields, defaultFormat), normalizedNamePart(fields.family_name), normalizedNamePart(fields.name), normalizedNamePart(fields.middle_name)]
    .filter(Boolean)
    .join(" ");
}

export * from "./project-file-references.js";

export const ENTITY_ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const ENTITY_ID_PREFIX = {
  project: "P",
  task: "T",
  milestone: "M",
  person: "U",
  team: "G",
  calendar: "C",
  view: "V",
  comment: "N",
  entry: "E",
  availability: "A",
} as const;

export type EntityIdPrefix = typeof ENTITY_ID_PREFIX[keyof typeof ENTITY_ID_PREFIX];

export const ENTITY_ID_PATTERN = /^(?:P|T|M|U|G|C|V|N|E|A)-[0-9]{2}-[0-9A-HJKMNP-TV-Z]{6}$/u;
export const PROJECT_ID_PATTERN = /^P-[0-9]{2}-[0-9A-HJKMNP-TV-Z]{6}$/u;

export const isEntityId = (value: string, prefix?: EntityIdPrefix): boolean => (
  ENTITY_ID_PATTERN.test(value) && (prefix === undefined || value.startsWith(`${prefix}-`))
);

const secureRandomIndex = (): number => {
  const values = new Uint32Array(1);
  globalThis.crypto.getRandomValues(values);
  return (values[0] ?? 0) & 31;
};

export function newEntityId(
  prefix: EntityIdPrefix,
  randomIndex: () => number = secureRandomIndex,
  now: Date = new Date(),
): string {
  const year = now.getUTCFullYear();
  if (!Number.isInteger(year) || year < 2000 || year > 2099) {
    throw new RangeError("Entity ID year must be between 2000 and 2099");
  }
  let body = "";
  for (let index = 0; index < 6; index += 1) {
    const value = randomIndex();
    if (!Number.isInteger(value) || value < 0 || value >= ENTITY_ID_ALPHABET.length) {
      throw new RangeError("Entity ID random index must be an integer between 0 and 31");
    }
    body += ENTITY_ID_ALPHABET[value];
  }
  return `${prefix}-${String(year).slice(-2)}-${body}`;
}

export function newUniqueEntityId(
  prefix: EntityIdPrefix,
  existingIds: ReadonlySet<string>,
  randomIndex?: () => number,
  now?: Date,
): string {
  for (let attempt = 0; attempt < 128; attempt += 1) {
    const id = newEntityId(prefix, randomIndex, now);
    if (!existingIds.has(id)) return id;
  }
  throw new Error("Unable to generate a unique entity ID after 128 attempts");
}

export interface HealthPayload {
  correlation_id: string;
  status: "ok" | "not_ready";
}

export const REPOSITORY_MODES = ["direct", "worktree"] as const;
export type RepositoryMode = (typeof REPOSITORY_MODES)[number];
export const DEFAULT_REPOSITORY_MODE: RepositoryMode = "direct";
export const REPOSITORY_MODE_ENV = "GITPM_REPOSITORY_MODE";

const lifecycleField = (document: object, field: "id" | "lifecycle" | "project"): unknown => (
  (document as Readonly<Record<string, unknown>>)[field]
);

export function activeProjectIds(projects: readonly object[]): ReadonlySet<string> {
  return new Set(projects.flatMap((project) => (
    lifecycleField(project, "lifecycle") === "active" && typeof lifecycleField(project, "id") === "string"
      ? [lifecycleField(project, "id") as string]
      : []
  )));
}

/**
 * A Task is operational only while both it and its owning Project are active.
 * Keep this predicate at the shared read-model boundary so UI, exports and
 * workload calculations cannot silently disagree about effective lifecycle.
 */
export function isOperationalTask(
  task: object,
  operationalProjects: ReadonlySet<string>,
): boolean {
  const project = lifecycleField(task, "project");
  return lifecycleField(task, "lifecycle") === "active"
    && typeof project === "string"
    && operationalProjects.has(project);
}

export class RepositoryModeError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "RepositoryModeError";
  }
}

export function isRepositoryMode(value: unknown): value is RepositoryMode {
  return typeof value === "string" && (REPOSITORY_MODES as readonly string[]).includes(value);
}

/**
 * Resolve the GitPM repository mode. The environment variable always wins over
 * the configuration file. Unknown non-empty values are rejected with a stable
 * error; an empty/unset value falls back to {@link DEFAULT_REPOSITORY_MODE}.
 */
export function resolveRepositoryMode(options: {
  readonly configValue?: unknown;
  readonly envValue?: string;
}): RepositoryMode {
  const env = options.envValue?.trim();
  if (env !== undefined && env !== "") {
    if (!isRepositoryMode(env)) {
      throw new RepositoryModeError(
        "REPOSITORY_MODE_UNKNOWN",
        `Unknown repository mode "${env}". Expected one of: ${REPOSITORY_MODES.join(", ")}.`,
      );
    }
    return env;
  }
  if (options.configValue === undefined || options.configValue === null) return DEFAULT_REPOSITORY_MODE;
  if (!isRepositoryMode(options.configValue)) {
    throw new RepositoryModeError(
      "REPOSITORY_MODE_UNKNOWN",
      `Unknown repository mode "${String(options.configValue)}". Expected one of: ${REPOSITORY_MODES.join(", ")}.`,
    );
  }
  return options.configValue;
}
