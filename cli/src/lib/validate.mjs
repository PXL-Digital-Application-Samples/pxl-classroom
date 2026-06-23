// PXL Classroom CLI — ajv schema validator.
//
// Loads JSON schemas directly from ../../../schemas/*.schema.json via fs,
// keeping CLI validation in lockstep with the frontend (which fetches the
// same files at runtime via frontend/src/lib/validate.js).

import Ajv from "ajv";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const schemasDir = join(here, "..", "..", "..", "schemas");

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
