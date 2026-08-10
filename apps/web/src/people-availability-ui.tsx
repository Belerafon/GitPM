import { useState } from "react";
import { ENTITY_ID_PREFIX, newUniqueEntityId } from "@gitpm/shared";
import { EditorDrawer } from "./editor-drawer.js";
import { formatDateOnly, formatNumber, type Locale, type MessageKey } from "./i18n.js";
import type { EntityResult, GitPmDocument } from "./types.js";

type Translate = (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string;

const text = (document: GitPmDocument, key: string): string => typeof document[key] === "string" ? document[key] as string : "";
const number = (document: GitPmDocument, key: string): number => typeof document[key] === "number" ? document[key] as number : 0;
const kindKey = (kind: string): MessageKey => ({
  vacation: "availability.kindVacation",
  "day-off": "availability.kindDayOff",
  "sick-leave": "availability.kindSickLeave",
  training: "availability.kindTraining",
  other: "availability.kindOther",
}[kind] ?? "availability.kindOther") as MessageKey;
const stateKey = (state: string): MessageKey => ({
  planned: "availability.statePlanned",
  taken: "availability.stateTaken",
  cancelled: "availability.stateCancelled",
}[state] ?? "availability.statePlanned") as MessageKey;

export function availabilityKindLabel(t: Translate, kind: string): string {
  return t(kindKey(kind));
}

export function PeopleAvailability({ events, locale, onCreate, onUpdate, personId, readOnly, t }: {
  readonly events: readonly EntityResult[];
  readonly locale: Locale;
  readonly onCreate: (document: GitPmDocument) => Promise<boolean>;
  readonly onUpdate: (event: EntityResult, document: GitPmDocument) => Promise<boolean>;
  readonly personId: string;
  readonly readOnly: boolean;
  readonly t: Translate;
}) {
  const [editing, setEditing] = useState<EntityResult | "new" | null>(null);
  const active = events.filter((event) => event.document.lifecycle === "active").sort((left, right) => text(left.document, "start").localeCompare(text(right.document, "start")) || left.document.id.localeCompare(right.document.id));
  const planned = active.filter((event) => text(event.document, "state") === "planned").length;
  const taken = active.filter((event) => text(event.document, "state") === "taken").length;
  const selected = editing === "new" || editing === null ? undefined : editing;
  const title = editing === "new" ? t("availability.add") : t("availability.edit");
  const save = async (form: HTMLFormElement) => {
    const data = new FormData(form);
    const note = String(data.get("note") ?? "").trim();
    const values = {
      person: personId,
      start: String(data.get("start") ?? ""),
      finish: String(data.get("finish") ?? ""),
      kind: String(data.get("kind") ?? "other"),
      availability_percent: Number(data.get("availability_percent")),
      state: String(data.get("state") ?? "planned"),
      ...(note === "" ? {} : { note_markdown: note }),
      lifecycle: "active",
    };
    const success = editing === "new"
      ? await onCreate({ schema: "gitpm/availability-event@1", id: newUniqueEntityId(ENTITY_ID_PREFIX.availability, new Set(events.map((event) => event.document.id))), ...values } as GitPmDocument)
      : selected !== undefined && await onUpdate(selected, { ...selected.document, ...values } as GitPmDocument);
    if (success) setEditing(null);
  };

  return <section className="card people-profile-section people-availability-section">
    <div className="card-heading"><div><h3>{t("availability.heading")}</h3><p>{t("availability.description")}</p></div><button className="primary" disabled={readOnly} onClick={() => setEditing("new")} type="button">{t("availability.add")}</button></div>
    <dl className="people-availability-summary"><div><dt>{t("availability.planned")}</dt><dd>{planned}</dd></div><div><dt>{t("availability.taken")}</dt><dd>{taken}</dd></div></dl>
    {active.length === 0 ? <p className="people-empty">{t("availability.empty")}</p> : <div className="people-availability-list">{active.map((event) => <button className={text(event.document, "state")} disabled={readOnly} key={event.document.id} onClick={() => setEditing(event)} type="button"><span><strong>{availabilityKindLabel(t, text(event.document, "kind"))}</strong><small>{t(stateKey(text(event.document, "state")))}</small></span><time>{t("availability.range", { start: formatDateOnly(locale, text(event.document, "start")), finish: formatDateOnly(locale, text(event.document, "finish")) })}</time><span>{t("availability.availablePercent", { percent: formatNumber(locale, number(event.document, "availability_percent")) })}</span></button>)}</div>}
    <EditorDrawer closeLabel={t("core.closeEditor")} onClose={() => setEditing(null)} open={editing !== null} title={title}>
      {editing !== null && <form className="editor-drawer-form" key={editing === "new" ? "new" : editing.document.id} onSubmit={(event) => { event.preventDefault(); void save(event.currentTarget); }}>
        <label>{t("availability.start")}<input defaultValue={selected === undefined ? "" : text(selected.document, "start")} name="start" required type="date" /></label>
        <label>{t("availability.finish")}<input defaultValue={selected === undefined ? "" : text(selected.document, "finish")} name="finish" required type="date" /></label>
        <label>{t("availability.kind")}<select defaultValue={selected === undefined ? "vacation" : text(selected.document, "kind")} name="kind"><option value="vacation">{t("availability.kindVacation")}</option><option value="day-off">{t("availability.kindDayOff")}</option><option value="sick-leave">{t("availability.kindSickLeave")}</option><option value="training">{t("availability.kindTraining")}</option><option value="other">{t("availability.kindOther")}</option></select></label>
        <label>{t("availability.percent")}<input defaultValue={selected === undefined ? 0 : number(selected.document, "availability_percent")} max="100" min="0" name="availability_percent" required step="0.25" type="number" /></label>
        <label>{t("availability.state")}<select defaultValue={selected === undefined ? "planned" : text(selected.document, "state")} name="state"><option value="planned">{t("availability.statePlanned")}</option><option value="taken">{t("availability.stateTaken")}</option><option value="cancelled">{t("availability.stateCancelled")}</option></select></label>
        <label>{t("availability.note")}<textarea defaultValue={selected === undefined ? "" : text(selected.document, "note_markdown")} name="note" rows={4} /></label>
        <div className="editor-drawer-actions"><button onClick={() => setEditing(null)} type="button">{t("core.cancel")}</button><button className="primary" disabled={readOnly}>{t("core.save")}</button></div>
      </form>}
    </EditorDrawer>
  </section>;
}
