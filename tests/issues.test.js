const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const H = require('./helpers');
const git = require('../src/git');
const identity = require('../src/identity');
const { Accounts } = require('../src/accounts');

const route = { provider: 'github', remote: { host: 'github.com', protocol: 'https', scheme: 'https', path: 'acme/demo' }, token: 'tok-work' };
const seed = () => [
  { number: 7, title: 'Login redirects to a blank page', body: 'Steps:\n- open /login', state: 'OPEN', author: { login: 'ada' }, labels: [{ name: 'bug', color: 'd73a4a' }], assignees: [], comments: [{ author: { login: 'linus' }, body: 'Repro on Safari', createdAt: '2026-01-02T00:00:00Z' }], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', url: 'https://github.com/acme/demo/issues/7' },
  { number: 3, title: 'Old closed one', body: '', state: 'CLOSED', author: { login: 'grace' }, labels: [], assignees: [], comments: [], createdAt: '2025-12-01T00:00:00Z', updatedAt: '2025-12-02T00:00:00Z', url: 'https://github.com/acme/demo/issues/3' },
];

test.beforeEach(() => {
  H.resetGh();
  H.setGhAccounts([{ host: 'github.com', login: 'work', token: 'tok-work', active: true }], seed());
  git.setAuthResolver(async () => route);
});
test.after(() => git.setAuthResolver(null));

test('GitHub issues: list open/closed with comment counts, through the repo account token', async () => {
  const d = H.initRepo('issues');
  H.commit(d, 'ada', 'x', { x: 'x' });
  await git.open(d);
  const open = await git.issues();
  assert.equal(open.available, true);
  assert.equal(open.provider, 'github');
  assert.deepEqual(open.items.map((i) => [i.number, i.title, i.commentsCount, i.comments]), [[7, 'Login redirects to a blank page', 1, undefined]]);
  assert.deepEqual((await git.issues({ state: 'closed' })).items.map((i) => i.number), [3]);
  const call = H.ghLog().find((l) => l.argv[0] === 'issue');
  assert.equal(call.token, 'tok-work');
  assert.deepEqual(call.argv.slice(-2), ['--repo', 'github.com/acme/demo']);
  assert.equal((await git.issues({ state: 'bogus' })).available, false);
});

test('GitHub issues: view, create, comment, assign me, close, reopen', async () => {
  const d = H.initRepo('issues2');
  await git.open(d);
  const v = await git.issueView({ number: 7 });
  assert.equal(v.body, 'Steps:\n- open /login');
  assert.deepEqual(v.comments, [{ author: { login: 'linus' }, body: 'Repro on Safari', createdAt: '2026-01-02T00:00:00Z' }]);
  const c = await git.issueCreate({ title: '  Crash on save  ', body: 'stack trace' });
  assert.deepEqual(c, { url: 'https://github.com/acme/demo/issues/8', number: 8 });
  await git.issueComment({ number: 8, body: 'Working on it' });
  await git.issueAssignMe({ number: 8 });
  await git.issueSetState({ number: 8, open: false });
  const i = H.ghIssues().find((x) => x.number === 8);
  assert.deepEqual([i.title, i.state, i.assignees.map((a) => a.login), i.comments.map((x) => x.body)], ['Crash on save', 'CLOSED', ['work'], ['Working on it']]);
  await git.issueSetState({ number: 8, open: true });
  assert.equal(H.ghIssues().find((x) => x.number === 8).state, 'OPEN');
  await assert.rejects(git.issueCreate({ title: ' ' }), /title is required/);
  await assert.rejects(git.issueComment({ number: 8, body: '' }), /comment is empty/);
  await assert.rejects(git.issueView({ number: '-1' }), /Invalid issue number/);
  await assert.rejects(git.issueView({ number: 99 }), /Could not resolve/);
});

test('issueBranch: GitKraken-style name from number + title, checked out; invalid numbers refused', async () => {
  const d = H.initRepo('issue-branch');
  H.commit(d, 'ada', 'x', { x: 'x' });
  await git.open(d);
  const r = await git.issueBranch({ number: 42, title: 'Fix: login redirects to a blank page (Safari) — été' });
  assert.equal(r.name, '42-fix-login-redirects-to-a-blank-page-safari-ete');
  assert.equal(H.sh(d, ['branch', '--show-current']).trim(), r.name);
  const r2 = await git.issueBranch({ number: 43, title: '!!!', checkout: false });
  assert.equal(r2.name, '43');
  assert.equal(H.sh(d, ['branch', '--show-current']).trim(), r.name, 'checkout: false keeps the current branch');
  const long = await git.issueBranch({ number: 44, title: 'a'.repeat(200), checkout: false });
  assert.ok(long.name.length <= 51);
  await assert.rejects(git.issueBranch({ number: 0, title: 'x' }), /Invalid issue number/);
});

test('no GitHub/GitLab remote → issues unavailable with a clear message', async () => {
  git.setAuthResolver(async () => null);
  const r = await git.issues();
  assert.equal(r.available, false);
  assert.match(r.error, /No GitHub or GitLab remote/);
});

test('GitLab issues via REST: list, view (system notes hidden), create, comment, close, assign me', async () => {
  const reqs = [];
  const issue = { iid: 5, title: 'Pipeline flaky', description: 'see logs', state: 'opened', web_url: 'https://gl/i/5', author: { username: 'ada', avatar_url: 'a.png' }, labels: ['ci'], assignees: [{ id: 9, username: 'bob' }], user_notes_count: 2, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' };
  const server = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      reqs.push({ m: req.method, u: req.url, t: req.headers['private-token'], b: b && JSON.parse(b) });
      const send = (j, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
      const P = '/api/v4/projects/team%2Fapp';
      if (req.url === '/api/v4/user') return send({ id: 1, username: 'me', name: 'Me' });
      if (req.url.startsWith(`${P}/issues?`)) return send([issue]);
      if (req.url === `${P}/issues/5` && req.method === 'GET') return send(issue);
      if (req.url.startsWith(`${P}/issues/5/notes?`)) return send([{ body: 'changed the label', system: true, author: { username: 'bot' } }, { body: 'Looking', system: false, author: { username: 'bob' }, created_at: '2026-01-03T00:00:00Z' }]);
      if (req.url === `${P}/issues` && req.method === 'POST') return send({ ...issue, iid: 6, title: JSON.parse(b).title }, 201);
      return send({ ok: true });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const secrets = { encrypt: (x) => x, decrypt: (x) => x };
    const acc = new Accounts(H.tmpDir('ud'), secrets);
    const base = `http://127.0.0.1:${server.address().port}`;
    await acc.gitlabAdd({ baseUrl: base, token: 'glpat-x' });
    const d = H.initRepo('gl-issues');
    H.sh(d, ['remote', 'add', 'origin', `${base}/team/app.git`]);
    await git.open(d);
    git.setAuthResolver((repo) => acc.resolve(repo));
    const list = await git.issues();
    assert.equal(list.provider, 'gitlab');
    assert.deepEqual(list.items[0], { number: 5, title: 'Pipeline flaky', body: 'see logs', state: 'OPEN', url: 'https://gl/i/5', author: { login: 'ada', name: undefined, avatar: 'a.png' }, labels: [{ name: 'ci', color: '8b8fb5' }], assignees: [{ login: 'bob', name: undefined, avatar: undefined }], commentsCount: 2, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' });
    const v = await git.issueView({ number: 5 });
    assert.deepEqual(v.comments.map((c) => c.body), ['Looking'], 'system notes are hidden');
    assert.equal((await git.issueCreate({ title: 'New one', body: 'b' })).number, 6);
    await git.issueComment({ number: 5, body: 'thanks' });
    await git.issueSetState({ number: 5, open: false });
    await git.issueAssignMe({ number: 5 });
    const writes = reqs.filter((r) => r.m !== 'GET').map((r) => [r.m, r.u.replace(/^\/api\/v4\/projects\/team%2Fapp/, ''), r.b]);
    assert.deepEqual(writes, [
      ['POST', '/issues', { title: 'New one', description: 'b' }],
      ['POST', '/issues/5/notes', { body: 'thanks' }],
      ['PUT', '/issues/5', { state_event: 'close' }],
      ['PUT', '/issues/5', { assignee_ids: [9, 1] }],
    ]);
    assert.ok(reqs.every((r) => r.t === 'glpat-x'));
    void identity;
  } finally { server.close(); }
});
