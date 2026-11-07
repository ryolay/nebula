const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./helpers'); // must load before git.js (sets PATH / git config)
const git = require('../src/git');

const { sh, commit, write, read, exists } = H;
const head = (d, ref = 'HEAD') => sh(d, ['rev-parse', ref]).trim();
const branch = (d) => sh(d, ['branch', '--show-current']).trim();
const byPath = (files, p) => files.find((f) => f.path === p);

// ---------------------------------------------------------------- opening
test('open: rejects a folder that is not a git repo', async () => {
  await assert.rejects(git.open(H.tmpDir('not-a-repo')), /not a git repository/i);
});

test('open: resolves a subfolder to the repo root and reports remotes', async () => {
  const { work } = H.withRemote();
  fs.mkdirSync(path.join(work, 'deep/er'), { recursive: true });
  const info = await git.open(path.join(work, 'deep/er'));
  assert.equal(fs.realpathSync(info.path), fs.realpathSync(work));
  assert.deepEqual(info.remotes, ['origin']);
  assert.match(info.remoteUrl, /origin\.git/);
});

// ---------------------------------------------------------------- empty repo
test('empty repo: log/status work, first commit can be staged, unstaged and created', async () => {
  const d = H.initRepo('empty');
  await git.open(d);
  assert.deepEqual(await git.log(), []);
  let st = await git.status();
  assert.equal(st.branch, 'main');
  assert.equal(st.oid, null);
  assert.deepEqual(st.files, []);

  write(d, 'a.txt', 'hello\n');
  await git.stage({ paths: ['a.txt'] });
  st = await git.status();
  assert.equal(byPath(st.files, 'a.txt').x, 'A');

  await git.unstage({ paths: ['a.txt'] }); // no HEAD → uses `rm --cached`
  assert.equal(byPath((await git.status()).files, 'a.txt').untracked, true);
  assert.ok(exists(d, 'a.txt'), 'unstage must not delete the file');

  await git.stageAll();
  await git.unstageAll();
  assert.equal(byPath((await git.status()).files, 'a.txt').untracked, true);

  await git.stageAll();
  await git.commitCreate({ message: 'First!' });
  const log = await git.log();
  assert.equal(log.length, 1);
  assert.equal(log[0].subject, 'First!');
  assert.deepEqual(log[0].parents, []);
  assert.deepEqual((await git.commit({ hash: log[0].hash })).files.map((f) => f.status + f.path), ['Aa.txt']);
});

// ---------------------------------------------------------------- log & refs
function richRepo() {
  const d = H.initRepo('rich');
  const c1 = commit(d, 'ada', 'Initial commit', { 'README.md': '# Demo\n' });
  commit(d, 'linus', 'Add app', { 'src/app.js': 'a\n' });
  sh(d, ['tag', 'v0.1.0']);
  sh(d, ['switch', '-q', '-c', 'feature/auth']);
  const f1 = commit(d, 'grace', 'Login', { 'src/auth.js': 'login\n' });
  commit(d, 'grace', 'Logout', { 'src/auth.js': 'login\nlogout\n' });
  sh(d, ['switch', '-q', 'main']);
  commit(d, 'octo', 'Speed up', { 'src/app.js': 'b\n' });
  sh(d, ['merge', '-q', '--no-ff', 'feature/auth', '-m', "Merge branch 'feature/auth'"]);
  sh(d, ['tag', '-a', 'v0.2.0', '-m', 'Release 0.2.0']);
  return { d, c1, f1 };
}

test('log: parents, authors, avatars, merge commits and decorations', async () => {
  const { d, c1 } = richRepo();
  await git.open(d);
  const log = await git.log();
  assert.equal(log.length, 6);
  const top = log[0];
  assert.equal(top.parents.length, 2, 'HEAD is a merge');
  assert.deepEqual(top.refs.filter((r) => r.type === 'branch'), [{ type: 'branch', name: 'main', current: true }]);
  assert.ok(top.refs.some((r) => r.type === 'tag' && r.name === 'v0.2.0'), 'annotated tag decorates its commit');
  assert.ok(log.find((c) => c.refs.some((r) => r.name === 'v0.1.0')), 'lightweight tag decorates its commit');
  assert.ok(log.find((c) => c.refs.some((r) => r.type === 'branch' && r.name === 'feature/auth' && !r.current)));
  assert.equal(log.at(-1).hash, c1);
  // avatars: GitHub noreply → avatars.githubusercontent, others → gravatar with d=404
  assert.equal(log.find((c) => c.author === 'Octo Cat').avatar, 'https://avatars.githubusercontent.com/u/583231?s=80');
  assert.match(log.find((c) => c.author === 'Ada Lovelace').avatar, /gravatar\.com\/avatar\/[0-9a-f]{32}\?s=80&d=404/);
  // children always come before parents (required by the graph layout)
  const idx = new Map(log.map((c, i) => [c.hash, i]));
  for (const c of log) for (const p of c.parents) assert.ok(idx.get(p) > idx.get(c.hash));
});

test('log: honours the limit and survives subjects with separators and unicode', async () => {
  const d = H.initRepo('weird');
  for (let i = 0; i < 30; i++) commit(d, 'ada', `c${i}`, { 'f.txt': `${i}\n` });
  commit(d, 'ada', 'Fix — émojis 🚀, "quotes", a | pipe and tabs\tinside', { 'g.txt': 'x' });
  await git.open(d);
  assert.equal((await git.log({ limit: 10 })).length, 10);
  const [c] = await git.log({ limit: 1 });
  assert.equal(c.subject, 'Fix — émojis 🚀, "quotes", a | pipe and tabs\tinside');
});

test('log: includes remote-only branches and detached HEAD', async () => {
  const { work, other } = H.withRemote();
  sh(other, ['switch', '-q', '-c', 'remote-only']);
  commit(other, 'linus', 'Remote work', { 'r.txt': 'r' });
  sh(other, ['push', '-q', '-u', 'origin', 'remote-only']);
  sh(work, ['fetch', '-q']);
  await git.open(work);
  let log = await git.log();
  assert.ok(log.find((c) => c.subject === 'Remote work').refs.some((r) => r.type === 'remote' && r.name === 'origin/remote-only'));
  assert.ok(!log.some((c) => c.refs.some((r) => r.name.endsWith('/HEAD'))), 'origin/HEAD is hidden');
  sh(work, ['switch', '-q', '--detach', 'HEAD']);
  log = await git.log();
  assert.ok(log.find((c) => c.hash === head(work)).refs.some((r) => r.type === 'head'), 'detached HEAD is decorated');
  assert.equal((await git.status()).branch, null);
});

test('refs: local/remote/tags with upstream tracking counts', async () => {
  const { work, other } = H.withRemote();
  commit(other, 'linus', 'Upstream change', { 'u.txt': 'u' });
  sh(other, ['push', '-q']);
  commit(work, 'ada', 'Local change', { 'l.txt': 'l' });
  sh(work, ['fetch', '-q']);
  sh(work, ['tag', 'v1']);
  await git.open(work);
  const r = await git.refs();
  const main = r.local.find((b) => b.name === 'main');
  assert.equal(main.current, true);
  assert.equal(main.upstream, 'origin/main');
  assert.equal(main.ahead, 1);
  assert.equal(main.behind, 1);
  assert.deepEqual(r.remote.map((x) => x.name), ['origin/main']);
  assert.deepEqual(r.tags.map((t) => t.name), ['v1']);
});

// ---------------------------------------------------------------- status
test('status: modified, added, deleted, renamed, untracked, spaces and unicode in names', async () => {
  const d = H.initRepo('status');
  commit(d, 'ada', 'base', { 'keep.txt': 'k\n', 'del.txt': 'd\n', 'old name.txt': 'same content for rename detection\n', 'mod.txt': '1\n' });
  await git.open(d);
  write(d, 'mod.txt', '2\n');
  fs.rmSync(path.join(d, 'del.txt'));
  sh(d, ['mv', 'old name.txt', 'new name é.txt']);
  write(d, 'dir with space/ünïcødé file.md', 'new\n');
  write(d, 'staged.txt', 's\n');
  sh(d, ['add', 'staged.txt']);
  write(d, 'staged.txt', 's\nmore\n'); // staged AND unstaged changes

  const st = await git.status();
  assert.deepEqual(byPath(st.files, 'mod.txt'), { x: ' ', y: 'M', path: 'mod.txt' });
  assert.deepEqual(byPath(st.files, 'del.txt'), { x: ' ', y: 'D', path: 'del.txt' });
  assert.deepEqual(byPath(st.files, 'new name é.txt'), { x: 'R', y: ' ', path: 'new name é.txt', orig: 'old name.txt' });
  assert.equal(byPath(st.files, 'dir with space/ünïcødé file.md').untracked, true);
  assert.deepEqual(byPath(st.files, 'staged.txt'), { x: 'A', y: 'M', path: 'staged.txt' });
  assert.equal(st.state, null);
});

// ---------------------------------------------------------------- staging
test('stage / unstage / discard on tracked, untracked and deleted files', async () => {
  const d = H.initRepo('stage');
  commit(d, 'ada', 'base', { 'a.txt': 'a\n', 'b.txt': 'b\n' });
  await git.open(d);
  write(d, 'a.txt', 'changed\n');
  fs.rmSync(path.join(d, 'b.txt'));
  write(d, 'new.txt', 'n\n');
  write(d, '-dash.txt', 'option-looking file name\n');

  await git.stage({ paths: ['a.txt', 'b.txt', 'new.txt', '-dash.txt'] }); // deleted + dash-prefixed paths
  let st = await git.status();
  assert.deepEqual(st.files.map((f) => f.x + f.path).sort(), ['A-dash.txt', 'Ma.txt', 'Anew.txt', 'Db.txt'].sort());

  await git.unstage({ paths: ['a.txt', 'b.txt'] });
  st = await git.status();
  assert.equal(byPath(st.files, 'a.txt').y, 'M');
  assert.equal(byPath(st.files, 'b.txt').y, 'D');

  await git.discard({ paths: ['a.txt', 'b.txt'] });
  assert.equal(read(d, 'a.txt'), 'a\n');
  assert.equal(read(d, 'b.txt'), 'b\n');

  await git.unstageAll();
  await git.discard({ paths: ['new.txt'], untracked: true });
  assert.equal(exists(d, 'new.txt'), false);
  assert.equal(exists(d, '-dash.txt'), true, 'other untracked file untouched');
});

// ---------------------------------------------------------------- commit
test('commitCreate: multi-line messages, amend, empty message rejected, lastMessage', async () => {
  const d = H.initRepo('commit');
  commit(d, 'ada', 'base', { 'a.txt': 'a' });
  await git.open(d);
  await assert.rejects(git.commitCreate({ message: '   ' }), /empty/);
  write(d, 'a.txt', 'b');
  await git.stageAll();
  await git.commitCreate({ message: 'Summary line\n\nBody with "quotes", $VARS and `backticks`\n- bullet' });
  assert.equal(sh(d, ['log', '-1', '--format=%B']).trim(), 'Summary line\n\nBody with "quotes", $VARS and `backticks`\n- bullet');
  assert.match(await git.lastMessage(), /^Summary line/);
  const before = head(d);
  write(d, 'c.txt', 'c');
  await git.stageAll();
  await git.commitCreate({ message: 'Amended summary', amend: true });
  assert.notEqual(head(d), before);
  assert.equal(sh(d, ['rev-list', '--count', 'HEAD']).trim(), '2', 'amend does not add a commit');
  assert.equal(sh(d, ['log', '-1', '--format=%s']).trim(), 'Amended summary');
  await assert.rejects(git.commitCreate({ message: 'nothing staged' }), /nothing to commit|no changes/i);
});

// ---------------------------------------------------------------- commit details & diffs
test('commit details: files, numstat, renames, binary, merge vs first parent, root commit', async () => {
  const d = H.initRepo('details');
  const root = commit(d, 'ada', 'root', { 'a.txt': 'one\ntwo\n', 'mv-me.txt': 'a long enough line so rename detection kicks in\n' });
  sh(d, ['mv', 'mv-me.txt', 'moved.txt']);
  fs.writeFileSync(path.join(d, 'img.bin'), Buffer.from([0, 1, 2, 0, 255, 0]));
  const c2 = commit(d, 'linus', 'Second\n\nWith a body', { 'a.txt': 'one\nTWO\nthree\n' });
  await git.open(d);

  const det = await git.commit({ hash: c2 });
  assert.equal(det.message, 'Second\n\nWith a body');
  assert.equal(det.author, 'Linus Torvalds');
  assert.deepEqual(det.parents, [root]);
  assert.deepEqual(byPath(det.files, 'a.txt'), { status: 'M', path: 'a.txt', add: 2, del: 1 });
  assert.deepEqual(byPath(det.files, 'moved.txt'), { status: 'R', orig: 'mv-me.txt', path: 'moved.txt', add: 0, del: 0 });
  assert.deepEqual(byPath(det.files, 'img.bin'), { status: 'A', path: 'img.bin', add: null, del: null });

  const rootDet = await git.commit({ hash: root });
  assert.equal(rootDet.files.length, 2);

  // merge: files shown are the diff against the first parent only
  sh(d, ['switch', '-q', '-c', 'side']);
  commit(d, 'grace', 'side work', { 'side.txt': 's\n' });
  sh(d, ['switch', '-q', 'main']);
  commit(d, 'ada', 'main work', { 'main.txt': 'm\n' });
  sh(d, ['merge', '-q', '--no-ff', 'side', '-m', 'merge side']);
  const merge = await git.commit({ hash: head(d) });
  assert.equal(merge.parents.length, 2);
  assert.deepEqual(merge.files.map((f) => f.path), ['side.txt']);

  // diffs
  assert.match(await git.diff({ path: 'a.txt', mode: 'commit', hash: c2 }), /^-two\n\+TWO\n\+three$/m);
  assert.match(await git.diff({ path: 'side.txt', mode: 'commit', hash: head(d) }), /\+s/);
  assert.match(await git.diff({ path: 'a.txt', mode: 'commit', hash: root }), /new file mode/);
  assert.match(await git.diff({ path: 'img.bin', mode: 'commit', hash: c2 }), /Binary files/);

  await assert.rejects(git.commit({ hash: 'not-a-hash' }), /Invalid commit hash/);
  await assert.rejects(git.commit({ hash: 'deadbeefdeadbeef' }), /unknown revision|bad object|ambiguous/i);
});

test('diff: unstaged, staged, untracked and files with spaces', async () => {
  const d = H.initRepo('diffs');
  commit(d, 'ada', 'base', { 'a b.txt': '1\n' });
  await git.open(d);
  write(d, 'a b.txt', '1\n2\n');
  assert.match(await git.diff({ path: 'a b.txt', mode: 'unstaged' }), /^\+2$/m);
  assert.equal(await git.diff({ path: 'a b.txt', mode: 'staged' }), '');
  sh(d, ['add', '.']);
  assert.match(await git.diff({ path: 'a b.txt', mode: 'staged' }), /^\+2$/m);
  write(d, 'fresh.txt', 'hello\n');
  assert.match(await git.diff({ path: 'fresh.txt', mode: 'unstaged', untracked: true }), /new file mode[\s\S]*\+hello/);
});

// ---------------------------------------------------------------- branches
test('branches: create (+checkout), invalid names, rename, delete safe/force', async () => {
  const { d } = richRepo();
  await git.open(d);
  await assert.rejects(git.createBranch({ name: 'bad..name' }), /not a valid branch name/);
  await assert.rejects(git.createBranch({ name: '--force' }), /Invalid branch name/);
  await assert.rejects(git.createBranch({ name: 'with space' }), /not a valid branch name/);

  await git.createBranch({ name: 'feat/x', checkout: false });
  assert.equal(branch(d), 'main');
  await git.createBranch({ name: 'feat/y', checkout: true });
  assert.equal(branch(d), 'feat/y');

  const c1 = sh(d, ['rev-list', '--max-parents=0', 'HEAD']).trim();
  await git.createBranch({ name: 'from-root', from: c1, checkout: false });
  assert.equal(head(d, 'from-root'), c1);

  await git.renameBranch({ name: 'feat/x', to: 'feat/renamed' });
  assert.ok(sh(d, ['branch', '--list', 'feat/renamed']).includes('feat/renamed'));

  commit(d, 'ada', 'unmerged work', { 'u.txt': 'u' }); // on feat/y
  await git.checkout({ ref: 'main' });
  await assert.rejects(git.deleteBranch({ name: 'feat/y' }), /not fully merged/);
  await git.deleteBranch({ name: 'feat/y', force: true });
  assert.equal(sh(d, ['branch', '--list', 'feat/y']).trim(), '');
});

test('checkout: local branch, detached commit, remote branch creates tracking branch (and reuses it)', async () => {
  const { work, other } = H.withRemote();
  sh(other, ['switch', '-q', '-c', 'feature/remote']);
  commit(other, 'linus', 'remote feature', { 'f.txt': 'f' });
  sh(other, ['push', '-q', '-u', 'origin', 'feature/remote']);
  sh(work, ['fetch', '-q']);
  await git.open(work);

  await git.checkout({ ref: 'origin/feature/remote', remote: true });
  assert.equal(branch(work), 'feature/remote');
  assert.equal(sh(work, ['rev-parse', '--abbrev-ref', '@{u}']).trim(), 'origin/feature/remote');
  await git.checkout({ ref: 'main' });
  await git.checkout({ ref: 'origin/feature/remote', remote: true }); // local already exists → plain switch
  assert.equal(branch(work), 'feature/remote');

  const h = head(work, 'main');
  await git.checkoutCommit({ hash: h });
  assert.equal(branch(work), '');
  assert.equal(head(work), h);
  await assert.rejects(git.checkout({ ref: '--orphan' }), /Invalid ref/);
});

test('merge, rebase, cherry-pick, revert', async () => {
  const d = H.initRepo('history-ops');
  commit(d, 'ada', 'base', { 'a.txt': 'a\n' });
  sh(d, ['switch', '-q', '-c', 'topic']);
  const t1 = commit(d, 'linus', 'topic 1', { 't.txt': '1\n' });
  sh(d, ['switch', '-q', 'main']);
  commit(d, 'grace', 'main 1', { 'm.txt': '1\n' });
  await git.open(d);

  // cherry-pick
  await git.cherryPick({ hash: t1 });
  assert.equal(read(d, 't.txt'), '1\n');
  assert.equal(sh(d, ['log', '-1', '--format=%s']).trim(), 'topic 1');
  // revert
  await git.revert({ hash: head(d) });
  assert.equal(exists(d, 't.txt'), false);
  assert.match(sh(d, ['log', '-1', '--format=%s']).trim(), /^Revert "topic 1"/);
  // merge
  await git.merge({ ref: 'topic' });
  assert.equal(sh(d, ['rev-list', '--parents', '-1', 'HEAD']).trim().split(' ').length, 3, 'merge commit');
  // rebase topic onto main
  sh(d, ['switch', '-q', '-c', 'topic2', 'HEAD~1']);
  commit(d, 'octo', 'topic2 work', { 'z.txt': 'z\n' });
  await git.rebase({ ref: 'main' });
  assert.equal(sh(d, ['merge-base', '--is-ancestor', 'main', 'HEAD'], {}) , '');
});

test('reset soft / mixed / hard', async () => {
  const d = H.initRepo('reset');
  const c1 = commit(d, 'ada', 'one', { 'a.txt': '1\n' });
  commit(d, 'ada', 'two', { 'a.txt': '2\n' });
  await git.open(d);
  await assert.rejects(git.reset({ hash: c1, mode: 'keep' }), /Invalid reset mode/);

  await git.reset({ hash: c1, mode: 'soft' });
  assert.equal(head(d), c1);
  assert.equal(byPath((await git.status()).files, 'a.txt').x, 'M', 'soft keeps staged');
  sh(d, ['commit', '-q', '-m', 'two again']);

  await git.reset({ hash: c1, mode: 'mixed' });
  const f = byPath((await git.status()).files, 'a.txt');
  assert.equal(f.x + f.y, ' M', 'mixed keeps working copy unstaged');
  sh(d, ['commit', '-q', '-am', 'two again']);

  await git.reset({ hash: c1, mode: 'hard' });
  assert.equal(read(d, 'a.txt'), '1\n');
  assert.deepEqual((await git.status()).files, []);
});

test('tags: create and delete; injection rejected', async () => {
  const d = H.initRepo('tags');
  const c = commit(d, 'ada', 'one', { 'a.txt': '1' });
  await git.open(d);
  await git.createTag({ name: 'v9.9.9', hash: c });
  assert.equal(head(d, 'v9.9.9^{}'), c);
  await assert.rejects(git.createTag({ name: '-d', hash: c }), /Invalid tag/);
  await git.deleteTag({ name: 'v9.9.9' });
  assert.equal(sh(d, ['tag']).trim(), '');
});

// ---------------------------------------------------------------- conflicts
test('merge conflict: status reports merging + conflicted file, abort restores', async () => {
  const d = H.initRepo('conflict');
  commit(d, 'ada', 'base', { 'c.txt': 'base\n' });
  sh(d, ['switch', '-q', '-c', 'other']);
  commit(d, 'linus', 'theirs', { 'c.txt': 'theirs\n' });
  sh(d, ['switch', '-q', 'main']);
  const mine = commit(d, 'grace', 'ours', { 'c.txt': 'ours\n' });
  await git.open(d);
  assert.equal((await git.merge({ ref: 'other' })).conflicts, 1, 'conflicts are reported as a state, not thrown');
  const st = await git.status();
  assert.equal(st.state, 'merging');
  assert.deepEqual(byPath(st.files, 'c.txt'), { x: 'U', y: 'U', path: 'c.txt', conflict: true, ckind: 'UU' });
  await git.abort();
  assert.equal((await git.status()).state, null);
  assert.equal(head(d), mine);
  await assert.rejects(git.abort(), /Nothing to abort/);
});

test('cherry-pick conflict is detected and abortable', async () => {
  const d = H.initRepo('cp-conflict');
  commit(d, 'ada', 'base', { 'c.txt': 'base\n' });
  sh(d, ['switch', '-q', '-c', 'other']);
  const t = commit(d, 'linus', 'theirs', { 'c.txt': 'theirs\n' });
  sh(d, ['switch', '-q', 'main']);
  commit(d, 'grace', 'ours', { 'c.txt': 'ours\n' });
  await git.open(d);
  assert.equal((await git.cherryPick({ hash: t })).conflicts, 1);
  assert.equal((await git.status()).state, 'cherry-picking');
  await git.abort();
  assert.equal((await git.status()).state, null);
});

// ---------------------------------------------------------------- stashes
test('stash: push (incl. untracked, with message), list, apply, pop, drop', async () => {
  const d = H.initRepo('stash');
  commit(d, 'ada', 'base', { 'a.txt': 'a\n' });
  await git.open(d);
  await git.stash({ message: 'nothing to stash' }); // clean tree: git says "No local changes to save"
  assert.equal((await git.stashes()).length, 0);

  write(d, 'a.txt', 'changed\n');
  write(d, 'untracked.txt', 'u\n');
  await git.stash({ message: 'my experiment' });
  assert.deepEqual((await git.status()).files, [], 'tree clean after stash, untracked included');
  write(d, 'a.txt', 'second\n');
  await git.stash({});

  let list = await git.stashes();
  assert.equal(list.length, 2);
  assert.match(list[1].message, /my experiment/);
  assert.equal(list[0].ref, 'stash@{0}');

  // stash details can be shown like a commit
  const det = await git.commit({ hash: list[1].hash });
  assert.deepEqual(det.files.map((f) => f.path), ['a.txt']);

  await git.stashApply({ ref: 'stash@{1}' });
  assert.equal(read(d, 'untracked.txt'), 'u\n');
  assert.equal((await git.stashes()).length, 2, 'apply keeps the stash');
  sh(d, ['reset', '-q', '--hard']); sh(d, ['clean', '-qfd']);

  await git.stashPop({}); // latest
  assert.equal(read(d, 'a.txt'), 'second\n');
  list = await git.stashes();
  assert.equal(list.length, 1);

  await git.stashDrop({ ref: 'stash@{0}' });
  assert.equal((await git.stashes()).length, 0);
  await assert.rejects(git.stashDrop({ ref: 'stash@{0}; rm -rf /' }), /Invalid stash/);
  await assert.rejects(git.stashApply({ ref: '--index' }), /Invalid stash/);
});

// ---------------------------------------------------------------- remotes
test('remote: push sets upstream, fetch sees behind, pull fast-forwards, ahead counts, delete remote branch', async () => {
  const { origin, work, other } = H.withRemote();
  await git.open(work);

  // new branch with no upstream → push -u origin HEAD
  await git.createBranch({ name: 'feature/push-me', checkout: true });
  commit(work, 'ada', 'push me', { 'p.txt': 'p' });
  let st = await git.status();
  assert.equal(st.upstream, null);
  await git.push();
  st = await git.status();
  assert.equal(st.upstream, 'origin/feature/push-me');
  assert.equal(head(origin, 'feature/push-me'), head(work));

  // collaborator pushes to main → fetch → behind 1 → pull
  await git.checkout({ ref: 'main' });
  commit(other, 'linus', 'collab change', { 'collab.txt': 'c' });
  sh(other, ['push', '-q']);
  await git.fetch();
  st = await git.status();
  assert.equal(st.behind, 1);
  await git.pull();
  st = await git.status();
  assert.equal(st.behind, 0);
  assert.equal(read(work, 'collab.txt'), 'c');

  // local commit → ahead 1 → push
  commit(work, 'ada', 'local', { 'l.txt': 'l' });
  assert.equal((await git.status()).ahead, 1);
  await git.push();
  assert.equal((await git.status()).ahead, 0);
  assert.equal(head(origin, 'main'), head(work));

  // pushBranch for a non-current branch
  await git.createBranch({ name: 'side', checkout: false });
  await git.pushBranch({ name: 'side' });
  assert.equal(head(origin, 'side'), head(work, 'side'));

  // delete on remote; fetch --prune removes the remote-tracking ref
  await git.deleteRemoteBranch({ name: 'origin/side' });
  await git.fetch();
  assert.ok(!(await git.refs()).remote.some((r) => r.name === 'origin/side'));
});

test('remote: diverged pull refuses (ff-only) without touching the tree; push rejected then force-with-lease', async () => {
  const { work, other } = H.withRemote();
  await git.open(work);
  commit(other, 'linus', 'theirs', { 't.txt': 't' });
  sh(other, ['push', '-q']);
  commit(work, 'ada', 'mine', { 'm.txt': 'm' });
  const mine = head(work);
  await assert.rejects(git.pull({ mode: 'ff-only' }), /Not possible to fast-forward|diverg/i);
  assert.equal(head(work), mine);
  await assert.rejects(git.pull({ mode: 'bogus' }), /Invalid pull mode/);
  await assert.rejects(git.push(), /rejected|fetch first/i);
  await git.fetch();
  const r = await git.push({ force: true });
  assert.match(r.summary, /^Force-pushed .* to origin\/main$/);
  assert.equal(sh(other, ['ls-remote', 'origin', 'main']).split('\t')[0], mine);
});

test('pull modes: default merges a diverged branch, rebase replays local commits; summaries count commits', async () => {
  const { work, other } = H.withRemote();
  await git.open(work);
  commit(other, 'linus', 'theirs 1', { 't1.txt': '1' });
  commit(other, 'linus', 'theirs 2', { 't2.txt': '2' });
  sh(other, ['push', '-q']);
  // fast-forward: only remote commits
  let r = await git.pull();
  assert.equal(r.summary, 'Pulled 2 commits into main');
  assert.equal((await git.pull()).summary, 'main is already up to date');
  // diverged + default mode → merge commit
  commit(other, 'linus', 'theirs 3', { 't3.txt': '3' });
  sh(other, ['push', '-q']);
  commit(work, 'ada', 'mine 1', { 'm1.txt': '1' });
  r = await git.pull();
  assert.equal(sh(work, ['rev-list', '--parents', '-1', 'HEAD']).split(' ').length, 3, 'merge commit created');
  assert.match(r.summary, /^Pulled \d+ commits? into main$/);
  // diverged + rebase → linear history, local commit on top
  await git.push();
  commit(other, 'grace', 'theirs 4', { 't4.txt': '4' });
  sh(other, ['pull', '-q', '--no-rebase']); sh(other, ['push', '-q']);
  commit(work, 'ada', 'mine 2', { 'm2.txt': '2' });
  r = await git.pull({ mode: 'rebase' });
  assert.match(r.summary, /\(rebased\)$/);
  assert.equal(sh(work, ['log', '-1', '--format=%s']).trim(), 'mine 2');
  assert.equal(sh(work, ['rev-list', '--parents', '-1', 'HEAD']).split(' ').length, 2, 'no merge commit');
  // fetch summary + no-upstream pull error
  commit(other, 'linus', 'theirs 5', { 't5.txt': '5' });
  sh(other, ['push', '-q']);
  assert.match((await git.fetch()).summary, /^Fetched — 1 ref updated$/);
  assert.equal((await git.fetch()).summary, 'Fetched — everything up to date');
  await git.createBranch({ name: 'lonely', checkout: true });
  await assert.rejects(git.pull(), /no upstream branch/);
  assert.equal((await git.push()).summary, 'Published lonely to origin');
  assert.equal((await git.push({ tags: true })).summary, 'Pushed tags to origin');
});

test('push without any remote gives a clear error', async () => {
  const d = H.initRepo('no-remote');
  commit(d, 'ada', 'x', { 'x': 'x' });
  await git.open(d);
  await assert.rejects(git.push(), /No remote configured/);
});

// ---------------------------------------------------------------- pull requests (fake gh)
const ghRoute = { provider: 'github', remote: { host: 'github.com', protocol: 'https', scheme: 'https', path: 'acme/demo' }, token: 'tok-routed', account: { id: 'github:github.com/work' } };
test.beforeEach(() => git.setAuthResolver(async () => ghRoute));
test.after(() => git.setAuthResolver(null));
test('PRs: list parses gh JSON and asks for the right fields', { skip: H.POSIX_ONLY }, async () => {
  const { work } = H.withRemote();
  await git.open(work);
  H.resetGh();
  const items = [{ number: 42, title: 'Add dark mode', author: { login: 'octocat' }, headRefName: 'feat/dark', baseRefName: 'main', isDraft: false, url: 'https://github.com/acme/demo/pull/42', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', reviewDecision: 'APPROVED', additions: 10, deletions: 2, changedFiles: 3, labels: [], body: 'hi', state: 'OPEN' }];
  fs.writeFileSync(H.GH_JSON, JSON.stringify(items));
  const r = await git.prs();
  assert.equal(r.available, true);
  assert.deepEqual(r.items, items);
  const [call] = H.ghCalls();
  assert.deepEqual(call.slice(0, 6), ['pr', 'list', '--state', 'open', '--limit', '50']);
  assert.deepEqual(call.slice(-2), ['--repo', 'github.com/acme/demo']);
  assert.match(call[7], /number,title,author,headRefName/);
  const last = H.ghLog().at(-1);
  assert.equal(last.token, 'tok-routed', "gh runs with the repo's account token, not the global active one");
  assert.equal(last.host, 'github.com');
});

test('PRs: repo without a GitHub/GitLab remote says so', async () => {
  git.setAuthResolver(async () => null);
  const r = await git.prs();
  assert.equal(r.available, false);
  assert.match(r.error, /No GitHub or GitLab remote/);
});

test('PRs: gh failure is reported as unavailable, not thrown', { skip: H.POSIX_ONLY }, async () => {
  H.resetGh();
  fs.writeFileSync(H.GH_FAIL, '1');
  const r = await git.prs();
  assert.equal(r.available, false);
  assert.match(r.error, /gh auth login/);
  H.resetGh();
});

test('PRs: create / checkout / merge pass safe arguments to gh', { skip: H.POSIX_ONLY }, async () => {
  H.resetGh();
  await git.prCreate({ title: 'My PR; rm -rf ~', body: 'Body\nline 2', base: 'main', draft: true });
  await git.prCheckout({ number: '17abc' });
  await git.prMerge({ number: 17, method: 'squash' });
  await assert.rejects(git.prMerge({ number: 17, method: 'admin' }), /Invalid merge method/);
  await assert.rejects(git.prCreate({ title: '' }), /title is required/);
  await assert.rejects(git.prCreate({ title: 't', base: '--repo=evil/x' }), /Invalid base/);
  const R = ['--repo', 'github.com/acme/demo'];
  assert.deepEqual(H.ghCalls(), [
    ['pr', 'create', '--title', 'My PR; rm -rf ~', '--body', 'Body\nline 2', '--head', 'main', '--base', 'main', '--draft', ...R],
    ['pr', 'checkout', '17', ...R],
    ['pr', 'merge', '17', '--squash', ...R],
  ]);
});

// ---------------------------------------------------------------- argument-injection guards
test('guards: option-looking refs, hashes and null bytes are refused before reaching git', async () => {
  const d = H.initRepo('guards');
  commit(d, 'ada', 'x', { 'x': 'x' });
  await git.open(d);
  await assert.rejects(git.merge({ ref: '--upload-pack=touch /tmp/pwned' }), /Invalid ref/);
  await assert.rejects(git.rebase({ ref: '-i' }), /Invalid ref/);
  await assert.rejects(git.cherryPick({ hash: 'HEAD; ls' }), /Invalid commit hash/);
  await assert.rejects(git.revert({ hash: '--abort' }), /Invalid commit hash/);
  await assert.rejects(git.deleteBranch({ name: '-D' }), /Invalid branch/);
  await assert.rejects(git.stage({ paths: ['a\0b'] }), /Invalid path/);
  await assert.rejects(git.diff({ path: 'x', mode: 'commit', hash: '--output=/tmp/x' }), /Invalid commit hash/);
});
