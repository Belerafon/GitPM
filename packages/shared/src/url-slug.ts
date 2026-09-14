const ENTITY_ID_AT_START = /^(?:P|T|M|U|G|C|V|N|E|A)-[0-9]{2}-[0-9A-HJKMNP-TV-Z]{6}/u;
const ENTITY_ID_EXACT = /^(?:P|T|M|U|G|C|V|N|E|A)-[0-9]{2}-[0-9A-HJKMNP-TV-Z]{6}$/u;
const COMBINING_MARKS = /\p{M}+/gu;
const NON_SLUG_CHARS = /[^a-z0-9]+/gu;

const CYRILLIC_TO_LATIN: Readonly<Record<string, string>> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z",
  и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
  с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch",
  ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
  є: "ie", і: "i", ї: "i", ґ: "g",
};

export const ENTITY_URL_SLUG_MAX_LENGTH = 60;

export function slugifyEntityLabel(value: string, maxLength = ENTITY_URL_SLUG_MAX_LENGTH): string {
  let transliterated = "";
  for (const char of value.normalize("NFKC").trim().toLowerCase()) {
    transliterated += CYRILLIC_TO_LATIN[char] ?? char;
  }
  const slug = transliterated.normalize("NFKD").replace(COMBINING_MARKS, "").replace(NON_SLUG_CHARS, "-").replace(/^-+|-+$/gu, "");
  if (slug.length <= maxLength) return slug;
  const truncated = slug.slice(0, maxLength);
  const lastHyphen = truncated.lastIndexOf("-");
  return (lastHyphen >= 20 ? truncated.slice(0, lastHyphen) : truncated).replace(/-+$/u, "");
}

export function entityUrlSegment(id: string, label?: string): string {
  if (!ENTITY_ID_EXACT.test(id) || label === undefined || label === "" || label === id) return id;
  const slug = slugifyEntityLabel(label);
  return slug === "" ? id : `${id}-${slug}`;
}

export function entityIdFromSegment(segment: string): string {
  const match = ENTITY_ID_AT_START.exec(segment);
  if (match === null) return segment;
  const id = match[0]!;
  const rest = segment.slice(id.length);
  return rest === "" || rest.startsWith("-") ? id : segment;
}
