const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const H = require('./helpers'); // sets isolated GIT_CONFIG_GLOBAL + fake gh first
const git = require('../src/git');
const identity = require('../src/identity');
const { Accounts } = require('../src/accounts');

const real = (d) => fs.realpathSync.native(d);
// How Nebula writes a folder into git config: forward slashes, ~ for the home folder.
const gitPath = (p) => { const s = p.replace(/\\/g, '/'); const h = os.homedir().replace(/\\/g, '/'); return s.startsWith(`${h}/`) ? `~${s.slice(h.length)}` : s; };
const globalCfg = process.env.GIT_CONFIG_GLOBAL;
const gset = (...a) => H.sh(H.ROOT, ['config', '--global', ...a]);
const secrets = { encrypt: (s) => `enc:${Buffer.from(s).toString('base64')}`, decrypt: (s) => Buffer.from(s.slice(4), 'base64').toString() };

function resetGlobal() {
  fs.writeFileSync(globalCfg, '[user]\n\tname = Test Runner\n\temail = runner@example.com\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n');
}
test.beforeEach(() => { resetGlobal(); H.resetGh(); git.setAuthResolver(null); });

// ---------------------------------------------------------------- remotes
test('parseRemote: https, ssh scp-style, ssh://, ports, nested groups, aliases, local paths', () => {
  const p = identity.parseRemote;
  assert.deepEqual(
    (({ host, path: pa, owner, name, protocol }) => ({ host, pa, owner, name, protocol }))(p('https://github.com/acme/web.git')),
    { host: 'github.com', pa: 'acme/web', owner: 'acme', name: 'web', protocol: 'https' });
  assert.equal(p('git@github.com:acme/web.git').protocol, 'ssh');
  assert.equal(p('git@github.com:acme/web.git').path, 'acme/web');
  assert.equal(p('ssh://git@gitlab.example.com:2222/group/sub/proj.git').host, 'gitlab.example.com');
  assert.equal(p('ssh://git@gitlab.example.com:2222/group/sub/proj.git').owner, 'group/sub');
  assert.equal(p('https://user:pw@gitlab.com/group/sub/proj').path, 'group/sub/proj');
  assert.equal(p('http://127.0.0.1:8080/g/p.git').host, '127.0.0.1:8080', 'http port is kept');
  assert.equal(p('github-work:acme/web.git').host, 'github-work', 'ssh host alias');
  assert.equal(p('/tmp/origin.git'), null);
  assert.equal(p(''), null);
});

test('rules: remote globs and folder matching', () => {
  const r = identity.parseRemote('https://github.com/Acme-Corp/web.git');
  assert.ok(identity.matchRemote('github.com/acme-corp/*', r), 'case-insensitive');
  assert.ok(identity.matchRemote('https://github.com/acme-corp', r), 'owner prefix');
  assert.ok(!identity.matchRemote('github.com/acme/*', r));
  assert.ok(identity.matchRemote('gitlab.com/team/**', identity.parseRemote('git@gitlab.com:team/a/b/c.git')));
  assert.ok(identity.matchRemote('gitlab.com/team/*', identity.parseRemote('git@gitlab.com:team/a/b/c.git')), 'a rule on a group also covers its subgroups');
  assert.ok(identity.matchFolder('/Users/x/Work', '/Users/x/Work/proj'));
  assert.ok(identity.matchFolder('/Users/x/Work/', '/users/x/work/proj'), 'case-insensitive like APFS');
  assert.ok(!identity.matchFolder('/Users/x/Work', '/Users/x/Workshop/proj'), 'no prefix false-positive');
});

test('labelFor: free-mail → Personal, company domains → name', () => {
  assert.equal(identity.labelFor('jane.doe@gmail.com'), 'Personal');
  assert.equal(identity.labelFor('1+me@users.noreply.github.com'), 'Personal');
  assert.equal(identity.labelFor('jane@tryacme.com'), 'Acme');
  assert.equal(identity.labelFor('a@initech.ch'), 'Initech');
});

// ---------------------------------------------------------------- discovery & profiles (mirrors the real includeIf setup)
function workSetup() {
  const work = real(H.tmpDir('Work'));
  const inc = path.join(path.dirname(globalCfg), '.gitconfig-work-test');
  fs.writeFileSync(inc, '[user]\n\temail = me@company.com\n');
  gset(`includeIf.gitdir/i:${gitPath(work)}/.path`, inc);
  return { work, inc };
}

test('discover + Profiles: imports global identity and includeIf identities with their folders', async () => {
  const { work } = workSetup();
  const dir = H.tmpDir('userdata');
  const store = new identity.Profiles(dir);
  const list = await store.list();
  assert.deepEqual(list.map((p) => [p.label, p.name, p.email, p.folders]), [
    ['Example', 'Test Runner', 'runner@example.com', []],
    ['Company', 'Test Runner', 'me@company.com', [`${work}/`]],
  ]);
  assert.ok(list.every((p) => p.id && p.color));
  // import happens once: deleting a profile must not resurrect it
  await store.remove(list[0].id);
  assert.equal((await new identity.Profiles(dir).list()).length, 1);
});

test('Profiles.save validates and updates in place', async () => {
  const store = new identity.Profiles(H.tmpDir('userdata'));
  await assert.rejects(store.save({ label: 'x', name: '', email: 'a@b.c' }), /Name is required/);
  await assert.rejects(store.save({ label: 'x', name: 'A', email: 'nope' }), /valid email/);
  await assert.rejects(store.save({ label: 'x', name: 'A\n[core]', email: 'a@b.co' }), /invalid characters/);
  const p = await store.save({ label: 'OSS', name: 'Ada', email: 'ada@oss.dev', remotes: ['GitHub.com/Org/*', ' '], folders: ['~/oss', '~/oss'] });
  assert.deepEqual(p.remotes, ['github.com/org/*']);
  assert.deepEqual(p.folders, ['~/oss']);
  const q = await store.save({ ...p, label: 'Open source' });
  assert.equal(q.id, p.id);
  assert.equal((await store.list()).filter((x) => x.id === p.id).length, 1);
});

test('effective(): reports value + where it comes from (global, include file, local)', async () => {
  const { work } = workSetup();
  const plain = H.initRepo('plain');
  let e = await identity.effective(plain);
  assert.equal(e.email.value, 'runner@example.com');
  assert.equal(e.email.scope, 'global');
  assert.equal(e.email.included, false);

  const inWork = path.join(work, 'proj');
  fs.mkdirSync(inWork);
  H.sh(inWork, ['init', '-q']);
  e = await identity.effective(inWork);
  assert.equal(e.email.value, 'me@company.com');
  assert.equal(e.email.included, true, 'comes from the includeIf file');
  assert.match(e.email.file, /\.gitconfig-work-test$/);
  assert.equal(e.name.value, 'Test Runner', 'name still from global');

  H.sh(inWork, ['config', 'user.email', 'local@x.io']);
  e = await identity.effective(inWork);
  assert.equal(e.email.scope, 'local');
  assert.equal(e.email.value, 'local@x.io');
});

test('applyToRepo / clearRepo write and remove plain git config, and commits use it', async () => {
  const d = H.initRepo('apply');
  const p = { id: 'p1', label: 'OSS', name: 'Ada Lovelace', email: 'ada@oss.dev', signingKey: '', account: 'github:github.com/ada' };
  await identity.applyToRepo(d, p);
  assert.equal(H.sh(d, ['config', '--local', 'user.email']).trim(), 'ada@oss.dev');
  assert.equal(H.sh(d, ['config', '--local', 'nebula.identity']).trim(), 'p1');
  assert.equal(H.sh(d, ['config', '--local', 'nebula.account']).trim(), 'github:github.com/ada');
  H.write(d, 'a', 'a');
  H.sh(d, ['add', '.']);
  H.sh(d, ['commit', '-qm', 'x']); // a plain terminal commit picks the identity up
  assert.equal(H.sh(d, ['log', '-1', '--format=%an <%ae>']).trim(), 'Ada Lovelace <ada@oss.dev>');
  await identity.clearRepo(d);
  assert.equal((await identity.effective(d)).email.scope, 'global');
  await identity.clearRepo(d); // idempotent
});

test('folderRule: plan is shown first, apply writes an includeIf that git itself honours', async () => {
  const folder = real(H.tmpDir('Clients'));
  const p = { id: 'c', label: 'Client X', name: 'Chris', email: 'chris@client-x.com', signingKey: '' };
  const plan = await identity.folderRule(p, folder);
  assert.match(plan.includeFile, /\.gitconfig-nebula-client-x$/);
  assert.match(plan.globalLine, /\[includeIf "gitdir\/i:.*Clients-\d+\/"\]/);
  assert.equal(fs.existsSync(path.join(path.dirname(globalCfg), '.gitconfig-nebula-client-x')), false, 'planning writes nothing');

  await identity.folderRule(p, folder, { apply: true });
  await identity.folderRule(p, folder, { apply: true }); // re-applying does not duplicate
  assert.equal(H.sh(H.ROOT, ['config', '--global', '--get-all', `includeIf.gitdir/i:${gitPath(folder)}/.path`]).trim().split('\n').length, 1);
  const repo = path.join(folder, 'site');
  fs.mkdirSync(repo);
  H.sh(repo, ['init', '-q']);
  assert.equal(H.sh(repo, ['config', 'user.email']).trim(), 'chris@client-x.com', 'terminal git sees the rule');
  assert.equal(H.sh(H.initRepo('elsewhere'), ['config', 'user.email']).trim(), 'runner@example.com', 'other repos untouched');
});

test('setGlobal changes the global identity', async () => {
  await identity.setGlobal({ name: 'New Name', email: 'new@example.com' });
  assert.equal(H.sh(H.ROOT, ['config', '--global', 'user.email']).trim(), 'new@example.com');
});

test('suggest(): remote rules win over folder rules; mismatch detection', async () => {
  const profiles = [
    { id: 'w', label: 'Work', email: 'me@company.com', remotes: ['github.com/company/*'], folders: [] },
    { id: 'p', label: 'Personal', email: 'me@gmail.com', remotes: [], folders: ['/Users/me/code'] },
  ];
  const s1 = identity.suggest(profiles, '/Users/me/code/x', identity.parseRemote('git@github.com:company/api.git'));
  assert.equal(s1.profile.id, 'w');
  assert.match(s1.reason, /remote matches/);
  const s2 = identity.suggest(profiles, '/Users/me/code/x', identity.parseRemote('git@github.com:me/blog.git'));
  assert.equal(s2.profile.id, 'p');
  assert.equal(identity.suggest(profiles, '/tmp/x', null), null);
});

// ---------------------------------------------------------------- GitHub accounts via gh
test('Accounts.github lists every gh account; token per account', { skip: H.POSIX_ONLY }, async () => {
  H.setGhAccounts([
    { host: 'github.com', login: 'perso', token: 'tok-perso', active: true },
    { host: 'github.com', login: 'work', token: 'tok-work', active: false },
    { host: 'ghe.acme.com', login: 'chris', token: 'tok-ghe', active: true },
  ]);
  const acc = new Accounts(H.tmpDir('userdata'), secrets);
  const list = await acc.list();
  assert.deepEqual(list.map((a) => [a.id, a.active]), [
    ['github:github.com/perso', true], ['github:github.com/work', false], ['github:ghe.acme.com/chris', true]]);
  assert.equal(await acc.token('github:github.com/work'), 'tok-work');
  H.resetGh();
  assert.deepEqual(await acc.list(), [], 'no gh accounts → empty list, not an error');
});

test('githubLogin: device code is surfaced, new account added, previous active account restored', { skip: H.POSIX_ONLY }, async () => {
  H.setGhAccounts([{ host: 'github.com', login: 'perso', token: 'tok-perso', active: true }]);
  const acc = new Accounts(H.tmpDir('userdata'), secrets);
  let code;
  const { promise } = acc.githubLogin('github.com', (c) => { code = c; fs.writeFileSync(H.GH_APPROVE, 'work'); });
  const added = await promise;
  assert.deepEqual(code, { code: 'ABCD-1234', url: 'https://github.com/login/device' });
  assert.equal(added.login, 'work');
  const st = H.ghAccounts();
  assert.deepEqual(st.map((a) => [a.login, a.active]), [['perso', true], ['work', false]], 'global gh active account unchanged');
});

test('githubLogin can be cancelled; invalid hosts rejected', { skip: H.POSIX_ONLY }, async () => {
  const acc = new Accounts(H.tmpDir('userdata'), secrets);
  const { promise, cancel } = acc.githubLogin('github.com', () => cancel());
  await assert.rejects(promise, /cancel/i);
  assert.throws(() => acc.githubLogin('evil.com; rm -rf /'), /Invalid host/);
});

test('resolve(): automatic = gh active account; pinned per repo; pinned-but-gone flagged', { skip: H.POSIX_ONLY }, async () => {
  H.setGhAccounts([
    { host: 'github.com', login: 'perso', token: 'tok-perso', active: true },
    { host: 'github.com', login: 'work', token: 'tok-work', active: false },
  ]);
  const acc = new Accounts(H.tmpDir('userdata'), secrets);
  const d = H.initRepo('route');
  H.sh(d, ['remote', 'add', 'origin', 'https://github.com/company/api.git']);
  let r = await acc.resolve(d);
  assert.equal(r.provider, 'github');
  assert.equal(r.account.login, 'perso');
  assert.equal(r.token, 'tok-perso');
  assert.equal(r.pinned, null);

  H.sh(d, ['config', 'nebula.account', 'github:github.com/work']);
  r = await acc.resolve(d);
  assert.equal(r.account.login, 'work');
  assert.equal(r.token, 'tok-work');
  assert.equal(r.pinnedMissing, false);

  H.setGhAccounts([{ host: 'github.com', login: 'perso', token: 'tok-perso', active: true }]);
  r = await acc.resolve(d);
  assert.equal(r.pinnedMissing, true);
  assert.equal(r.account.login, 'perso', 'falls back to the active account');

  const none = H.initRepo('no-remote');
  assert.equal(await acc.resolve(none), null);
  // insteadOf aliases must not hide the real host
  const aliased = H.initRepo('aliased');
  H.sh(aliased, ['remote', 'add', 'origin', 'https://github.com/company/api.git']);
  H.sh(aliased, ['config', 'url./tmp/somewhere.git.insteadOf', 'https://github.com/company/api.git']);
  assert.equal((await acc.resolve(aliased)).remote.host, 'github.com');
});

// ---------------------------------------------------------------- token injection into git network commands
test('fetch/push use the routed account token via http.extraheader (never argv or disk)', { skip: H.POSIX_ONLY }, async () => {
  const seen = [];
  const server = http.createServer((req, res) => { seen.push(req.headers.authorization || null); res.writeHead(404); res.end(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const d = H.initRepo('netenv');
    H.commit(d, 'ada', 'x', { x: 'x' });
    H.sh(d, ['remote', 'add', 'origin', `http://127.0.0.1:${port}/company/api.git`]);
    await git.open(d);
    git.setAuthResolver(async () => ({ provider: 'github', remote: identity.parseRemote(`http://127.0.0.1:${port}/company/api.git`), token: 'tok-work' }));
    await assert.rejects(git.fetch());
    await assert.rejects(git.push());
    const expected = `basic ${Buffer.from('x-access-token:tok-work').toString('base64')}`;
    assert.ok(seen.length >= 2);
    assert.ok(seen.every((h) => h?.toLowerCase() === expected.toLowerCase()), `got ${JSON.stringify(seen)}`);
    assert.doesNotMatch(fs.readFileSync(path.join(d, '.git/config'), 'utf8'), /tok-work|extraheader/, 'token never written to repo config');

    git.setAuthResolver(async () => ({ provider: 'gitlab', remote: identity.parseRemote(`http://127.0.0.1:${port}/g/p.git`), token: 'glpat-x' }));
    seen.length = 0;
    await assert.rejects(git.fetch());
    assert.equal(seen[0].toLowerCase(), `basic ${Buffer.from('oauth2:glpat-x').toString('base64')}`.toLowerCase(), 'GitLab uses oauth2 user');

    git.setAuthResolver(async () => null);
    seen.length = 0;
    await assert.rejects(git.fetch());
    assert.equal(seen[0], null, 'no account → no header');
  } finally { server.close(); }
});

// ---------------------------------------------------------------- GitLab
function fakeGitLab() {
  const reqs = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      reqs.push({ method: req.method, url: req.url, token: req.headers['private-token'] || null, body: body ? JSON.parse(body) : null });
      const send = (code, j) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
      if (req.headers['private-token'] && req.headers['private-token'] !== 'glpat-good') return send(401, { message: '401 Unauthorized' });
      const proj = '/api/v4/projects/group%2Fsub%2Fproj';
      if (req.url === '/api/v4/user') return send(200, { username: 'chris', name: 'Chris DSP', avatar_url: 'https://gl/avatar.png' });
      if (req.url.startsWith(`${proj}/merge_requests?`)) return send(200, [{ iid: 7, title: 'Add SSO', author: { username: 'ada', name: 'Ada', avatar_url: 'https://gl/a.png' }, source_branch: 'feat/sso', target_branch: 'main', draft: true, web_url: 'https://gl/mr/7', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', labels: ['security'], description: 'SSO', changes_count: '4' }]);
      if (req.url === proj) return send(200, { default_branch: 'develop' });
      if (req.method === 'POST' && req.url === `${proj}/merge_requests`) return send(201, { iid: 8, web_url: 'https://gl/mr/8' });
      if (req.method === 'PUT' && /\/merge_requests\/7\/(merge|rebase)$/.test(req.url)) return send(200, { state: 'merged' });
      send(404, { message: '404 Not Found' });
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, reqs, base: `http://127.0.0.1:${server.address().port}` })));
}

test('GitLab accounts: token validated, stored encrypted, listed, removed', async () => {
  const { server, base } = await fakeGitLab();
  try {
    const dir = H.tmpDir('userdata');
    const acc = new Accounts(dir, secrets);
    await assert.rejects(acc.gitlabAdd({ baseUrl: base, token: 'glpat-bad' }), /GitLab 401/);
    await assert.rejects(acc.gitlabAdd({ baseUrl: 'http://gitlab.evil.com', token: 'x' }), /must use https/);
    await assert.rejects(acc.gitlabAdd({ baseUrl: base, token: ' ' }), /token is required/);
    const a = await acc.gitlabAdd({ baseUrl: base, token: 'glpat-good' });
    assert.equal(a.login, 'chris');
    assert.equal(a.token, undefined, 'token never returned to the UI');
    const raw = fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8');
    assert.doesNotMatch(raw, /glpat-good/, 'stored encrypted');
    if (process.platform !== 'win32') assert.equal((fs.statSync(path.join(dir, 'accounts.json')).mode & 0o777), 0o600); // no POSIX modes on Windows
    assert.equal(await acc.token(a.id), 'glpat-good');
    assert.deepEqual((await acc.list()).map((x) => x.id), [a.id]);
    acc.gitlabRemove(a.id);
    assert.deepEqual(await acc.list(), []);
  } finally { server.close(); }
});

test('GitLab merge requests: list (mapped to PR shape), create (default branch, draft), merge; routed through resolve()', async () => {
  const { server, reqs, base } = await fakeGitLab();
  try {
    const acc = new Accounts(H.tmpDir('userdata'), secrets);
    await acc.gitlabAdd({ baseUrl: base, token: 'glpat-good' });
    const d = H.initRepo('gl');
    H.commit(d, 'ada', 'x', { x: 'x' });
    H.sh(d, ['switch', '-q', '-c', 'feat/sso']);
    H.sh(d, ['remote', 'add', 'origin', `${base}/group/sub/proj.git`]);
    await git.open(d);
    git.setAuthResolver((repo) => acc.resolve(repo));

    const r = await git.prs();
    assert.equal(r.available, true);
    assert.equal(r.provider, 'gitlab');
    assert.deepEqual(r.items[0], {
      number: 7, title: 'Add SSO', author: { login: 'ada', name: 'Ada', avatar: 'https://gl/a.png' }, headRefName: 'feat/sso', baseRefName: 'main',
      isDraft: true, url: 'https://gl/mr/7', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', reviewDecision: null,
      additions: null, deletions: null, changedFiles: 4, labels: [{ name: 'security', color: '8b8fb5' }], body: 'SSO', state: 'OPEN',
    });
    assert.ok(reqs.every((q) => q.token === 'glpat-good'), 'every API call authenticated with the account token');

    H.sh(d, ['update-ref', 'refs/remotes/origin/feat/sso', 'feat/sso']); // already published → no push to the fake server
    const created = await git.prCreate({ title: 'Ship SSO', body: 'desc', draft: true });
    assert.equal(created.url, 'https://gl/mr/8');
    const post = reqs.find((q) => q.method === 'POST');
    assert.deepEqual(post.body, { source_branch: 'feat/sso', target_branch: 'develop', title: 'Draft: Ship SSO', description: 'desc', reviewer_ids: [], assignee_ids: [], labels: '', remove_source_branch: false });

    await git.prMerge({ number: 7, method: 'squash' });
    assert.deepEqual(reqs.at(-1), { method: 'PUT', url: '/api/v4/projects/group%2Fsub%2Fproj/merge_requests/7/merge', token: 'glpat-good', body: { squash: true } });
    await git.prMerge({ number: 7, method: 'rebase' });
    assert.ok(reqs.some((q) => q.url.endsWith('/merge_requests/7/rebase')));
  } finally { server.close(); }
});

test('GitLab MR checkout fetches refs/merge-requests/<iid>/head', async () => {
  const { origin, work, other } = H.withRemote();
  H.sh(other, ['switch', '-q', '-c', 'mr-src']);
  const h = H.commit(other, 'linus', 'MR work', { 'mr.txt': 'mr' });
  H.sh(other, ['push', '-q', 'origin', `${h}:refs/merge-requests/12/head`]);
  void origin;
  await git.open(work);
  git.setAuthResolver(async () => ({ provider: 'gitlab', remote: { host: 'gitlab.com', protocol: 'ssh', path: 'g/p' }, token: null }));
  await git.prCheckout({ number: '12' });
  assert.equal(H.sh(work, ['branch', '--show-current']).trim(), 'mr/12');
  assert.equal(H.sh(work, ['rev-parse', 'HEAD']).trim(), h);
});
