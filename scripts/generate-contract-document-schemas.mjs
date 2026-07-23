#!/usr/bin/env node
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaDirectory = path.join(root, "schemas", "v1");
const outputPath = path.join(root, "packages", "contracts", "src", "generated-document-schemas.ts");
const check = process.argv.includes("--check");

const identifier = (fileName) => `${fileName
  .replace(/\.schema\.json$/u, "")
  .replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase())}Schema`;

const entries = (await readdir(schemaDirectory))
  .filter((entry) => entry.endsWith(".schema.json"))
  .sort();

const schemas = await Promise.all(entries.map(async (entry) => ({
  entry,
  name: identifier(entry),
  value: JSON.parse(await readFile(path.join(schemaDirectory, entry), "utf8")),
})));

const definitions = schemas.map(({ name }) => name).join(", ");
const documents = schemas
  .filter(({ value }) => typeof value?.properties?.schema?.const === "string")
  .map(({ entry, name, value }) => ({
    fileName: entry.replace(/\.schema\.json$/u, ""),
    schema: value.properties.schema.const,
    schemaId: value.$id,
    name,
  }));

const source = [
  "/* This file is generated from schemas/v1. Run `corepack pnpm contracts:generate` to update it. */",
  "",
  ...schemas.flatMap(({ name, value }) => [
    `export const ${name} = ${JSON.stringify(value, null, 2)} as const;`,
    "",
  ]),
  `export const DOCUMENT_SCHEMA_DEFINITIONS = [${definitions}] as const;`,
  "",
  "export const DOCUMENT_SCHEMAS = {",
  ...documents.map(({ schema, name }) => `  ${JSON.stringify(schema)}: ${name},`),
  "} as const;",
  "",
  "export const DOCUMENT_SCHEMA_IDS = {",
  ...documents.map(({ schema, schemaId }) => `  ${JSON.stringify(schema)}: ${JSON.stringify(schemaId)},`),
  "} as const;",
  "",
  "export const DOCUMENT_SCHEMA_FILES = {",
  ...documents.map(({ fileName, schema }) => `  ${JSON.stringify(fileName)}: ${JSON.stringify(schema)},`),
  "} as const;",
  "",
].join("\n");

if (check) {
  let current;
  try {
    current = await readFile(outputPath, "utf8");
  } catch {
    current = undefined;
  }
  if (current !== source) {
    process.stderr.write("Generated contract document schemas are stale. Run `corepack pnpm contracts:generate`.\n");
    process.exitCode = 1;
  }
} else {
  await writeFile(outputPath, source, "utf8");
}
