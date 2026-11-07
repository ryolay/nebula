// ESLint flat config — same engine Codacy runs for JavaScript.
const fs = require('node:fs');
const path = require('node:path');
const js = require('@eslint/js');
const globals = require('globals');

// The renderer is a set of classic <script> files that share top-level functions.
// Declare every top-level name as a global so `no-undef` still catches real typos.
const RENDERER = path.join(__dirname, 'src/renderer');
const shared = {};
for (const f of fs.readdirSync(RENDERER).filter((x) => x.endsWith('.js'))) {
  const src = fs.readFileSync(path.join(RENDERER, f), 'utf8');
  for (const m of src.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|^(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) shared[m[1] || m[2]] = 'writable';
}

module.exports = [
  { ignores: ['dist/**', 'node_modules/**', 'src/renderer/fonts/**'] },
  js.configs.recommended,
  {
    files: ['src/*.js', 'tests/**/*.js', 'scripts/**/*.js', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs', globals: { ...globals.node } },
  },
  {
    rules: {
      'no-unused-vars': ['error', { args: 'after-used', caughtErrors: 'none', ignoreRestSiblings: true }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-console': 'off',
    },
  },
  {
    files: ['src/renderer/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'script',
      globals: { ...globals.browser, ...shared, Terminal: 'readonly', FitAddon: 'readonly' },
    },
    rules: {
      // top-level functions are used from other renderer files
      'no-unused-vars': ['error', { vars: 'local', args: 'after-used', caughtErrors: 'none' }],
      'no-redeclare': 'off',
    },
  },
];
