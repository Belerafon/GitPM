import en from "./locales/en.json";
import ru from "./locales/ru.json";

export type Locale = "en" | "ru";
export type MessageKey = keyof typeof en;
export type MessagePack = Record<MessageKey, string>;

export interface LocaleDefinition {
  readonly languageTag: string;
  readonly direction: "ltr" | "rtl";
  readonly labelKey: MessageKey;
  readonly messages: MessagePack;
}

export const LOCALE_STORAGE_KEY = "gitpm.locale";
export const localeRegistry: Readonly<Record<Locale, LocaleDefinition>> = {
  en: { languageTag: "en", direction: "ltr", labelKey: "locale.en", messages: en },
  ru: { languageTag: "ru", direction: "ltr", labelKey: "locale.ru", messages: ru },
};

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
    if (normalized === "en" || normalized === "ru") return normalized;
  }
  return "en";
}

export function message(locale: Locale, key: MessageKey, values: Readonly<Record<string, string | number>> = {}): string {
  return localeRegistry[locale].messages[key].replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/gu, (_whole, name: string) => String(values[name] ?? `{${name}}`));
}

export function formatDateTime(locale: Locale, value: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(value));
}
