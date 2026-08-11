import { useMemo, useState } from "react";
import { EditorDrawer } from "./editor-drawer.js";
import type { Locale, MessageKey } from "./i18n.js";
import {
  countViewConditions, emptyViewQuery, newViewNodeId, operatorsFor, removeViewFilterNode,
  type AdvancedViewQuery, type ViewField, type ViewFilterCondition, type ViewFilterGroup, type ViewFilterNode, type ViewFilterOperator,
} from "./advanced-view-query.js";

type Translator = (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string;

interface QuickViewPreset {
  readonly id: string;
  readonly label: string;
  readonly query: AdvancedViewQuery;
}

export function AdvancedViewControls<Row>({ fields, locale, query, onChange, resultCount, totalCount, t }: {
  readonly fields: readonly ViewField<Row>[];
  readonly locale: Locale;
  readonly query: AdvancedViewQuery;
  readonly onChange: (query: AdvancedViewQuery) => void;
  readonly resultCount: number;
  readonly totalCount: number;
  readonly t: Translator;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<AdvancedViewQuery>(query);
  const conditions = useMemo(() => flattenConditions(query.filter), [query.filter]);
  const fieldMap = new Map(fields.map((field) => [field.id, field]));
  const presets = useMemo(() => quickViewPresets(fields, t), [fields, t]);
  const clear = () => onChange(emptyViewQuery());
  const openEditor = () => { setDraft(query); setOpen(true); };
  const applyPreset = (preset: QuickViewPreset) => { onChange(preset.query); setDraft(preset.query); setOpen(false); };
  return <>
    <div className="advanced-view-bar">
      <div className="advanced-view-main">
        <button aria-expanded={open} className="advanced-view-trigger" onClick={openEditor} type="button">{t("advancedView.open")} {countViewConditions(query.filter) + query.sort.length > 0 && <span>{countViewConditions(query.filter) + query.sort.length}</span>}</button>
        <div className="advanced-view-chips" aria-live="polite">
          {conditions.map((condition) => <span className="filter-chip" key={condition.id}>{conditionLabel(condition, fieldMap, locale, t)}<button aria-label={t("advancedView.removeFilter", { filter: conditionLabel(condition, fieldMap, locale, t) })} onClick={() => onChange({ ...query, filter: removeViewFilterNode(query.filter, condition.id) })} type="button">×</button></span>)}
          {query.sort.map((rule) => <span className="filter-chip sort-chip" key={rule.id}>{fieldMap.get(rule.field)?.label ?? rule.field} · {t(rule.direction === "asc" ? "advancedView.ascendingShort" : "advancedView.descendingShort")}<button aria-label={t("advancedView.removeSort", { field: fieldMap.get(rule.field)?.label ?? rule.field })} onClick={() => onChange({ ...query, sort: query.sort.filter((candidate) => candidate.id !== rule.id) })} type="button">×</button></span>)}
          {(conditions.length > 0 || query.sort.length > 0) && <button className="advanced-view-clear" onClick={clear} type="button">{t("advancedView.clear")}</button>}
        </div>
      </div>
      <small>{t("advancedView.resultCount", { visible: resultCount, total: totalCount })}</small>
    </div>
    <EditorDrawer closeLabel={t("core.closeEditor")} onClose={() => setOpen(false)} open={open} title={t("advancedView.title")}>
      <form className="editor-drawer-form advanced-view-form" onSubmit={(event) => { event.preventDefault(); onChange(draft); setOpen(false); }}>
        <section className="advanced-view-presets"><h3>{t("advancedView.quickPresets")}</h3><div aria-label={t("advancedView.quickPresets")} role="group">{presets.map((preset) => <button key={preset.id} onClick={() => applyPreset(preset)} type="button">{preset.label}</button>)}</div></section>
        <details className="advanced-view-custom">
          <summary>{t("advancedView.customSetup")}</summary>
          <div>
            <section><header><h3>{t("advancedView.sorting")}</h3><button onClick={() => { const field = fields.find((candidate) => candidate.sortable !== false); if (field !== undefined) setDraft((current) => ({ ...current, sort: [...current.sort, { id: newViewNodeId("sort"), field: field.id, direction: "asc" }] })); }} type="button">+ {t("advancedView.addSort")}</button></header>
              <div className="advanced-sort-rules">{draft.sort.map((rule, index) => <div className="advanced-sort-rule" key={rule.id}><span>{index + 1}</span><select aria-label={t("advancedView.sortField", { number: index + 1 })} onChange={(event) => setDraft((current) => ({ ...current, sort: current.sort.map((candidate) => candidate.id === rule.id ? { ...candidate, field: event.target.value } : candidate) }))} value={rule.field}>{fields.filter((field) => field.sortable !== false).map((field) => <option key={field.id} value={field.id}>{field.label}</option>)}</select><select aria-label={t("advancedView.direction", { number: index + 1 })} onChange={(event) => setDraft((current) => ({ ...current, sort: current.sort.map((candidate) => candidate.id === rule.id ? { ...candidate, direction: event.target.value as "asc" | "desc" } : candidate) }))} value={rule.direction}><option value="asc">{t("advancedView.ascending")}</option><option value="desc">{t("advancedView.descending")}</option></select><button aria-label={t("advancedView.removeSort", { field: fieldMap.get(rule.field)?.label ?? rule.field })} onClick={() => setDraft((current) => ({ ...current, sort: current.sort.filter((candidate) => candidate.id !== rule.id) }))} type="button">×</button></div>)}</div>
            </section>
            <section><header><h3>{t("advancedView.filters")}</h3></header><FilterGroupEditor fields={fields} group={draft.filter} locale={locale} root onChange={(filter) => setDraft((current) => ({ ...current, filter }))} t={t} /></section>
          </div>
        </details>
        <div className="editor-drawer-actions"><button onClick={() => { setDraft(emptyViewQuery()); }} type="button">{t("advancedView.clear")}</button><button onClick={() => setOpen(false)} type="button">{t("core.cancel")}</button><button className="primary" type="submit">{t("advancedView.apply")}</button></div>
      </form>
    </EditorDrawer>
  </>;
}

function FilterGroupEditor<Row>({ fields, group, locale, root = false, onChange, onRemove, t }: { readonly fields: readonly ViewField<Row>[]; readonly group: ViewFilterGroup; readonly locale: Locale; readonly root?: boolean; readonly onChange: (group: ViewFilterGroup) => void; readonly onRemove?: () => void; readonly t: Translator }) {
  const firstField = fields[0];
  const addCondition = () => { if (firstField !== undefined) onChange({ ...group, children: [...group.children, { kind: "condition", id: newViewNodeId("condition"), field: firstField.id, operator: operatorsFor(firstField.type)[0]!, value: "" }] }); };
  const addGroup = () => onChange({ ...group, children: [...group.children, { kind: "group", id: newViewNodeId("group"), combinator: "and", children: [] }] });
  const replaceChild = (next: ViewFilterNode) => onChange({ ...group, children: group.children.map((child) => child.id === next.id ? next : child) });
  return <fieldset className={`advanced-filter-group${root ? " root" : ""}`}><legend>{root ? t("advancedView.allConditions") : t("advancedView.nestedGroup")}</legend><div className="advanced-filter-group-heading"><label>{t("advancedView.combineWith")}<select value={group.combinator} onChange={(event) => onChange({ ...group, combinator: event.target.value as "and" | "or" })}><option value="and">{t("advancedView.and")}</option><option value="or">{t("advancedView.or")}</option></select></label>{!root && <button aria-label={t("advancedView.removeGroup")} onClick={onRemove} type="button">×</button>}</div>
    <div className="advanced-filter-children">{group.children.map((child) => child.kind === "group" ? <FilterGroupEditor fields={fields} group={child} key={child.id} locale={locale} onChange={replaceChild} onRemove={() => onChange({ ...group, children: group.children.filter((candidate) => candidate.id !== child.id) })} t={t} /> : <FilterConditionEditor condition={child} fields={fields} key={child.id} locale={locale} onChange={replaceChild} onRemove={() => onChange({ ...group, children: group.children.filter((candidate) => candidate.id !== child.id) })} t={t} />)}</div>
    {group.children.length === 0 && <p className="advanced-filter-empty">{t("advancedView.noConditions")}</p>}<div className="advanced-filter-add"><button onClick={addCondition} type="button">+ {t("advancedView.addCondition")}</button><button onClick={addGroup} type="button">+ {t("advancedView.addGroup")}</button></div>
  </fieldset>;
}

function FilterConditionEditor<Row>({ condition, fields, locale, onChange, onRemove, t }: { readonly condition: ViewFilterCondition; readonly fields: readonly ViewField<Row>[]; readonly locale: Locale; readonly onChange: (condition: ViewFilterCondition) => void; readonly onRemove: () => void; readonly t: Translator }) {
  const field = fields.find((candidate) => candidate.id === condition.field) ?? fields[0];
  if (field === undefined) return null;
  const operators = operatorsFor(field.type);
  const noValue = ["is-empty", "is-not-empty", "is-true", "is-false"].includes(condition.operator);
  const inputType = field.type === "date" ? "date" : field.type === "number" ? "number" : "text";
  const setField = (fieldId: string) => { const next = fields.find((candidate) => candidate.id === fieldId)!; onChange({ kind: "condition", id: condition.id, field: fieldId, operator: operatorsFor(next.type)[0]!, value: "" }); };
  const valueInput = (suffix: "value" | "valueTo") => field.options !== undefined ? <select aria-label={t(suffix === "value" ? "advancedView.value" : "advancedView.valueTo")} onChange={(event) => onChange({ ...condition, [suffix]: event.target.value })} value={condition[suffix] ?? ""}><option value="">{t("advancedView.selectValue")}</option>{field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select> : <input aria-label={t(suffix === "value" ? "advancedView.value" : "advancedView.valueTo")} onChange={(event) => onChange({ ...condition, [suffix]: event.target.value })} type={inputType} value={condition[suffix] ?? ""} />;
  return <div className="advanced-filter-condition"><select aria-label={t("advancedView.field")} onChange={(event) => setField(event.target.value)} value={field.id}>{fields.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}</select><select aria-label={t("advancedView.operator")} onChange={(event) => onChange({ ...condition, operator: event.target.value as ViewFilterOperator })} value={condition.operator}>{operators.map((operator) => <option key={operator} value={operator}>{operatorLabel(operator, t)}</option>)}</select>{!noValue && valueInput("value")}{condition.operator === "between" && valueInput("valueTo")}<button aria-label={t("advancedView.removeCondition")} onClick={onRemove} type="button">×</button></div>;
}

const flattenConditions = (node: ViewFilterNode): ViewFilterCondition[] => node.kind === "condition" ? [node] : node.children.flatMap(flattenConditions);
const sortPreset = <Row,>(field: ViewField<Row>, direction: "asc" | "desc"): AdvancedViewQuery => ({
  ...emptyViewQuery(),
  sort: [{ id: newViewNodeId("sort"), field: field.id, direction }],
});
const filterPreset = <Row,>(field: ViewField<Row>, operator: ViewFilterOperator, value?: string, direction?: "asc" | "desc"): AdvancedViewQuery => ({
  filter: { kind: "group", id: newViewNodeId("group"), combinator: "and", children: [{ kind: "condition", id: newViewNodeId("condition"), field: field.id, operator, ...(value === undefined ? {} : { value }) }] },
  sort: direction === undefined ? [] : [{ id: newViewNodeId("sort"), field: field.id, direction }],
});
function quickViewPresets<Row>(fields: readonly ViewField<Row>[], t: Translator): readonly QuickViewPreset[] {
  const primary = fields.find((field) => field.id === "name" || field.id === "title") ?? fields.find((field) => field.type === "text" && field.id !== "id");
  const date = fields.find((field) => field.id === "due") ?? fields.find((field) => field.type === "date");
  const boolean = fields.find((field) => field.id === "overdue") ?? fields.find((field) => field.type === "boolean");
  const number = fields.find((field) => field.type === "number");
  const lifecycle = fields.find((field) => field.id === "lifecycle" && field.options?.some((option) => option.value === "active"));
  const presets: QuickViewPreset[] = [];
  if (primary !== undefined) {
    presets.push({ id: "primary-asc", label: t("advancedView.presetAlphabetical", { field: primary.label }), query: sortPreset(primary, "asc") });
    presets.push({ id: "primary-desc", label: t("advancedView.presetReverseAlphabetical", { field: primary.label }), query: sortPreset(primary, "desc") });
  }
  if (date !== undefined) presets.push({ id: "date-asc", label: t("advancedView.presetEarliest", { field: date.label }), query: filterPreset(date, "is-not-empty", undefined, "asc") });
  else if (number !== undefined) presets.push({ id: "number-desc", label: t("advancedView.presetLargest", { field: number.label }), query: sortPreset(number, "desc") });
  if (boolean !== undefined) presets.push({ id: "boolean-true", label: boolean.label, query: filterPreset(boolean, "is-true") });
  else if (lifecycle !== undefined) presets.push({ id: "lifecycle-active", label: t("advancedView.presetActive"), query: filterPreset(lifecycle, "equals", "active") });
  else if (number !== undefined && !presets.some((preset) => preset.id === "number-desc")) presets.push({ id: "number-desc", label: t("advancedView.presetLargest", { field: number.label }), query: sortPreset(number, "desc") });
  return presets.slice(0, 4);
}
const optionLabel = <Row,>(field: ViewField<Row> | undefined, value: string): string => field?.options?.find((option) => option.value === value)?.label ?? value;
function conditionLabel<Row>(condition: ViewFilterCondition, fields: ReadonlyMap<string, ViewField<Row>>, locale: Locale, t: Translator): string {
  const field = fields.get(condition.field); const value = optionLabel(field, condition.value ?? ""); const second = optionLabel(field, condition.valueTo ?? "");
  return `${field?.label ?? condition.field} ${operatorLabel(condition.operator, t).toLocaleLowerCase(locale)}${["is-empty", "is-not-empty", "is-true", "is-false"].includes(condition.operator) ? "" : ` ${value}${condition.operator === "between" ? ` — ${second}` : ""}`}`;
}
function operatorLabel(operator: ViewFilterOperator, t: Translator): string { return t(`advancedView.operator.${operator}` as MessageKey); }
