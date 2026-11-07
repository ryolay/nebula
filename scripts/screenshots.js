#!/usr/bin/env node
// Regenerates the README screenshots in docs/ from a throwaway demo repository.
// Everything runs with an isolated HOME and git config, so no personal data
// (name, email, accounts, recent repos) can leak into the images.
//   npm run screenshots
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-shots-'));
const HOME = path.join(ROOT, 'home');
fs.mkdirSync(HOME, { recursive: true });
fs.writeFileSync(path.join(HOME, '.gitconfig'), '[init]\n\tdefaultBranch = main\n[user]\n\tname = Ada Lovelace\n\temail = ada@example.com\n');
const ENV = { ...process.env, HOME, GIT_CONFIG_GLOBAL: path.join(HOME, '.gitconfig'), GH_CONFIG_DIR: path.join(HOME, '.gh'), XDG_CONFIG_HOME: path.join(HOME, '.config') };
const OUT = path.join(__dirname, '..', 'docs');
fs.mkdirSync(OUT, { recursive: true });

const PEOPLE = {
  ada: ['Ada Lovelace', 'ada@example.com'],
  grace: ['Grace Hopper', 'grace@example.com'],
  linus: ['Linus Byte', 'linus@example.com'],
  margaret: ['Margaret Hamilton', 'margaret@example.com'],
};
let clock = Date.parse('2026-10-01T09:00:00Z') / 1000;
const git = (dir, args) => execFileSync('git', args, { cwd: dir, env: ENV, encoding: 'utf8' });
function commit(dir, who, msg, files) {
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
  git(dir, ['add', '-A']);
  clock += 3600 * 5;
  const [name, email] = PEOPLE[who];
  const date = `${clock} +0000`;
  execFileSync('git', ['commit', '-q', '-m', msg], { cwd: dir, env: { ...ENV, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
}
const merge = (dir, who, branch) => {
  const [name, email] = PEOPLE[who]; clock += 3600 * 3;
  const date = `${clock} +0000`;
  execFileSync('git', ['merge', '-q', '--no-ff', branch, '-m', `Merge branch '${branch}'`], { cwd: dir, env: { ...ENV, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
};

function demoRepo() {
  const origin = path.join(ROOT, 'origin.git');
  git(ROOT, ['init', '-q', '--bare', origin]);
  const d = path.join(ROOT, 'orbit-dashboard');
  fs.mkdirSync(d);
  git(d, ['init', '-q']);
  git(d, ['remote', 'add', 'origin', origin]);
  commit(d, 'ada', 'Initial commit', { 'README.md': '# Orbit dashboard\n', 'src/app.js': 'export const app = {};\n' });
  commit(d, 'grace', 'Add telemetry service', { 'src/telemetry.js': 'export function read() {}\n' });
  git(d, ['checkout', '-q', '-b', 'feature/charts']);
  commit(d, 'linus', 'Add line chart component', { 'src/chart.js': 'export function line() {}\n' });
  commit(d, 'linus', 'Chart: axis labels and tooltips', { 'src/chart.js': 'export function line() { /* axes */ }\n' });
  git(d, ['checkout', '-q', 'main']);
  commit(d, 'margaret', 'Fix timezone handling in telemetry', { 'src/telemetry.js': 'export function read(tz) {}\n' });
  merge(d, 'ada', 'feature/charts');
  git(d, ['tag', 'v1.0.0']);
  git(d, ['checkout', '-q', '-b', 'feature/alerts']);
  commit(d, 'grace', 'Alert rules engine', { 'src/alerts.js': 'export const rules = [];\n' });
  commit(d, 'grace', 'Send alerts to Slack webhook', { 'src/alerts.js': 'export const rules = []; // slack\n' });
  git(d, ['checkout', '-q', 'main']);
  commit(d, 'ada', 'Dark mode for the dashboard', { 'src/theme.css': ':root { color-scheme: dark; }\n' });
  git(d, ['push', '-q', '-u', 'origin', 'main', 'feature/charts', 'feature/alerts', '--tags']);
  git(d, ['checkout', '-q', '-b', 'fix/login-redirect']);
  commit(d, 'margaret', 'Keep the return URL across the login redirect', { 'src/auth.js': 'export const keepReturnUrl = true;\n' });
  git(d, ['checkout', '-q', 'main']);
  commit(d, 'linus', 'Speed up chart rendering with a canvas layer', { 'src/chart.js': 'export function line() { /* canvas */ }\n' });
  git(d, ['stash', 'list']);
  fs.writeFileSync(path.join(d, 'src/theme.css'), ':root { color-scheme: dark; --accent: #7c8cff; }\n');
  fs.writeFileSync(path.join(d, 'CHANGELOG.md'), '## 1.1.0\n- Alerts\n');
  return d;
}

function conflictRepo() {
  const d = path.join(ROOT, 'payments-api');
  fs.mkdirSync(d);
  git(d, ['init', '-q']);
  commit(d, 'ada', 'Initial commit', { 'src/config.js': 'export const retries = 3;\nexport const timeout = 1000;\n' });
  git(d, ['checkout', '-q', '-b', 'feature/retry-policy']);
  commit(d, 'grace', 'Exponential retry policy', { 'src/config.js': 'export const retries = 5;\nexport const backoff = "exponential";\nexport const timeout = 1000;\n' });
  git(d, ['checkout', '-q', 'main']);
  commit(d, 'linus', 'Lower retries for card payments', { 'src/config.js': 'export const retries = 2;\nexport const timeout = 1000;\n' });
  try { git(d, ['merge', 'feature/retry-policy']); } catch { /* expected conflict */ }
  return d;
}

function shot(name, repo, evalSrc) {
  return new Promise((resolve, reject) => {
    const file = path.join(OUT, `${name}.png`);
    const p = spawn(require('electron'), [path.join(__dirname, '..'), repo], {
      env: { ...ENV, NEBULA_SNAPSHOT: file, NEBULA_EVAL: evalSrc, NEBULA_USER_DATA: path.join(ROOT, `ud-${name}`), NEBULA_NO_EXTERNAL: '1', NEBULA_WIN_BOUNDS: '40,40,1440,900' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (b) => { out += b; });
    p.stderr.on('data', (b) => { out += b; });
    p.on('exit', () => (fs.existsSync(file) ? resolve(file) : reject(new Error(out))));
  });
}

const wait = `const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn) => { for (let i = 0; i < 100; i++) { const v = fn(); if (v) return v; await sleep(80); } };`;

(async () => {
  const demo = demoRepo();
  const conflict = conflictRepo();
  console.log(await shot('graph', demo, `(async () => { ${wait}
    await waitFor(() => document.querySelectorAll('#rows .row').length > 3);
    const rows = [...document.querySelectorAll('#rows .row')];
    rows.find((r) => /canvas layer/.test(r.textContent))?.click();
    await sleep(600); return true; })()`));
  console.log(await shot('conflicts', conflict, `(async () => { ${wait}
    await waitFor(() => document.querySelector('#detail .op-card'));
    document.querySelector('[data-resolve="src/config.js"], [data-resolve]')?.click();
    await waitFor(() => document.querySelector('.rz-block'));
    await sleep(800); return true; })()`));
  fs.rmSync(ROOT, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(1); });
