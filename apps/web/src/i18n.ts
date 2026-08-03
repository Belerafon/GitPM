import en from "./locales/en.json";
import ru from "./locales/ru.json";

export type Locale = string;
export type MessageKey = keyof typeof en;
export type MessagePack = Record<MessageKey, string>;

export interface LocaleDefinition {
  readonly languageTag: string;
  readonly direction: "ltr" | "rtl";
  readonly labelKey: MessageKey;
  readonly messages: MessagePack;
}

export const LOCALE_STORAGE_KEY = "gitpm.locale";
export const localeRegistry: Record<Locale, LocaleDefinition> & { en: LocaleDefinition; ru: LocaleDefinition } = {
  en: { languageTag: "en", direction: "ltr", labelKey: "locale.en", messages: en },
  ru: { languageTag: "ru", direction: "ltr", labelKey: "locale.ru", messages: ru },
};

function localeDefinition(locale: Locale): LocaleDefinition {
  return localeRegistry[locale] ?? localeRegistry.en;
}

export function registerLocale(locale: string, definition: LocaleDefinition): () => void {
  const normalized = locale.toLowerCase().split("-")[0] ?? "";
  if (!/^[a-z]{2,8}$/u.test(normalized) || normalized === "en") throw new Error(`Invalid locale key: ${locale}`);
  const previous = localeRegistry[normalized];
  assertLocalePacks({ en: localeRegistry.en, [normalized]: definition });
  localeRegistry[normalized] = definition;
  return () => {
    if (previous === undefined) delete localeRegistry[normalized];
    else localeRegistry[normalized] = previous;
  };
}

export function assertLocalePacks(registry: Readonly<Record<string, LocaleDefinition>> = localeRegistry): void {
  const sourceKeys = Object.keys(localeRegistry.en.messages).sort();
  const placeholders = (value: string): string[] => [...value.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/gu)].map((match) => match[1] ?? "").sort();
  for (const [locale, definition] of Object.entries(registry)) {
    const keys = Object.keys(definition.messages).sort();
    if (JSON.stringify(keys) !== JSON.stringify(sourceKeys)) throw new Error(`Locale ${locale} message keys do not match en`);
    for (const key of sourceKeys) {
      const typedKey = key as MessageKey;
      if (/[<>]/u.test(definition.messages[typedKey])) throw new Error(`Locale ${locale} message ${key} contains HTML`);
      if (JSON.stringify(placeholders(definition.messages[typedKey])) !== JSON.stringify(placeholders(localeRegistry.en.messages[typedKey]))) {
        throw new Error(`Locale ${locale} message ${key} placeholders do not match en`);
      }
    }
  }
}

export function selectLocale(stored: string | null, browserLanguages: readonly string[], serverDefault = "ru"): Locale {
  const candidates = [stored, ...browserLanguages, serverDefault, "en"];
  for (const candidate of candidates) {
    const normalized = candidate?.toLowerCase().split("-")[0];
    if (normalized !== undefined && localeRegistry[normalized] !== undefined) return normalized;
  }
  return "en";
}

export function message(locale: Locale, key: MessageKey, values: Readonly<Record<string, string | number>> = {}): string {
  return localeDefinition(locale).messages[key].replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/gu, (_whole, name: string) => String(values[name] ?? `{${name}}`));
}

export function formatDateTime(locale: Locale, value: string): string {
  return new Intl.DateTimeFormat(localeDefinition(locale).languageTag, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(value));
}

export function formatDateOnly(locale: Locale, value: string): string {
  return new Intl.DateTimeFormat(localeDefinition(locale).languageTag, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${value}T00:00:00.000Z`));
}

export function formatNumber(locale: Locale, value: number): string {
  return new Intl.NumberFormat(localeDefinition(locale).languageTag, { maximumFractionDigits: 2 }).format(value);
}

export function formatDurationHours(locale: Locale, hours: number): string {
  return new Intl.NumberFormat(localeDefinition(locale).languageTag, { style: "unit", unit: "hour", unitDisplay: "long", maximumFractionDigits: 2 }).format(hours);
}

export function pluralCategory(locale: Locale, value: number): Intl.LDMLPluralRule {
  return new Intl.PluralRules(localeDefinition(locale).languageTag).select(value);
}

/**
 * Day unit declined for the locale and count, read from the `snapshot.dayUnit.*` plural keys.
 * Russian declines through день/дня/дней; English collapses to day/days. Used by the schedule
 * variance label so Russian never shows the abbreviated "+20 дн." form.
 */
export function dayUnit(locale: Locale, count: number): string {
  const messages = localeDefinition(locale).messages;
  const key = `snapshot.dayUnit.${pluralCategory(locale, count)}` as MessageKey;
  return messages[key] ?? "days";
}

/**
 * Render a finish-variance in days as a locale-correct signed string ("+1 день", "+2 дня",
 * "+5 дней", "-3 дня", "+20 days"). Zero collapses to the localized "on schedule" message.
 * The sign is mathematical and locale-neutral; only the day unit is localized and declined.
 */
export function formatVarianceDays(locale: Locale, days: number): string {
  if (days === 0) return message(locale, "snapshot.onTime");
  const sign = days > 0 ? "+" : "-";
  return `${sign}${Math.abs(days)} ${dayUnit(locale, Math.abs(days))}`;
}
