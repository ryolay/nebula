const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const H = require('./helpers');
const git = require('../src/git');
const { Accounts } = require('../src/accounts');

const route = { provider: 'github', remote: { host: 'github.com', protocol: 'https', scheme: 'https', path: 'acme/demo' }, token: 'tok-work', account: { login: 'work' } };
const API = { defaultBranch: 'develop', users: ['work', 'ada', 'linus'], labels: [{ name: 'bug', color: 'd73a4a', description: 'Something is broken' }, { name: 'ui', color: 'a78bfa' }], milestones: [{ title: 'v2.0', number: 4 }] };

/** origin (bare) + work clone whose remote looks like GitHub; branches: develop, feature/ok, feature/conflict */
function setup() {
  const { origin, work } = H.withRemote();
  H.sh(work, ['switch', '-q', '-c', 'develop']);
  H.commit(work, 'ada', 'develop base', { 'c.txt': 'base\n' });
  H.sh(work, ['push', '-q', '-u', 'origin', 'develop']);
  H.sh(work, ['switch', '-q', '-c', 'feature/ok']);
  H.commit(work, 'linus', 'Add search', { 's.txt': 's\n' });
  H.commit(work, 'linus', 'Polish search', { 's.txt': 's2\n' });
  H.sh(work, ['switch', '-q', 'develop']);
  H.sh(work, ['switch', '-q', '-c', 'feature/conflict']);
  H.commit(work, 'grace', 'Change c', { 'c.txt': 'MINE\n' });
  H.sh(work, ['switch', '-q', 'develop']);
  H.commit(work, 'ada', 'Change c upstream', { 'c.txt': 'THEIRS\n' });
  H.sh(work, ['push', '-q']);
  H.sh(work, ['switch', '-q', 'feature/ok']);
  H.sh(work, ['remote', 'set-url', 'origin', 'https://github.com/acme/demo.git']);
  H.sh(work, ['config', `url.${origin}.insteadOf`, 'https://github.com/acme/demo.git']);
  return { origin, work };
}
test.beforeEach(() => {
  H.resetGh();
  H.setGhAccounts([{ host: 'github.com', login: 'work', token: 'tok-work', active: true }], [], API);
  git.setAuthResolver(async () => route);
});
test.after(() => git.setAuthResolver(null));

test('prMeta: default branch, people, labels, milestones, PR template, branches — via the repo account', async () => {
  const { work } = setup();
  H.write(work, '.github/pull_request_template.md', '## What\n\n## Why\n');
  await git.open(work);
  const m = await git.prMeta();
  assert.equal(m.provider, 'github');
  assert.equal(m.repo, 'github.com/acme/demo');
  assert.equal(m.account, 'work');
  assert.equal(m.defaultBranch, 'develop');
  assert.equal(m.me, 'work');
  assert.deepEqual(m.users.map((u) => u.login), ['work', 'ada', 'linus']);
  assert.deepEqual(m.labels, [{ name: 'bug', color: 'd73a4a', description: 'Something is broken' }, { name: 'ui', color: 'a78bfa', description: '' }]);
  assert.deepEqual(m.milestones, [{ title: 'v2.0', number: 4 }]);
  assert.equal(m.template, '## What\n\n## Why\n');
  assert.equal(m.current, 'feature/ok');
  assert.ok(m.remoteBranches.includes('develop') && !m.remoteBranches.includes('feature/ok'), 'feature/ok is not pushed yet');
  assert.ok(m.localBranches.includes('feature/ok'));
  const apiCalls = H.ghLog().filter((l) => l.argv[0] === 'api');
  assert.ok(apiCalls.length >= 5 && apiCalls.every((c) => c.token === 'tok-work' && !c.argv.includes('--repo')), 'gh api calls use the repo account and no --repo flag');
});

test('prCompare: commits, files, clean vs conflicting merge (no checkout), publish state', async () => {
  const { work } = setup();
  await git.open(work);
  const ok = await git.prCompare({ base: 'develop', head: 'feature/ok' });
  assert.deepEqual(ok.commits.map((c) => c.subject), ['Polish search', 'Add search']);
  assert.deepEqual([ok.files, ok.additions, ok.deletions], [1, 1, 0]);
  assert.equal(ok.mergeable, 'clean');
  assert.deepEqual([ok.published, ok.unpushed], [false, -1]);
  const bad = await git.prCompare({ base: 'develop', head: 'feature/conflict' });
  assert.equal(bad.mergeable, 'conflicts');
  assert.deepEqual(bad.conflicts, ['c.txt']);
  assert.equal(H.sh(work, ['branch', '--show-current']).trim(), 'feature/ok', 'comparing never checks anything out');
  assert.equal(H.sh(work, ['status', '--porcelain']).trim(), '', 'and never touches the working tree');
  const none = await git.prCompare({ base: 'develop', head: 'develop' });
  assert.equal(none.commits.length, 0);
  await assert.rejects(git.prCompare({ base: 'develop', head: 'nope' }), /Branch nope not found/);
  await assert.rejects(git.prCompare({ base: '--output=x', head: 'feature/ok' }), /Invalid base/);
});

test('prCreate: publishes the branch, then opens the PR with reviewers, assignees, labels, milestone, draft', async () => {
  const { work, origin } = setup();
  await git.open(work);
  const r = await git.prCreate({ title: ' Search ', body: 'Closes #12', base: 'develop', head: 'feature/ok', draft: true, reviewers: ['ada', 'linus'], assignees: ['work'], labels: ['ui', 'bug'], milestone: 'v2.0' });
  assert.equal(H.sh(origin, ['rev-parse', 'feature/ok']).trim(), H.sh(work, ['rev-parse', 'feature/ok']).trim(), 'branch was pushed first');
  assert.equal(r.url, 'https://github.com/acme/demo/pull/99');
  assert.equal(r.number, 99);
  assert.equal(r.summary, 'Opened pull request #99');
  const call = H.ghCalls().find((c) => c[0] === 'pr' && c[1] === 'create');
  assert.deepEqual(call, ['pr', 'create', '--title', 'Search', '--body', 'Closes #12', '--head', 'feature/ok', '--base', 'develop', '--draft',
    '--reviewer', 'ada', '--reviewer', 'linus', '--assignee', 'work', '--label', 'ui', '--label', 'bug', '--milestone', 'v2.0', '--repo', 'github.com/acme/demo']);
  await assert.rejects(git.prCreate({ title: 'x', base: 'develop', head: 'feature/ok', reviewers: ['--admin'] }), /Invalid reviewer/);
  await assert.rejects(git.prCreate({ title: ' ', base: 'develop', head: 'feature/ok' }), /title is required/);
});

test('organisation repos: team reviewers are offered and sent as org/team', async () => {
  H.setGhAccounts([{ host: 'github.com', login: 'work', token: 'tok-work', active: true }], [], { ...API, teams: [{ slug: 'frontend', name: 'Frontend', description: 'Web app' }, { slug: 'platform', name: 'Platform' }] });
  const { work } = setup();
  await git.open(work);
  const m = await git.prMeta();
  assert.deepEqual(m.teams, [{ slug: 'acme/frontend', name: 'Frontend', description: 'Web app' }, { slug: 'acme/platform', name: 'Platform', description: '' }]);
  await git.prCreate({ title: 'Search', base: 'develop', head: 'feature/ok', reviewers: ['acme/frontend', 'ada'] });
  const call = H.ghCalls().find((c) => c[0] === 'pr' && c[1] === 'create');
  assert.deepEqual(call.slice(call.indexOf('--reviewer'), call.indexOf('--reviewer') + 4), ['--reviewer', 'acme/frontend', '--reviewer', 'ada']);
  // personal repos have no teams
  H.setGhAccounts([{ host: 'github.com', login: 'work', token: 'tok-work', active: true }], [], API);
  assert.deepEqual((await git.prMeta()).teams, []);
});

test('GitLab: merge request with reviewers/assignees mapped to user ids, labels and milestone', async () => {
  const reqs = [];
  const server = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      reqs.push({ m: req.method, u: req.url, b: b && JSON.parse(b) });
      const send = (j, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
      const P = '/api/v4/projects/team%2Fapp';
      if (req.url === '/api/v4/user') return send({ id: 1, username: 'me' });
      if (req.url === P) return send({ default_branch: 'main' });
      if (req.url.startsWith(`${P}/members/all`)) return send([{ id: 1, username: 'me', name: 'Me', state: 'active' }, { id: 7, username: 'bob', name: 'Bob', state: 'active' }, { id: 9, username: 'gone', state: 'blocked' }]);
      if (req.url.startsWith(`${P}/labels`)) return send([{ name: 'ci', color: '#428bca' }]);
      if (req.url.startsWith(`${P}/milestones`)) return send([{ id: 3, title: 'Q4' }]);
      if (req.method === 'POST' && req.url === `${P}/merge_requests`) return send({ iid: 12, web_url: 'https://gl/mr/12' }, 201);
      send({});
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const acc = new Accounts(H.tmpDir('ud'), { encrypt: (x) => x, decrypt: (x) => x });
    const base = `http://127.0.0.1:${server.address().port}`;
    await acc.gitlabAdd({ baseUrl: base, token: 'glpat-x' });
    const work = H.initRepo('gl-pr');
    H.commit(work, 'ada', 'base', { 'a.txt': 'a' });
    H.sh(work, ['switch', '-q', '-c', 'feature/ok']);
    H.commit(work, 'linus', 'CI fix', { 'ci.yml': 'x' });
    H.sh(work, ['remote', 'add', 'origin', `${base}/team/app.git`]);
    await git.open(work);
    git.setAuthResolver((repo) => acc.resolve(repo));
    const m = await git.prMeta();
    assert.equal(m.provider, 'gitlab');
    assert.deepEqual(m.users.map((u) => u.login), ['me', 'bob'], 'blocked users hidden');
    assert.deepEqual(m.labels, [{ name: 'ci', color: '428bca', description: '' }]);
    // the remote is not a real git server here, so skip the publish step by creating from an already "published" branch
    H.sh(work, ['update-ref', 'refs/remotes/origin/feature/ok', 'feature/ok']);
    const r = await git.prCreate({ title: 'CI fix', body: 'b', base: 'main', head: 'feature/ok', draft: true, reviewers: ['bob'], assignees: ['me'], labels: ['ci'], milestone: 'Q4' });
    assert.deepEqual(r, { url: 'https://gl/mr/12', number: 12, summary: 'Opened merge request !12' });
    const post = reqs.find((q) => q.m === 'POST');
    assert.deepEqual(post.b, { source_branch: 'feature/ok', target_branch: 'main', title: 'Draft: CI fix', description: 'b', reviewer_ids: [7], assignee_ids: [1], labels: 'ci', milestone_id: 3, remove_source_branch: false });
  } finally { server.close(); }
});
