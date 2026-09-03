import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { DEFAULT_PERSON_NAME_FORMAT, formatPersonName, isPersonNameFormat, type PersonNameFields, type PersonNameFormat } from "@gitpm/shared";
import type { MessageKey } from "./i18n.js";

const PersonNameFormatContext = createContext<PersonNameFormat>(DEFAULT_PERSON_NAME_FORMAT);

export function PersonNameFormatProvider({ format, children }: { readonly format: PersonNameFormat; readonly children: ReactNode }) {
  return <PersonNameFormatContext.Provider value={format}>{children}</PersonNameFormatContext.Provider>;
}

export function useDefaultPersonNameFormat(): PersonNameFormat {
  return useContext(PersonNameFormatContext);
}

export function usePersonNameFormatter(): (person: PersonNameFields | Readonly<Record<string, unknown>>) => string {
  const format = useDefaultPersonNameFormat();
  return useMemo(() => (person: PersonNameFields | Readonly<Record<string, unknown>>) => formatPersonName(person, format), [format]);
}

const formatMessageKey = (format: PersonNameFormat): MessageKey => format === "family-initials" ? "people.nameFormatFamilyInitials" : "people.nameFormatFull";

export function PersonNameEditorFields({ person = {}, defaultFormat, t }: {
  readonly person?: PersonNameFields;
  readonly defaultFormat: PersonNameFormat;
  readonly t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string;
}) {
  const [familyName, setFamilyName] = useState(typeof person.family_name === "string" ? person.family_name : "");
  const [name, setName] = useState(typeof person.name === "string" ? person.name : "");
  const [middleName, setMiddleName] = useState(typeof person.middle_name === "string" ? person.middle_name : "");
  const [override, setOverride] = useState(isPersonNameFormat(person.display_name_format) ? person.display_name_format : "");
  const effectiveFormat = isPersonNameFormat(override) ? override : defaultFormat;
  const preview = formatPersonName({ family_name: familyName, name, middle_name: middleName }, effectiveFormat);
  return <>
    <label data-field-hint={t("fieldHint.personFamilyName")}>{t("people.familyName")}<input autoComplete="family-name" name="family_name" value={familyName} onChange={(event) => setFamilyName(event.currentTarget.value)} /></label>
    <label data-field-hint={t("fieldHint.personGivenName")}>{t("admin.personName")}<input autoComplete="given-name" name="name" required value={name} onChange={(event) => setName(event.currentTarget.value)} /></label>
    <label data-field-hint={t("fieldHint.personMiddleName")}>{t("people.middleName")}<input autoComplete="additional-name" name="middle_name" value={middleName} onChange={(event) => setMiddleName(event.currentTarget.value)} /></label>
    <label data-field-hint={t("fieldHint.personNameFormat")}>{t("people.nameFormat")}<select name="display_name_format" value={override} onChange={(event) => setOverride(event.currentTarget.value as PersonNameFormat | "")}>
      <option value="">{t("people.nameFormatDefault", { format: t(formatMessageKey(defaultFormat)) })}</option>
      <option value="full">{t("people.nameFormatFull")}</option>
      <option value="family-initials">{t("people.nameFormatFamilyInitials")}</option>
    </select></label>
    <div className="person-name-preview"><span>{t("people.namePreview")}</span><strong>{preview || "—"}</strong></div>
  </>;
}
