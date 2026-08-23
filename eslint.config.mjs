// PXL Classroom - ESLint flat config.
//
// Added after three undeclared identifiers shipped, each of them a
// ReferenceError the moment its branch ran and none of them visible to any
// existing check: the template compiler never sees a <script setup> body, Vite
// bundles it happily, and the unit suite does not execute components.
//
//   AssignmentDetailView  showBreakdown.value  - every Escape keypress threw
//   AssignmentView        deviceFlow.value     - Sign out threw
//   AssignmentView        authError.value      - dead line after it
//
// The point of this config is `no-undef`, so the rule set is scoped to
// correctness. Vue's "essential" preset is used rather than "recommended":
// attribute ordering and self-closing style are not what this is for, and a
// lint nobody can keep green stops being read.

import js from '@eslint/js'
import pluginVue from 'eslint-plugin-vue'
import globals from 'globals'

const NODE_FILES = [
  '*.mjs',
  'lib/**/*.mjs',
  'scripts/**/*.mjs',
  'acceptance/**/*.mjs',
  'collect/**/*.mjs',
  'lockdown/**/*.mjs',
  'preserve/**/*.mjs',
  'provisioning/**/*.mjs',
  'report/**/*.mjs',
  'pages/**/*.mjs',
  'registry/**/*.mjs',
  'notify/**/*.mjs',
  'cli/**/*.mjs',
]

export default [
  {
    ignores: [
      '**/node_modules/**',
      'frontend/dist/**',
      'test-results/**',
      'playwright-report/**',
      'control-repo-template/**',
      'templates/**',
    ],
  },

  js.configs.recommended,
  ...pluginVue.configs['flat/essential'],

  // Workflow scripts, composite actions, shared libs, the CLI.
  {
    files: NODE_FILES,
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },

  // lib/ is shared with the SPA, so it may reference browser globals too
  // (gittree's TextEncoder/btoa fallback for environments without Buffer).
  {
    files: ['lib/**/*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },

  // The SPA. Vue macros (defineProps/defineEmits/...) are compiler globals.
  {
    files: ['frontend/src/**/*.{js,vue}'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        defineProps: 'readonly',
        defineEmits: 'readonly',
        defineExpose: 'readonly',
        defineOptions: 'readonly',
        withDefaults: 'readonly',
      },
    },
    rules: {
      // A component that renders a value it never declared is the bug this
      // config exists for; keep it an error even where the codebase is noisy.
      'no-undef': 'error',
      // Without this, a <script setup> binding used ONLY in the template reads
      // as dead code and no-unused-vars would have us delete live UI.
      'vue/script-setup-uses-vars': 'error',
    },
  },

  {
    files: ['frontend/*.js', 'frontend/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },

  // Tests: node:test globals plus Playwright's browser evaluate() callbacks,
  // whose bodies run in the page and legitimately use DOM globals.
  {
    files: ['tests/**/*.mjs', 'cli/tests/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // Assertions frequently bind values only to read them in a message.
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },

  // Repo-wide tuning. Empty catch blocks are a deliberate, commented idiom here
  // ("one unreadable manifest must not sink the read"), unused function
  // arguments are common in callback signatures, and `catch (e) {}` without
  // reading `e` is the same idiom by another name.
  {
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': [
        'error',
        { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' },
      ],
      // Icon and Toast are deliberate one-word names, used everywhere; the rule
      // guards against colliding with HTML elements, which neither does.
      'vue/multi-word-component-names': 'off',
    },
  },
]
