// Shared test fixtures: isolated git config, throwaway repos, and a fake `gh`.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-test-'));

// Isolate from the developer's ~/.gitconfig (hooks, signing, aliases…).
const gitconfig = path.join(ROOT, 'gitconfig');
fs.writeFileSync(gitconfig, [
  '[user]', '\tname = Test Runner', '\temail = runner@example.com',
  '[init]', '\tdefaultBranch = main',
  '[commit]', '\tgpgsign = false',
  '[tag]', '\tgpgsign = false',
  '[advice]', '\tdetachedHead = false',
].join('\n'));
process.env.GIT_CONFIG_GLOBAL = gitconfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';

// Fake GitHub CLI (multi-account aware): logs argv + GH_TOKEN/GH_HOST, keeps accounts in a JSON state file.
const binDir = path.join(ROOT, 'bin');
fs.mkdirSync(binDir);
const GH_LOG = path.join(ROOT, 'gh.log');
const GH_JSON = path.join(ROOT, 'gh.json');
const GH_FAIL = path.join(ROOT, 'gh.fail');
const GH_STATE = path.join(ROOT, 'gh-state.json');
const GH_APPROVE = path.join(ROOT, 'gh.approve');
fs.writeFileSync(path.join(binDir, 'gh'), `#!${process.execPath}
const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(GH_LOG)}, JSON.stringify({ argv: a, token: process.env.GH_TOKEN || null, host: process.env.GH_HOST || null }) + '\\n');
const st = fs.existsSync(${JSON.stringify(GH_STATE)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(GH_STATE)}, 'utf8')) : { accounts: [] };
const save = () => fs.writeFileSync(${JSON.stringify(GH_STATE)}, JSON.stringify(st));
const opt = (k) => { const i = a.indexOf(k); return i === -1 ? null : a[i + 1]; };
const die = (m, c = 1) => { process.stderr.write(m + '\\n'); process.exit(c); };
const cmd = a.slice(0, 2).join(' ');
if (cmd === 'auth status') {
  if (!st.accounts.length) die('You are not logged into any GitHub hosts. To log in, run: gh auth login');
  const hosts = {};
  for (const x of st.accounts) (hosts[x.host] ||= []).push({ state: 'success', active: !!x.active, host: x.host, login: x.login, tokenSource: 'keyring', scopes: (x.scopes || ['repo', 'read:org']).join(', '), gitProtocol: 'https' });
  process.stdout.write(JSON.stringify({ hosts }));
} else if (cmd === 'auth token') {
  const x = st.accounts.find((y) => y.host === (opt('--hostname') || 'github.com') && (!opt('--user') || y.login === opt('--user')));
  if (!x) die('no oauth token found');
  process.stdout.write(x.token + '\\n');
} else if (cmd === 'auth switch') {
  st.accounts.forEach((y) => { if (y.host === opt('--hostname')) y.active = y.login === opt('--user'); }); save();
} else if (cmd === 'auth logout') {
  st.accounts = st.accounts.filter((y) => !(y.host === opt('--hostname') && y.login === opt('--user'))); save();
} else if (cmd === 'auth refresh') {
  process.stderr.write('! One-time code (WXYZ-9876) copied to clipboard\\nOpen this URL to continue in your web browser: https://' + opt('--hostname') + '/login/device\\n');
  const t0 = Date.now();
  const wait = () => {
    if (fs.existsSync(${JSON.stringify(GH_APPROVE)})) {
      fs.rmSync(${JSON.stringify(GH_APPROVE)});
      const x = st.accounts.find((y) => y.host === opt('--hostname') && y.active);
      x.scopes = [...new Set([...(x.scopes || ['repo', 'read:org']), ...opt('--scopes').split(',')])]; save();
      process.exit(0);
    }
    if (Date.now() - t0 > 20000) die('timed out');
    setTimeout(wait, 50);
  };
  wait();
} else if (a[0] === 'api' && !a.includes('user/keys') && !a.includes('-X')) {
  const route = a[1];
  const me = (st.accounts.find((y) => y.token === process.env.GH_TOKEN) || st.accounts.find((y) => y.active) || { login: 'me' }).login;
  const R = st.api || {};
  if (route === 'user') process.stdout.write(JSON.stringify({ login: me }));
  else if (route.split('/').length === 3 && route.startsWith('repos/')) process.stdout.write(JSON.stringify({ default_branch: R.defaultBranch || 'main', owner: { login: route.split('/')[1], type: R.teams ? 'Organization' : 'User' } }));
  else if (route.includes('/teams?')) { if (!R.teams) die('gh: Not Found (HTTP 404)'); process.stdout.write(JSON.stringify(R.teams)); }
  else if (route.includes('/assignees?')) process.stdout.write(JSON.stringify((R.users || []).map((l) => ({ login: l, avatar_url: 'https://a/' + l }))));
  else if (route.includes('/labels?')) process.stdout.write(JSON.stringify(R.labels || []));
  else if (route.includes('/milestones?')) process.stdout.write(JSON.stringify(R.milestones || []));
  else die('gh: Not Found (HTTP 404)');
} else if (a[0] === 'api' && a.includes('user/keys')) {
  const x = st.accounts.find((y) => y.token === process.env.GH_TOKEN);
  if (!x) die('HTTP 401: Bad credentials');
  if (!(x.scopes || []).includes('admin:public_key')) die('gh: Not Found (HTTP 404)\\ngh: This API operation needs the "admin:public_key" scope. To request it, run:  gh auth refresh -h github.com -s admin:public_key');
  const key = a.find((v) => v.startsWith('key=')).slice(4);
  x.keys = [...(x.keys || [])];
  if (x.keys.includes(key)) die('HTTP 422: Validation Failed (key is already in use)');
  x.keys.push(key); save();
  process.stdout.write('{"id":1}');
} else if (cmd === 'auth login') {
  process.stderr.write('! One-time code (ABCD-1234) copied to clipboard\\nOpen this URL to continue in your web browser: https://' + opt('--hostname') + '/login/device\\n');
  const t0 = Date.now();
  const wait = () => {
    if (fs.existsSync(${JSON.stringify(GH_APPROVE)})) {
      const login = fs.readFileSync(${JSON.stringify(GH_APPROVE)}, 'utf8').trim();
      fs.rmSync(${JSON.stringify(GH_APPROVE)});
      st.accounts.forEach((y) => { if (y.host === opt('--hostname')) y.active = false; });
      st.accounts.push({ host: opt('--hostname'), login, token: 'tok-' + login, active: true }); save();
      process.stderr.write('✓ Logged in as ' + login + '\\n'); process.exit(0);
    }
    if (Date.now() - t0 > 20000) die('timed out');
    setTimeout(wait, 50);
  };
  wait();
} else if (a[0] === 'issue') {
  st.issues ||= [];
  const sub = a[1], num = Number(a[2]);
  const me = (st.accounts.find((y) => y.token === process.env.GH_TOKEN) || st.accounts.find((y) => y.active) || { login: 'me' }).login;
  const find = () => st.issues.find((i) => i.number === num) || die('GraphQL: Could not resolve to an issue or pull request with the number of ' + num + '.');
  const now = new Date().toISOString();
  if (sub === 'list') {
    const want = opt('--state') === 'closed' ? 'CLOSED' : 'OPEN';
    process.stdout.write(JSON.stringify(st.issues.filter((i) => i.state === want)));
  } else if (sub === 'view') process.stdout.write(JSON.stringify(find()));
  else if (sub === 'create') {
    const n = (st.issues.reduce((m, i) => Math.max(m, i.number), 0) || 0) + 1;
    st.issues.push({ number: n, title: opt('--title'), body: opt('--body') || '', state: 'OPEN', author: { login: me }, labels: [], assignees: [], comments: [], createdAt: now, updatedAt: now, url: 'https://github.com/acme/demo/issues/' + n });
    save(); process.stdout.write('https://github.com/acme/demo/issues/' + n + '\\n');
  } else if (sub === 'comment') { const i = find(); i.comments.push({ author: { login: me }, body: opt('--body'), createdAt: now }); save(); }
  else if (sub === 'close' || sub === 'reopen') { const i = find(); i.state = sub === 'close' ? 'CLOSED' : 'OPEN'; save(); }
  else if (sub === 'edit') { const i = find(); if (opt('--add-assignee') === '@me' && !i.assignees.some((x) => x.login === me)) i.assignees.push({ login: me }); save(); }
} else if (cmd === 'pr list') {
  if (fs.existsSync(${JSON.stringify(GH_FAIL)})) die('gh: To get started with GitHub CLI, please run: gh auth login', 4);
  process.stdout.write(fs.readFileSync(${JSON.stringify(GH_JSON)}, 'utf8'));
} else {
  process.stdout.write('https://github.com/acme/demo/pull/99\\n');
}
`, { mode: 0o755 });
fs.writeFileSync(GH_JSON, '[]');
// Fake ssh for `ssh -T`: answers like GitHub for logins listed in ssh.users (alias → login), else denies.
const SSH_USERS = path.join(ROOT, 'ssh.users.json');
fs.writeFileSync(path.join(binDir, 'ssh'), `#!${process.execPath}
const fs = require('fs');
const target = process.argv.at(-1).replace(/^git@/, '');
const users = fs.existsSync(${JSON.stringify(SSH_USERS)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(SSH_USERS)}, 'utf8')) : {};
if (users[target]) { process.stderr.write('Hi ' + users[target] + "! You've successfully authenticated, but GitHub does not provide shell access.\\n"); process.exit(1); }
process.stderr.write('git@' + target + ': Permission denied (publickey).\\n'); process.exit(255);
`, { mode: 0o755 });
const SSH_DIR = path.join(ROOT, 'dot-ssh');
process.env.NEBULA_SSH_DIR = SSH_DIR;
process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH}`;

const ghLog = () => (fs.existsSync(GH_LOG) ? fs.readFileSync(GH_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const ghCalls = () => ghLog().map((l) => l.argv).filter((a) => a[0] !== 'auth');
const setGhAccounts = (accounts, issues, api) => fs.writeFileSync(GH_STATE, JSON.stringify({ accounts, issues: issues || [], api: api || {} }));
const ghIssues = () => (fs.existsSync(GH_STATE) ? JSON.parse(fs.readFileSync(GH_STATE, 'utf8')).issues || [] : []);
const ghAccounts = () => (fs.existsSync(GH_STATE) ? JSON.parse(fs.readFileSync(GH_STATE, 'utf8')).accounts : []);
const setSshUsers = (m) => fs.writeFileSync(SSH_USERS, JSON.stringify(m));
const resetGh = () => { for (const f of [GH_LOG, GH_FAIL, GH_STATE, GH_APPROVE, SSH_USERS]) fs.rmSync(f, { force: true }); fs.writeFileSync(GH_JSON, '[]'); };

let n = 0;
function tmpDir(name) {
  const d = path.join(ROOT, `${name}-${++n}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function sh(cwd, args, env = {}) {
  return execFileSync('git', args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

// A tiny DSL to build realistic histories with distinct authors and dates.
const PEOPLE = {
  ada: ['Ada Lovelace', 'ada@example.com'],
  linus: ['Linus Torvalds', 'torvalds@linux-foundation.org'],
  grace: ['Grace Hopper', 'grace@example.com'],
  octo: ['Octo Cat', '583231+octocat@users.noreply.github.com'],
};
let clock = Date.parse('2026-01-01T10:00:00Z') / 1000;
function commit(cwd, who, msg, filesMap = {}) {
  for (const [f, content] of Object.entries(filesMap)) {
    const p = path.join(cwd, f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (content === null) fs.rmSync(p);
    else fs.writeFileSync(p, content);
  }
  sh(cwd, ['add', '-A']);
  const [name, email] = PEOPLE[who];
  clock += 3600;
  const date = `${clock} +0000`;
  sh(cwd, ['commit', '-q', '--allow-empty', '-m', msg], {
    GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email,
    GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date,
  });
  return sh(cwd, ['rev-parse', 'HEAD']).trim();
}

function initRepo(name = 'repo') {
  const d = tmpDir(name);
  sh(d, ['init', '-q', '-b', 'main']);
  return d;
}

/** bare origin + a working clone ("work") + a collaborator clone ("other") */
function withRemote() {
  const origin = tmpDir('origin.git');
  sh(origin, ['init', '-q', '--bare', '-b', 'main']);
  const seed = initRepo('seed');
  commit(seed, 'ada', 'Initial commit', { 'README.md': '# Demo\n' });
  sh(seed, ['remote', 'add', 'origin', origin]);
  sh(seed, ['push', '-q', '-u', 'origin', 'main']);
  const work = tmpDir('work');
  sh(work, ['clone', '-q', origin, '.']);
  const other = tmpDir('other');
  sh(other, ['clone', '-q', origin, '.']);
  return { origin, work, other };
}

const write = (cwd, f, content) => { const p = path.join(cwd, f); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); };
const read = (cwd, f) => fs.readFileSync(path.join(cwd, f), 'utf8');
const exists = (cwd, f) => fs.existsSync(path.join(cwd, f));

module.exports = { ROOT, sh, commit, initRepo, withRemote, tmpDir, write, read, exists, ghCalls, ghLog, resetGh, setGhAccounts, ghAccounts, ghIssues, setSshUsers, SSH_DIR, GH_JSON, GH_FAIL, GH_APPROVE, PEOPLE };
