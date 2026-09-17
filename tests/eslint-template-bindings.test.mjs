// A <script setup> binding used only in the template is live code.
//
// `vue/script-setup-uses-vars` used to guarantee that, so `no-unused-vars`
// could not tell anyone to delete a ref, a computed or an imported component
// whose only reader is the template. eslint-plugin-vue 10 removed the rule,
// because vue-eslint-parser 9 and later mark template use themselves. After
// the ESLint 10 upgrade nothing in eslint.config.mjs says so any more, which is
// exactly the kind of guarantee that goes quiet: so it is asked of the real
// config, in both directions, on every run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const eslint = new ESLint({ cwd: root });

// A path the SPA's config block matches. The file does not exist; lintText
// only uses the path to choose the configuration.
const PROBE = join(root, "frontend", "src", "components", "TemplateBindingProbe.vue");

const sfc = (script, template) =>
  `<script setup>\n${script}\n</script>\n\n<template>\n  ${template}\n</template>\n`;

async function unusedVars(code) {
  const [result] = await eslint.lintText(code, { filePath: PROBE });
  const fatal = result.messages.filter((m) => m.fatal);
  assert.deepEqual(fatal, [], "sanity: the probe must parse, or it proves nothing");
  return result.messages.filter((m) => m.ruleId === "no-unused-vars").map((m) => m.message);
}

test("a ref and a component used only in the template are not reported as unused", async () => {
  const messages = await unusedVars(
    sfc(
      "import { ref } from 'vue'\nimport Icon from './Icon.vue'\nconst label = ref('hello')",
      '<p><Icon name="check" /> {{ label }}</p>',
    ),
  );
  assert.deepEqual(messages, [], "template use must count, or the lint asks us to delete live UI");
});

test("a binding used nowhere still is, so the check above is live", async () => {
  const messages = await unusedVars(sfc("import { ref } from 'vue'\nconst label = ref('hello')", "<p>static</p>"));
  assert.equal(messages.length, 1, `expected exactly the unused 'label', got ${JSON.stringify(messages)}`);
  assert.match(messages[0], /'label'/);
});
