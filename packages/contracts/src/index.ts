export type JsonRecord = Readonly<Record<string, unknown>>;
export type Lifecycle = "active" | "archived";

export const ENTITY_DOCUMENT_SCHEMAS = [
  "gitpm/project@1",
  "gitpm/task@1",
  "gitpm/milestone@1",
  "gitpm/person@1",
  "gitpm/team@1",
  "gitpm/calendar@1",
  "gitpm/saved-view@1",
] as const;

export type EntityDocumentSchema = (typeof ENTITY_DOCUMENT_SCHEMAS)[number];
export type EntityDocumentFor<Schema extends EntityDocumentSchema> = JsonRecord & {
  readonly schema: Schema;
  readonly id: string;
  readonly lifecycle: Lifecycle;
};
export type EntityDocument = {
  readonly [Schema in EntityDocumentSchema]: EntityDocumentFor<Schema>;
}[EntityDocumentSchema];

export interface StatusValue extends JsonRecord {
  readonly slug: string;
  readonly title: string;
  readonly active: boolean;
  readonly color?: string;
}

export interface StatusesDocument extends JsonRecord {
  readonly schema: "gitpm/statuses@1";
  readonly statuses: readonly StatusValue[];
}

export interface IssueTypeValue extends JsonRecord {
  readonly slug: string;
  readonly title: string;
  readonly active: boolean;
  readonly color?: string;
}

export interface IssueTypesDocument extends JsonRecord {
  readonly schema: "gitpm/issue-types@1";
  readonly issue_types: readonly IssueTypeValue[];
}

export type ConfigurationDocument = StatusesDocument | IssueTypesDocument;
export type GitPmDocument = EntityDocument | ConfigurationDocument;
export type HttpDocument = GitPmDocument;

export interface EntityResult<Document extends HttpDocument = EntityDocument> {
  readonly document: Document;
  readonly path: string;
  readonly blob_id: string;
  readonly draft_fingerprint: string;
}

export type ConfigurationResult = EntityResult<ConfigurationDocument>;
export type Decoder<T> = (value: unknown) => T;

export class ApiContractError extends Error {
  public readonly code = "API_RESPONSE_CONTRACT_INVALID";

  constructor(public readonly contract: string, message: string) {
    super(`${contract}: ${message}`);
    this.name = "ApiContractError";
  }
}

function record(value: unknown, contract: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiContractError(contract, "expected an object");
  }
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, field: string, contract: string): string {
  if (typeof value[field] !== "string") throw new ApiContractError(contract, `expected string field ${field}`);
  return value[field];
}

function lifecycle(value: Record<string, unknown>, contract: string): Lifecycle {
  if (value.lifecycle !== "active" && value.lifecycle !== "archived") {
    throw new ApiContractError(contract, "expected lifecycle active or archived");
  }
  return value.lifecycle;
}

export const decodeEntityDocument: Decoder<EntityDocument> = (input) => {
  const value = record(input, "GitPmDocument");
  const schema = stringField(value, "schema", "GitPmDocument");
  if (!(ENTITY_DOCUMENT_SCHEMAS as readonly string[]).includes(schema)) {
    throw new ApiContractError("GitPmDocument", `unsupported entity schema ${schema}`);
  }
  stringField(value, "id", "GitPmDocument");
  lifecycle(value, "GitPmDocument");
  return value as EntityDocument;
};

function decodeValues(input: unknown, field: "statuses" | "issue_types", contract: string): readonly StatusValue[] {
  if (!Array.isArray(input)) throw new ApiContractError(contract, `expected array field ${field}`);
  return input.map((item, index) => {
    const value = record(item, `${contract}.${field}[${index}]`);
    stringField(value, "slug", contract);
    stringField(value, "title", contract);
    if (typeof value.active !== "boolean") throw new ApiContractError(contract, `expected boolean ${field}[${index}].active`);
    if (value.color !== undefined && typeof value.color !== "string") throw new ApiContractError(contract, `expected string ${field}[${index}].color`);
    return value as StatusValue;
  });
}

export const decodeConfigurationDocument: Decoder<ConfigurationDocument> = (input) => {
  const value = record(input, "ConfigurationDocument");
  if (value.schema === "gitpm/statuses@1") {
    decodeValues(value.statuses, "statuses", "StatusesDocument");
    return value as unknown as StatusesDocument;
  }
  if (value.schema === "gitpm/issue-types@1") {
    decodeValues(value.issue_types, "issue_types", "IssueTypesDocument");
    return value as unknown as IssueTypesDocument;
  }
  throw new ApiContractError("ConfigurationDocument", "expected statuses or issue-types schema");
};

function resultFields(input: unknown, contract: string): Record<string, unknown> {
  const value = record(input, contract);
  stringField(value, "path", contract);
  stringField(value, "blob_id", contract);
  stringField(value, "draft_fingerprint", contract);
  return value;
}

export const decodeEntityResult: Decoder<EntityResult> = (input) => {
  const value = resultFields(input, "EntityResult");
  return { ...value, document: decodeEntityDocument(value.document) } as EntityResult;
};

export const decodeConfigurationResult: Decoder<ConfigurationResult> = (input) => {
  const value = resultFields(input, "ConfigurationResult");
  return { ...value, document: decodeConfigurationDocument(value.document) } as ConfigurationResult;
};

export const decodeEntityResults: Decoder<readonly EntityResult[]> = (input) => {
  if (!Array.isArray(input)) throw new ApiContractError("EntityResult[]", "expected an array");
  return input.map(decodeEntityResult);
};

export function decodeDto<T>(contract: string): Decoder<T> {
  return (input) => {
    if (input === undefined) throw new ApiContractError(contract, "response body is missing");
    if (typeof input === "number" && !Number.isFinite(input)) throw new ApiContractError(contract, "number is not finite");
    return input as T;
  };
}
