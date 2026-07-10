#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { parse } from "yaml";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_DIR = path.join(ROOT, "schemas", "v1");
const FIXTURE_DIR = path.join(ROOT, "fixtures", "schema-v1");
const DEMO_DIR = path.join(FIXTURE_DIR, "demo");

class FixtureError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const fail = (code, message) => {
  throw new FixtureError(code, message);
};

const normalize = (value) => value.split(path.sep).join("/");

async function filesUnder(directory, extension) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...await filesUnder(absolute, extension));
    } else if (entry.name.endsWith(extension)) {
      result.push(absolute);
    }
  }
  return result.sort();
}

async function loadSchemas() {
  const schemaPaths = await filesUnder(SCHEMA_DIR, ".schema.json");
  const schemas = await Promise.all(schemaPaths.map(async (schemaPath) =>
    JSON.parse(await readFile(schemaPath, "utf8"))));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  for (const schema of schemas) {
    ajv.addSchema(schema);
  }
  return ajv;
}

async function loadDocuments(root) {
  const documents = new Map();
  for (const yamlPath of await filesUnder(root, ".yaml")) {
    const relative = normalize(path.relative(root, yamlPath));
    documents.set(relative, parse(await readFile(yamlPath, "utf8"), { uniqueKeys: true }));
  }
  return documents;
}

const schemaIds = new Map([
  ["gitpm/project@1", "https://gitpm.dev/schemas/v1/project.schema.json"],
  ["gitpm/task@1", "https://gitpm.dev/schemas/v1/task.schema.json"],
  ["gitpm/milestone@1", "https://gitpm.dev/schemas/v1/milestone.schema.json"],
  ["gitpm/person@1", "https://gitpm.dev/schemas/v1/person.schema.json"],
  ["gitpm/team@1", "https://gitpm.dev/schemas/v1/team.schema.json"],
  ["gitpm/calendar@1", "https://gitpm.dev/schemas/v1/calendar.schema.json"],
  ["gitpm/saved-view@1", "https://gitpm.dev/schemas/v1/saved-view.schema.json"],
  ["gitpm/repository@1", "https://gitpm.dev/schemas/v1/repository.schema.json"],
  ["gitpm/statuses@1", "https://gitpm.dev/schemas/v1/statuses.schema.json"],
  ["gitpm/issue-types@1", "https://gitpm.dev/schemas/v1/issue-types.schema.json"],
]);

function expectedPath(document) {
  switch (document.schema) {
    case "gitpm/project@1": return `projects/${document.id}/project.yaml`;
    case "gitpm/task@1": return `projects/${document.project}/tasks/${document.id}.yaml`;
    case "gitpm/milestone@1": return `projects/${document.project}/milestones/${document.id}.yaml`;
    case "gitpm/saved-view@1": return `projects/${document.project}/views/${document.id}.yaml`;
    case "gitpm/person@1": return `people/${document.id}.yaml`;
    case "gitpm/team@1": return `teams/${document.id}.yaml`;
    case "gitpm/calendar@1": return `calendars/${document.id}.yaml`;
    case "gitpm/repository@1": return ".gitpm/repository.yaml";
    case "gitpm/statuses@1": return ".gitpm/statuses.yaml";
    case "gitpm/issue-types@1": return ".gitpm/issue-types.yaml";
    default: return undefined;
  }
}

function validateShapeAndPaths(ajv, documents) {
  for (const [relative, document] of documents) {
    const schemaId = schemaIds.get(document?.schema);
    if (!schemaId) {
      fail("SCHEMA_UNKNOWN", `${relative}: unknown schema ${String(document?.schema)}`);
    }
    const validate = ajv.getSchema(schemaId);
    if (!validate(document)) {
      fail("SCHEMA_INVALID", `${relative}: ${ajv.errorsText(validate.errors)}`);
    }
    const expected = expectedPath(document);
    if (relative !== expected) {
      const code = document.schema === "gitpm/project@1" ? "PATH_PROJECT_DIRECTORY" : "PATH_ENTITY_FILENAME";
      fail(code, `${relative}: expected ${expected}`);
    }
  }
}

function uniqueSlugs(values, label) {
  const slugs = values.map((item) => item.slug);
  if (new Set(slugs).size !== slugs.length) {
    fail("CONFIG_DUPLICATE_SLUG", `${label} contains duplicate slugs`);
  }
  return new Set(slugs);
}

function validateReferences(documents) {
  const entities = new Map();
  for (const [relative, document] of documents) {
    if (!document.id) continue;
    if (entities.has(document.id)) fail("IDENTITY_DUPLICATE", `${relative}: duplicate ID ${document.id}`);
    entities.set(document.id, document);
  }

  const repository = documents.get(".gitpm/repository.yaml");
  const statuses = uniqueSlugs(documents.get(".gitpm/statuses.yaml").statuses, "statuses");
  const issueTypes = uniqueSlugs(documents.get(".gitpm/issue-types.yaml").issue_types, "issue types");

  const reference = (id, expectedSchema, context) => {
    const target = entities.get(id);
    if (!target || target.schema !== expectedSchema) {
      fail("REF_MISSING", `${context}: ${id} does not reference ${expectedSchema}`);
    }
    return target;
  };
  reference(repository.default_calendar, "gitpm/calendar@1", "repository.default_calendar");

  for (const [relative, document] of documents) {
    if (document.start && document.due && document.start > document.due) {
      fail("DATE_RANGE", `${relative}: start must not be after due`);
    }
    switch (document.schema) {
      case "gitpm/project@1":
        if (!statuses.has(document.status)) fail("CONFIG_REFERENCE", `${relative}: unknown status ${document.status}`);
        if (document.owner) reference(document.owner, "gitpm/person@1", `${relative}.owner`);
        break;
      case "gitpm/person@1":
        reference(document.calendar, "gitpm/calendar@1", `${relative}.calendar`);
        break;
      case "gitpm/team@1":
        for (const member of document.members) reference(member, "gitpm/person@1", `${relative}.members`);
        break;
      case "gitpm/milestone@1": {
        const project = reference(document.project, "gitpm/project@1", `${relative}.project`);
        if (project.id !== document.project) fail("REF_CROSS_PROJECT", `${relative}: invalid project`);
        break;
      }
      case "gitpm/task@1": {
        reference(document.project, "gitpm/project@1", `${relative}.project`);
        if (!statuses.has(document.status)) fail("CONFIG_REFERENCE", `${relative}: unknown status ${document.status}`);
        if (!issueTypes.has(document.type)) fail("CONFIG_REFERENCE", `${relative}: unknown type ${document.type}`);
        for (const assignee of document.assignees ?? []) reference(assignee, "gitpm/person@1", `${relative}.assignees`);
        const projectReferences = [
          ...(document.parent ? [[document.parent, "gitpm/task@1"]] : []),
          ...(document.milestone ? [[document.milestone, "gitpm/milestone@1"]] : []),
          ...(document.depends_on ?? []).map((id) => [id, "gitpm/task@1"]),
        ];
        for (const [id, expectedSchema] of projectReferences) {
          const target = reference(id, expectedSchema, relative);
          if (target.project !== document.project) {
            fail("REF_CROSS_PROJECT", `${relative}: ${id} belongs to another project`);
          }
        }
        break;
      }
      case "gitpm/saved-view@1":
        reference(document.project, "gitpm/project@1", `${relative}.project`);
        for (const assignee of document.filters.assignees ?? []) reference(assignee, "gitpm/person@1", `${relative}.filters.assignees`);
        for (const milestone of document.filters.milestones ?? []) {
          const target = reference(milestone, "gitpm/milestone@1", `${relative}.filters.milestones`);
          if (target.project !== document.project) fail("REF_CROSS_PROJECT", `${relative}: ${milestone} belongs to another project`);
        }
        break;
    }
  }
}

async function validateTopLevel(root, documents) {
  const repository = documents.get(".gitpm/repository.yaml");
  const allowed = new Set([".gitpm", "people", "teams", "calendars", "projects", ...repository.allowed_top_level_files]);
  for (const entry of await readdir(root)) {
    if (!allowed.has(entry)) fail("REPOSITORY_TOP_LEVEL", `unknown top-level entry ${entry}`);
  }
}

async function validatePortfolio(ajv, root, documents) {
  validateShapeAndPaths(ajv, documents);
  await validateTopLevel(root, documents);
  validateReferences(documents);
}

function setField(document, field, value) {
  const segments = field.split(".");
  let target = document;
  for (const segment of segments.slice(0, -1)) target = target[segment];
  target[segments.at(-1)] = value;
}

async function main() {
  const ajv = await loadSchemas();
  const baseline = await loadDocuments(DEMO_DIR);
  await validatePortfolio(ajv, DEMO_DIR, baseline);
  console.log(`VALID demo portfolio: ${baseline.size} YAML documents`);

  const cases = parse(await readFile(path.join(FIXTURE_DIR, "invalid-cases.yaml"), "utf8"), { uniqueKeys: true });
  for (const fixture of cases.cases) {
    const documents = structuredClone(baseline);
    const document = documents.get(fixture.file);
    if (!document) fail("FIXTURE_INVALID", `${fixture.name}: missing mutation target ${fixture.file}`);
    setField(document, fixture.field, fixture.value);
    try {
      await validatePortfolio(ajv, DEMO_DIR, documents);
      fail("FIXTURE_NOT_REJECTED", `${fixture.name}: invalid fixture passed`);
    } catch (error) {
      if (!(error instanceof FixtureError) || error.code !== fixture.expected_code) {
        throw error;
      }
      console.log(`REJECTED ${fixture.name}: ${error.code}`);
    }
  }
  console.log(`Schema v1 fixture verification passed: ${cases.cases.length} invalid cases rejected`);
}

main().catch((error) => {
  const code = error instanceof FixtureError ? `${error.code}: ` : "";
  console.error(`${code}${error.message}`);
  process.exitCode = 1;
});
