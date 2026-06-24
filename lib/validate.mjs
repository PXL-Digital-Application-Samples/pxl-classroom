// Node-side schema validator shared by scripts/ and any future lib consumer.
// Mirrors cli/src/lib/validate.mjs but anchored to the repo root's schemas/.
// SPA has its own runtime fetch-based variant in frontend/src/lib/validate.js.

import Ajv from "ajv";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const schemasDir = join(here, "..", "schemas");

const ajv = addFormats(new Ajv({ allErrors: true, useDefaults: true }));
const cache = new Map();

export function validateAgainst(schemaName, doc) {
  if (!cache.has(schemaName)) {
    const schemaPath = join(schemasDir, `${schemaName}.schema.json`);
    const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
    cache.set(schemaName, ajv.compile(schema));
  }
  const validate = cache.get(schemaName);
  const valid = validate(doc);
  return { valid, errors: validate.errors || [] };
}
