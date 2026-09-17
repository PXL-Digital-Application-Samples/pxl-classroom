#!/usr/bin/env node
// PXL Classroom - the documents' TypeScript shapes, FROM the schemas.
//
// WHY THIS IS GENERATED. `npm run typecheck` exists to catch one class of bug:
// a schema field spelled wrong compares as a constant (`s.status` where the
// field is `submission_status` is `undefined` on every row, and `!== 'x'` is
// then always true - which counted a whole roster as having accepted). A
// checker can only say that if it knows the field names, and the field names
// are in `schemas/`. Writing them out a second time by hand is the defect this
// repository has written down more often than any other: one fact in two
// places, with one copy updated.
//
// So the types are derived. `npm run types` rewrites `lib/types.d.mts`, and
// `tests/generated-types.test.mjs` fails when the committed file is not what
// the schemas produce - plus, on a path that does NOT share this code, when a
// property the schema declares is missing from the emitted type or vice versa.
// A checker built from the transform validates its own bug.
//
// EVERY PROPERTY IS OPTIONAL, deliberately. `required` is Ajv's job at the
// moment a document is written; what this file types is a document that has
// been READ - off disk, out of an API answer, half-built by a form - where any
// field may legitimately be absent and the code says so with `?.` and `||`.
// Typing `required` as required would make every partial literal an error and
// teach people to cast, which is how a type stops being read at all.
//
// WHAT IT DOES NOT DO: `additionalProperties: false` is not emitted as an index
// signature, which is the point - an unknown property is an error, and that is
// the misspelling this whole exercise is for.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SCHEMA_DIR = join(root, "schemas");
export const TYPES_PATH = join(root, "lib", "types.d.mts");

/** `report.schema.json` -> `Report`, `retired-manifest.schema.json` -> `RetiredManifest`. */
export function typeNameFor(fileName) {
  return fileName
    .replace(/\.schema\.json$/, "")
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/** A JSON pointer into the schema's own document: `#/$defs/row`, `#/definitions/x`. */
function resolveRef(ref, rootSchema) {
  if (typeof ref !== "string" || !ref.startsWith("#/")) return null;
  let node = rootSchema;
  for (const part of ref.slice(2).split("/")) {
    node = node?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
    if (!node) return null;
  }
  return node;
}

/** One `const` or one `enum` member as a TypeScript literal. */
function literal(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  return "unknown";
}

/**
 * A schema node as a TypeScript type.
 *
 * `allOf`/`if`/`then` are deliberately ignored: in these schemas they express
 * conditional REQUIREDNESS (roster_mode `open` requires max_acceptances), which
 * is a validation rule and not a shape. `anyOf`/`oneOf` become a union of what
 * their branches describe, which is what they are.
 */
export function typeFor(node, rootSchema, indent = 0) {
  if (!node || typeof node !== "object") return "unknown";
  if (node.$ref) {
    const target = resolveRef(node.$ref, rootSchema);
    return target ? typeFor(target, rootSchema, indent) : "unknown";
  }
  if (node.const !== undefined) return literal(node.const);
  if (Array.isArray(node.enum) && node.enum.length) {
    return node.enum.map(literal).join(" | ");
  }
  for (const key of ["anyOf", "oneOf"]) {
    if (Array.isArray(node[key]) && node[key].length) {
      const parts = node[key].map((branch) => typeFor(branch, rootSchema, indent));
      return [...new Set(parts)].join(" | ");
    }
  }

  const type = Array.isArray(node.type) ? node.type[0] : node.type;
  if (type === "string") return "string";
  if (type === "integer" || type === "number") return "number";
  if (type === "boolean") return "boolean";
  if (type === "null") return "null";
  if (type === "array") {
    const item = node.items ? typeFor(node.items, rootSchema, indent) : "unknown";
    return item.includes(" | ") || item.includes("\n") ? `Array<${item}>` : `${item}[]`;
  }
  if (type === "object" || node.properties) {
    const props = node.properties || {};
    const names = Object.keys(props);
    // A MAP, not a loose object: `additionalProperties` carrying a schema means
    // "any key, this shape" - which is how `dashboard.assignments` is declared,
    // keyed by assignment id. Emitting `Record<string, unknown>` for it threw
    // away every field of the entry, and threw them away SILENTLY, which is the
    // one thing a generated type must not do.
    if (names.length === 0 && node.additionalProperties && typeof node.additionalProperties === "object") {
      return `Record<string, ${typeFor(node.additionalProperties, rootSchema, indent)}>`;
    }
    if (names.length === 0) return "Record<string, unknown>";
    const pad = "  ".repeat(indent + 1);
    const lines = names.map((name) => {
      const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
      return `${pad}${key}?: ${typeFor(props[name], rootSchema, indent + 1)};`;
    });
    return `{\n${lines.join("\n")}\n${"  ".repeat(indent)}}`;
  }
  return "unknown";
}

/**
 * A name for one element of a top-level array-of-objects property.
 *
 * `Roster.students` -> `RosterStudent`, `Team.members` -> `TeamMember`. The
 * rule is mechanical (type name + capitalised property, minus a trailing "s")
 * because these are read one row at a time all over `lib/`, and the alternative
 * at every call site is `NonNullable<Roster["students"]>[number]`, which nobody
 * will write twice.
 */
export function elementNameFor(typeName, property) {
  const singular = property.replace(/ies$/, "y").replace(/s$/, "");
  const pascal = singular
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  return `${typeName}${pascal}`;
}

/** The whole file, as text. */
export function renderTypes(schemaDir = SCHEMA_DIR) {
  const files = readdirSync(schemaDir).filter((f) => f.endsWith(".schema.json")).sort();
  const blocks = files.map((file) => {
    const schema = JSON.parse(readFileSync(join(schemaDir, file), "utf8"));
    const name = typeNameFor(file);
    const title = typeof schema.description === "string" ? schema.description.split(". ")[0] : "";
    const doc = title ? `/** ${title.replace(/\s+/g, " ").trim()} (schemas/${file}) */\n` : "";
    let out = `${doc}export type ${name} = ${typeFor(schema, schema, 0)};\n`;

    for (const [prop, node] of Object.entries(schema.properties || {})) {
      const items = node?.type === "array" ? node.items : null;
      if (!items || (items.type !== "object" && !items.properties)) continue;
      const element = elementNameFor(name, prop);
      out += `\n/** One element of \`${name}.${prop}\`. */\n`;
      out += `export type ${element} = NonNullable<${name}["${prop}"]>[number];\n`;
    }
    return out;
  });

  return [
    "// GENERATED BY scripts/generate-types.mjs - DO NOT EDIT.",
    "//",
    "// The documents in schemas/, as TypeScript, so `npm run typecheck` knows the",
    "// field names. Every property is optional: this types a document that has been",
    "// READ, where any field may be absent, and `required` is Ajv's job at the",
    "// moment one is written. Regenerate with `npm run types`.",
    "",
    blocks.join("\n"),
  ].join("\n");
}

// `pathToFileURL`, never a hand-built `file://` + the path: on Windows that
// spelling is `file://C:/...` where Node's own is `file:///C:/...`, so the
// comparison is false, the script exits 0 and writes nothing.
const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const text = renderTypes();
  if (process.argv.includes("--check")) {
    const current = readFileSync(TYPES_PATH, "utf8");
    if (current !== text) {
      console.error("lib/types.d.mts is not what the schemas produce. Run: npm run types");
      process.exit(1);
    }
    console.log("lib/types.d.mts is current.");
  } else {
    writeFileSync(TYPES_PATH, text);
    console.log(`Wrote ${TYPES_PATH}`);
  }
}
