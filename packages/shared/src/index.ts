export const GITPM_VERSION = "0.1.0";

export const ENTITY_ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const ENTITY_ID_PREFIX = {
  project: "P",
  task: "T",
  milestone: "M",
  person: "U",
  team: "G",
  calendar: "C",
  view: "V",
} as const;

export type EntityIdPrefix = typeof ENTITY_ID_PREFIX[keyof typeof ENTITY_ID_PREFIX];

export const ENTITY_ID_PATTERN = /^(?:P|T|M|U|G|C|V)-[0-9]{2}-[0-9A-HJKMNP-TV-Z]{6}$/u;
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
