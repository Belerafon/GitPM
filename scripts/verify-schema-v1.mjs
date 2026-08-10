#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { parse } from "yaml";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_DIR = path.join(ROOT, "schemas", "v1");
const FIXTURE_DIR = path.join(ROOT, "fixtures", "schema-v1");
const FIXTURE_DEMO_DIR = path.join(FIXTURE_DIR, "demo");

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
    const discriminator = schema?.properties?.schema?.const;
    if (typeof discriminator === "string" && typeof schema.$id === "string") schemaIds.set(discriminator, schema.$id);
  }
  return ajv;
}

async function loadDocuments(root) {
  const documents = new Map();
  for (const domainRoot of [".gitpm", "people", "teams", "calendars", "availability", "projects"]) {
    for (const yamlPath of await filesUnder(path.join(root, domainRoot), ".yaml")) {
      const relative = normalize(path.relative(root, yamlPath));
      documents.set(relative, parse(await readFile(yamlPath, "utf8"), { uniqueKeys: true }));
    }
  }
  return documents;
}

const schemaIds = new Map();

function expectedPath(document) {
  switch (document.schema) {
    case "gitpm/project@2": return `projects/${document.id}/project.yaml`;
    case "gitpm/task@2": return `projects/${document.project}/tasks/${document.id}.yaml`;
    case "gitpm/milestone@2": return `projects/${document.project}/milestones/${document.id}.yaml`;
    case "gitpm/saved-view@1": return `projects/${document.project}/views/${document.id}.yaml`;
    case "gitpm/comment@1": return `projects/${document.project}/comments/${document.task}/${document.id}.yaml`;
    case "gitpm/time-entry@1": return `projects/${document.project}/time-entries/${document.task}/${document.id}.yaml`;
    case "gitpm/person@1": return `people/${document.id}.yaml`;
    case "gitpm/team@1": return `teams/${document.id}.yaml`;
    case "gitpm/calendar@1": return `calendars/${document.id}.yaml`;
    case "gitpm/availability-event@1": return `availability/${document.id}.yaml`;
    case "gitpm/repository@1": return ".gitpm/repository.yaml";
    case "gitpm/statuses@2": return ".gitpm/statuses.yaml";
    case "gitpm/issue-types@1": return ".gitpm/issue-types.yaml";
    case "gitpm/schedule-tracks@1": return ".gitpm/schedule-tracks.yaml";
    case "gitpm/work-categories@1": return ".gitpm/work-categories.yaml";
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
      const code = document.schema === "gitpm/project@2" ? "PATH_PROJECT_DIRECTORY" : "PATH_ENTITY_FILENAME";
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

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

function validateWindowDates(relative, trackSlug, window) {
  for (const field of ["start", "finish"]) {
    if (window[field] !== undefined && !DATE_PATTERN.test(window[field])) {
      fail("DATE_INVALID", `${relative}#schedules.${trackSlug}.${field}: invalid date`);
    }
  }
  if (typeof window.start === "string" && typeof window.finish === "string" && window.start > window.finish) {
    fail("DATE_RANGE", `${relative}#schedules.${trackSlug}: start must not be after finish`);
  }
}

function validateScheduleWindows(relative, document, tracks) {
  const schedules = document.schedules;
  if (schedules === undefined || typeof schedules !== "object") return;
  for (const [trackSlug, windowRaw] of Object.entries(schedules)) {
    const track = tracks.get(trackSlug);
    if (track === undefined) fail("SCHEDULE_TRACK_UNKNOWN", `${relative}: unknown schedule track ${trackSlug}`);
    const window = windowRaw ?? {};
    if (track && track.kind === "actual") fail("SCHEDULE_ACTUAL_NOT_EDITABLE", `${relative}: actual track ${trackSlug} cannot be stored`);
    validateWindowDates(relative, trackSlug, window);
    const caps = track ? track.capabilities : new Set();
    if (window.effort_hours !== undefined && !caps.has("effort")) fail("CAPABILITY_EFFORT_NOT_ALLOWED", `${relative}: track ${trackSlug} does not allow effort`);
    if (Array.isArray(window.depends_on) && window.depends_on.length > 0 && !caps.has("dependencies")) fail("CAPABILITY_DEPENDENCIES_NOT_ALLOWED", `${relative}: track ${trackSlug} does not allow dependencies`);
  }
}

function validatePlanning(relative, document, tracks) {
  const planning = document.planning;
  if (planning === undefined) return;
  const enabled = new Set(planning.enabled_tracks ?? []);
  for (const slug of [...(planning.enabled_tracks ?? []), ...(planning.dashboard_tracks ?? [])]) {
    if (!tracks.has(slug)) fail("PLANNING_UNKNOWN_TRACK", `${relative}: unknown schedule track ${slug}`);
  }
  if (planning.primary_track !== undefined && !enabled.has(planning.primary_track)) fail("PLANNING_PRIMARY_NOT_ENABLED", `${relative}: primary_track not enabled`);
  if (planning.workload_track !== undefined) {
    if (!enabled.has(planning.workload_track)) fail("PLANNING_WORKLOAD_NOT_ENABLED", `${relative}: workload_track not enabled`);
    const workload = tracks.get(planning.workload_track);
    if (workload && (workload.kind !== "manual" || !workload.capabilities.has("dates") || !workload.capabilities.has("effort"))) {
      fail("PLANNING_WORKLOAD_MISSING_EFFORT", `${relative}: workload_track needs manual dates and effort`);
    }
  }
  if (planning.comparison_track !== undefined && !enabled.has(planning.comparison_track)) fail("PLANNING_COMPARISON_NOT_ENABLED", `${relative}: comparison_track not enabled`);
  for (const slug of planning.dashboard_tracks ?? []) if (!enabled.has(slug)) fail("PLANNING_DASHBOARD_UNKNOWN", `${relative}: dashboard track ${slug} not enabled`);
}

function detectCyclesPerTrack(tasks, track) {
  const byId = new Map(tasks.map(([, document]) => [document.id, document]));
  const state = new Map();
  const reported = new Set();
  const walk = (id, stack) => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) {
      const start = stack.indexOf(id);
      if (start !== -1) {
        const cycle = stack.slice(start).sort().join("\n");
        if (!reported.has(cycle)) {
          reported.add(cycle);
          fail("TASK_DEPENDENCY_CYCLE", `${id}: cycle in track ${track}`);
        }
      }
      return;
    }
    state.set(id, 1);
    const document = byId.get(id);
    if (document) {
      for (const target of document.schedules?.[track]?.depends_on ?? []) {
        if (byId.has(target)) walk(target, [...stack, id]);
      }
    }
    state.set(id, 2);
  };
  for (const [, document] of tasks) walk(document.id, []);
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
  const tracksDocument = documents.get(".gitpm/schedule-tracks.yaml");
  const categoriesDocument = documents.get(".gitpm/work-categories.yaml");
  const tracks = new Map((tracksDocument?.tracks ?? []).map((track) => [track.slug, { kind: track.kind, capabilities: new Set(track.capabilities ?? []) }]));
  const categories = uniqueSlugs(categoriesDocument.categories, "work categories");

  const reference = (id, expectedSchema, context) => {
    const target = entities.get(id);
    if (!target || target.schema !== expectedSchema) {
      fail("REF_MISSING", `${context}: ${id} does not reference ${expectedSchema}`);
    }
    return target;
  };
  reference(repository.default_calendar, "gitpm/calendar@1", "repository.default_calendar");

  for (const [relative, document] of documents) {
    switch (document.schema) {
      case "gitpm/project@2":
        if (!statuses.has(document.status)) fail("CONFIG_REFERENCE", `${relative}: unknown status ${document.status}`);
        if (document.owner) reference(document.owner, "gitpm/person@1", `${relative}.owner`);
        validatePlanning(relative, document, tracks);
        validateScheduleWindows(relative, document, tracks);
        break;
      case "gitpm/person@1":
        reference(document.calendar, "gitpm/calendar@1", `${relative}.calendar`);
        break;
      case "gitpm/availability-event@1":
        reference(document.person, "gitpm/person@1", `${relative}.person`);
        if (document.start > document.finish) fail("DATE_RANGE", `${relative}: start must not be after finish`);
        break;
      case "gitpm/team@1":
        for (const member of document.members) reference(member, "gitpm/person@1", `${relative}.members`);
        break;
      case "gitpm/milestone@2": {
        const project = reference(document.project, "gitpm/project@2", `${relative}.project`);
        if (project && project.id !== document.project) fail("REF_CROSS_PROJECT", `${relative}: invalid project`);
        validateScheduleWindows(relative, document, tracks);
        break;
      }
      case "gitpm/task@2": {
        reference(document.project, "gitpm/project@2", `${relative}.project`);
        if (!statuses.has(document.status)) fail("CONFIG_REFERENCE", `${relative}: unknown status ${document.status}`);
        if (!issueTypes.has(document.type)) fail("CONFIG_REFERENCE", `${relative}: unknown type ${document.type}`);
        for (const assignee of document.assignees ?? []) reference(assignee, "gitpm/person@1", `${relative}.assignees`);
        if (document.parent) {
          const parent = reference(document.parent, "gitpm/task@2", `${relative}.parent`);
          if (parent && parent.project !== document.project) fail("REF_CROSS_PROJECT", `${relative}: parent belongs to another project`);
        }
        if (document.milestone) {
          const target = reference(document.milestone, "gitpm/milestone@2", `${relative}.milestone`);
          if (target && target.project !== document.project) fail("REF_CROSS_PROJECT", `${relative}: milestone belongs to another project`);
        }
        validateScheduleWindows(relative, document, tracks);
        for (const [trackSlug, window] of Object.entries(document.schedules ?? {})) {
          for (const dependency of window?.depends_on ?? []) {
            const target = reference(dependency, "gitpm/task@2", `${relative}.schedules.${trackSlug}.depends_on`);
            if (target && target.project !== document.project) fail("REF_CROSS_PROJECT", `${relative}: ${dependency} belongs to another project`);
          }
        }
        break;
      }
      case "gitpm/saved-view@1":
        reference(document.project, "gitpm/project@2", `${relative}.project`);
        for (const assignee of document.filters.assignees ?? []) reference(assignee, "gitpm/person@1", `${relative}.filters.assignees`);
        for (const milestone of document.filters.milestones ?? []) {
          const target = reference(milestone, "gitpm/milestone@2", `${relative}.filters.milestones`);
          if (target && target.project !== document.project) fail("REF_CROSS_PROJECT", `${relative}: ${milestone} belongs to another project`);
        }
        for (const status of document.filters.statuses ?? []) if (!statuses.has(status)) fail("CONFIG_REFERENCE", `${relative}: unknown status ${status}`);
        for (const issueType of document.filters.types ?? []) if (!issueTypes.has(issueType)) fail("CONFIG_REFERENCE", `${relative}: unknown type ${issueType}`);
        break;
      case "gitpm/comment@1": {
        reference(document.project, "gitpm/project@2", `${relative}.project`);
        const task = reference(document.task, "gitpm/task@2", `${relative}.task`);
        if (task && task.project !== document.project) fail("REF_CROSS_PROJECT", `${relative}: ${document.task} belongs to another project`);
        break;
      }
      case "gitpm/time-entry@1": {
        reference(document.project, "gitpm/project@2", `${relative}.project`);
        const task = reference(document.task, "gitpm/task@2", `${relative}.task`);
        if (task && task.project !== document.project) fail("REF_CROSS_PROJECT", `${relative}: ${document.task} belongs to another project`);
        reference(document.person, "gitpm/person@1", `${relative}.person`);
        if (!categories.has(document.category)) fail("CONFIG_REFERENCE", `${relative}: unknown work category ${document.category}`);
        break;
      }
    }
  }

  const tasks = [...documents.entries()].filter(([, document]) => document.schema === "gitpm/task@2");
  const dependencyTracks = new Set();
  for (const [, document] of tasks) for (const trackSlug of Object.keys(document.schedules ?? {})) dependencyTracks.add(trackSlug);
  for (const track of dependencyTracks) detectCyclesPerTrack(tasks, track);
}

async function validateTopLevel(root, documents) {
  const repository = documents.get(".gitpm/repository.yaml");
  const allowed = new Set([
    ".git",
    ".gitpm",
    ".agents",
    "AGENTS.md",
    ".gitignore",
    "people",
    "teams",
    "calendars",
    "availability",
    "projects",
    ...(repository.allowed_top_level_files ?? []),
    ...(repository.allowed_top_level_directories ?? []),
  ]);
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
  for (const segment of segments.slice(0, -1)) {
    if (target[segment] === undefined) target[segment] = {};
    target = target[segment];
  }
  target[segments.at(-1)] = value;
}

async function main() {
  const ajv = await loadSchemas();
  const requestedRepository = process.argv[2];
  const demoDirectory = requestedRepository === undefined ? FIXTURE_DEMO_DIR : path.resolve(requestedRepository);
  const baseline = await loadDocuments(demoDirectory);
  await validatePortfolio(ajv, demoDirectory, baseline);
  console.log(`VALID demo portfolio: ${baseline.size} YAML documents`);

  if (requestedRepository !== undefined) return;

  const cases = parse(await readFile(path.join(FIXTURE_DIR, "invalid-cases.yaml"), "utf8"), { uniqueKeys: true });
  for (const fixture of cases.cases) {
    const documents = structuredClone(baseline);
    const document = documents.get(fixture.file);
    if (!document) fail("FIXTURE_INVALID", `${fixture.name}: missing mutation target ${fixture.file}`);
    setField(document, fixture.field, fixture.value);
    try {
      await validatePortfolio(ajv, FIXTURE_DEMO_DIR, documents);
      fail("FIXTURE_NOT_REJECTED", `${fixture.name}: invalid fixture passed`);
    } catch (error) {
      if (!(error instanceof FixtureError) || error.code !== fixture.expected_code) {
        throw error;
      }
      console.log(`REJECTED ${fixture.name}: ${error.code}`);
    }
  }
  console.log(`Schema v2 fixture verification passed: ${cases.cases.length} invalid cases rejected`);
}

main().catch((error) => {
  const code = error instanceof FixtureError ? `${error.code}: ` : "";
  console.error(`${code}${error.message}`);
  process.exitCode = 1;
});
