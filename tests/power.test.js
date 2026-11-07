const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./helpers');
const git = require('../src/git');

const { sh, commit, write, read } = H;
const head = (d, ref = 'HEAD') => sh(d, ['rev-parse', ref]).trim();
const subjects = (d, n = 20) => sh(d, ['log', `-${n}`, '--format=%s']).trim().split('\n');

/** main and topic both edit the same line of c.txt */
function conflicted(name = 'cf') {
  const d = H.initRepo(name);
  commit(d, 'ada', 'base', { 'c.txt': 'one\nshared\nthree\n', 'other.txt': 'x\n' });
  sh(d, ['switch', '-q', '-c', 'topic']);
  commit(d, 'linus', 'topic edit', { 'c.txt': 'one\nTOPIC\nthree\n' });
  sh(d, ['switch', '-q', 'main']);
  commit(d, 'grace', 'main edit', { 'c.txt': 'one\nMAIN\nthree\n' });
  return d;
}

test.beforeEach(() => git.setAuthResolver(null));

// ---------------------------------------------------------------- conflicts are a state, not an error
test('merge conflict: result (not exception), op details, parsed blocks, continue with message', async () => {
  const d = conflicted();
  await git.open(d);
  const r = await git.merge({ ref: 'topic' });
  assert.equal(r.conflicts, 1);
  assert.equal(r.summary, 'Merge stopped — 1 conflict to resolve');
  const st = await git.status();
  assert.equal(st.state, 'merging');
  assert.equal(st.conflicts, 1);
  assert.deepEqual({ kind: st.op.kind, incoming: st.op.incoming, current: st.op.current }, { kind: 'merging', incoming: 'topic', current: 'main' });
  assert.match(st.op.message, /^Merge branch 'topic'/);

  const cf = await git.conflictFile({ path: 'c.txt' });
  assert.equal(cf.kind, 'UU');
  assert.equal(cf.conflicts, 1);
  assert.deepEqual(cf.segments, [
    { type: 'text', lines: ['one'] },
    { type: 'conflict', ours: ['MAIN'], base: null, theirs: ['TOPIC'], oursLabel: 'HEAD', theirsLabel: 'topic' },
    { type: 'text', lines: ['three'] },
  ]);

  await assert.rejects(git.continueOp(), /Resolve the 1 remaining conflict/);
  await assert.rejects(git.saveResolution({ path: 'c.txt', content: '<<<<<<< HEAD\nx\n' }), /still contains conflict markers/);
  await git.saveResolution({ path: 'c.txt', content: 'one\nMAIN\nTOPIC\nthree\n' });
  assert.equal((await git.status()).conflicts, 0);
  const done = await git.continueOp({ message: "Merge branch 'topic' (resolved)" });
  assert.equal(done.summary, 'Merged topic into main');
  assert.equal((await git.status()).state, null);
  assert.equal(read(d, 'c.txt'), 'one\nMAIN\nTOPIC\nthree\n');
  assert.equal(sh(d, ['log', '-1', '--format=%s']).trim(), "Merge branch 'topic' (resolved)");
  assert.equal(sh(d, ['rev-list', '--parents', '-1', 'HEAD']).trim().split(' ').length, 3);
});

test('resolveFile: take ours / theirs for a whole file', async () => {
  for (const [side, expected] of [['ours', 'MAIN'], ['theirs', 'TOPIC']]) {
    const d = conflicted(`side-${side}`);
    await git.open(d);
    await git.merge({ ref: 'topic' });
    await git.resolveFile({ path: 'c.txt', side });
    assert.equal(read(d, 'c.txt'), `one\n${expected}\nthree\n`);
    assert.equal((await git.status()).conflicts, 0);
  }
  await assert.rejects(git.resolveFile({ path: 'c.txt', side: 'both' }), /Invalid side/);
});

test('deleted-by-them conflict: taking theirs removes the file, ours keeps it', async () => {
  const mk = (n) => {
    const d = H.initRepo(n);
    commit(d, 'ada', 'base', { 'gone.txt': 'v1\n' });
    sh(d, ['switch', '-q', '-c', 'topic']);
    commit(d, 'linus', 'delete it', { 'gone.txt': null });
    sh(d, ['switch', '-q', 'main']);
    commit(d, 'grace', 'edit it', { 'gone.txt': 'v2\n' });
    return d;
  };
  let d = mk('del-theirs');
  await git.open(d);
  assert.equal((await git.merge({ ref: 'topic' })).conflicts, 1);
  const cf = await git.conflictFile({ path: 'gone.txt' });
  assert.equal(cf.kind, 'UD');
  assert.deepEqual([cf.hasOurs, cf.hasTheirs], [true, false]);
  await git.resolveFile({ path: 'gone.txt', side: 'theirs' });
  assert.equal(fs.existsSync(path.join(d, 'gone.txt')), false);
  await git.continueOp();
  d = mk('del-ours');
  await git.open(d);
  await git.merge({ ref: 'topic' });
  await git.resolveFile({ path: 'gone.txt', side: 'ours' });
  assert.equal(read(d, 'gone.txt'), 'v2\n');
});

test('diff3 base sections, multiple blocks and CRLF are parsed', () => {
  const t = 'a\r\n<<<<<<< HEAD\r\nmine\r\n||||||| base\r\norig\r\n=======\r\ntheirs\r\n>>>>>>> feat\r\nb\r\n<<<<<<< HEAD\r\n=======\r\nadded\r\n>>>>>>> feat\r\n';
  const r = git.parseConflicts(t);
  assert.equal(r.eol, '\r\n');
  assert.equal(r.conflicts, 2);
  assert.deepEqual(r.segments[1], { type: 'conflict', ours: ['mine'], base: ['orig'], theirs: ['theirs'], oursLabel: 'HEAD', theirsLabel: 'feat' });
  assert.deepEqual(r.segments[3].ours, []);
  assert.equal(r.finalNewline, true);
  // ======= inside normal text is not a marker
  assert.equal(git.parseConflicts('title\n=======\nbody\n').conflicts, 0);
});

test('paths are confined to the repository', async () => {
  const d = conflicted('confine');
  await git.open(d);
  await git.merge({ ref: 'topic' });
  await assert.rejects(git.conflictFile({ path: '../../etc/passwd' }), /outside the repository/);
  await assert.rejects(git.saveResolution({ path: '../evil.txt', content: 'x' }), /outside the repository/);
  await assert.rejects(git.markResolved({ path: 'c.txt' }), /still contains conflict markers/);
});

test('rebase conflict: step N/M, onto, skip and continue; abort restores', async () => {
  const d = H.initRepo('rb');
  commit(d, 'ada', 'base', { 'c.txt': 'shared\n' });
  sh(d, ['switch', '-q', '-c', 'topic']);
  commit(d, 'linus', 't1 conflicting', { 'c.txt': 'TOPIC\n' });
  commit(d, 'linus', 't2 clean', { 't2.txt': 't2\n' });
  sh(d, ['switch', '-q', 'main']);
  commit(d, 'grace', 'main edit', { 'c.txt': 'MAIN\n' });
  sh(d, ['switch', '-q', 'topic']);
  await git.open(d);
  const before = head(d);
  const r = await git.rebase({ ref: 'main' });
  assert.equal(r.conflicts, 1);
  let st = await git.status();
  assert.equal(st.state, 'rebasing');
  assert.deepEqual({ current: st.op.current, onto: st.op.onto, step: st.op.step, total: st.op.total }, { current: 'topic', onto: 'main', step: 1, total: 2 });
  assert.match(st.op.incoming, /t1 conflicting/);
  await git.abort();
  assert.equal(head(d), before);

  // again, this time resolve with theirs (= the commit being replayed) and continue
  await git.rebase({ ref: 'main' });
  await git.resolveFile({ path: 'c.txt', side: 'theirs' });
  const done = await git.continueOp();
  assert.equal(done.summary, 'Rebased topic onto main');
  assert.deepEqual(subjects(d, 4), ['t2 clean', 't1 conflicting', 'main edit', 'base']);

  // a step that becomes empty after resolution is skipped automatically
  const e = H.initRepo('rb-empty');
  commit(e, 'ada', 'base', { 'c.txt': 'shared\n' });
  sh(e, ['switch', '-q', '-c', 'topic']);
  commit(e, 'linus', 'redundant', { 'c.txt': 'TOPIC\n' });
  sh(e, ['switch', '-q', 'main']);
  commit(e, 'grace', 'main edit', { 'c.txt': 'MAIN\n' });
  sh(e, ['switch', '-q', 'topic']);
  await git.open(e);
  await git.rebase({ ref: 'main' });
  await git.resolveFile({ path: 'c.txt', side: 'ours' });
  await git.continueOp();
  st = await git.status();
  assert.equal(st.state, null);
  assert.deepEqual(subjects(e, 2), ['main edit', 'base']);
});

test('cherry-pick conflict → skip; revert conflict → abort; merge cannot be skipped', async () => {
  const d = conflicted('cp');
  await git.open(d);
  const t = head(d, 'topic');
  const r = await git.cherryPick({ hash: t });
  assert.equal(r.summary, 'Cherry-pick stopped — 1 conflict to resolve');
  assert.match((await git.status()).op.incoming, /topic edit/);
  await git.skipOp();
  assert.equal((await git.status()).state, null);
  assert.equal(read(d, 'c.txt'), 'one\nMAIN\nthree\n');
  await assert.rejects(git.skipOp(), /Nothing to skip/);
  await git.merge({ ref: 'topic' });
  await assert.rejects(git.skipOp(), /only be continued or aborted/);
  await git.abort();
});

test('pull that diverges with a conflict returns a resolvable state', async () => {
  const { work, other } = H.withRemote();
  commit(other, 'linus', 'theirs', { 'README.md': 'THEIRS\n' });
  sh(other, ['push', '-q']);
  commit(work, 'ada', 'mine', { 'README.md': 'MINE\n' });
  await git.open(work);
  const r = await git.pull();
  assert.equal(r.conflicts, 1);
  assert.match(r.summary, /^Pull stopped — 1 conflict/);
  assert.equal((await git.status()).state, 'merging');
});

// ---------------------------------------------------------------- interactive rebase
function linear(name) {
  const d = H.initRepo(name);
  const c0 = commit(d, 'ada', 'base', { 'f.txt': '0\n' });
  for (const n of ['one', 'two', 'three', 'four']) commit(d, 'linus', `commit ${n}`, { [`${n}.txt`]: `${n}\n` });
  return { d, c0 };
}

test('rebasePlan lists base..HEAD oldest first and refuses merges', async () => {
  const { d, c0 } = linear('plan');
  await git.open(d);
  const plan = await git.rebasePlan({ base: c0 });
  assert.deepEqual(plan.map((c) => c.subject), ['commit one', 'commit two', 'commit three', 'commit four']);
  const m = conflicted('plan-merge');
  await git.open(m);
  await git.merge({ ref: 'topic' });
  await git.resolveFile({ path: 'c.txt', side: 'ours' });
  await git.continueOp();
  await assert.rejects(git.rebasePlan({ base: head(m, 'HEAD~2') }), /merge commits/);
});

test('rebaseInteractive: reorder, squash with combined message, reword, fixup, drop — no editor ever opens', async () => {
  const { d, c0 } = linear('irb');
  await git.open(d);
  const plan = await git.rebasePlan({ base: c0 });
  const [one, two, three, four] = plan.map((c) => c.hash);
  const r = await git.rebaseInteractive({
    base: c0,
    steps: [
      { hash: two, action: 'reword', message: 'Two, reworded\n\nwith a body' },
      { hash: one, action: 'squash' },
      { hash: four, action: 'pick', message: 'Four + three combined' },
      { hash: three, action: 'fixup' },
    ],
  });
  assert.equal(r.summary, 'Rewrote 4 commits');
  assert.deepEqual(subjects(d, 3), ['Four + three combined', 'Two, reworded', 'base']);
  assert.equal(sh(d, ['log', '-1', '--skip=1', '--format=%B']).trim(), 'Two, reworded\n\nwith a body');
  assert.deepEqual(sh(d, ['show', '--name-only', '--format=', 'HEAD~1']).trim().split('\n').sort(), ['one.txt', 'two.txt']);
  for (const f of ['one', 'two', 'three', 'four']) assert.equal(read(d, `${f}.txt`), `${f}\n`);

  // drop removes the commit and its file; works from the root too
  const plan2 = await git.rebasePlan({ base: null });
  await git.rebaseInteractive({ base: null, steps: plan2.map((c, i) => ({ hash: c.hash, action: i === 1 ? 'drop' : 'pick' })) });
  assert.deepEqual(subjects(d, 5), ['Four + three combined', 'base']);
  assert.equal(fs.existsSync(path.join(d, 'two.txt')), false);
});

test('rebaseInteractive guards: stale list, invalid action, squash first, dirty tree autostashed', async () => {
  const { d, c0 } = linear('irb-guard');
  await git.open(d);
  const plan = await git.rebasePlan({ base: c0 });
  const steps = plan.map((c) => ({ hash: c.hash, action: 'pick' }));
  await assert.rejects(git.rebaseInteractive({ base: c0, steps: steps.slice(1) }), /commit list changed/);
  await assert.rejects(git.rebaseInteractive({ base: c0, steps: [{ ...steps[0], action: 'exec rm -rf /' }, ...steps.slice(1)] }), /Invalid action/);
  await assert.rejects(git.rebaseInteractive({ base: c0, steps: [{ ...steps[0], action: 'squash' }, ...steps.slice(1)] }), /first commit cannot be squashed/);
  write(d, 'f.txt', 'dirty\n');
  await git.rebaseInteractive({ base: c0, steps: [steps[3], steps[0], steps[1], steps[2]] });
  assert.equal(read(d, 'f.txt'), 'dirty\n', 'uncommitted change survived (autostash)');
  assert.deepEqual(subjects(d, 5), ['commit three', 'commit two', 'commit one', 'commit four', 'base']);
});

test('rebaseInteractive stops on conflicts and can be continued', async () => {
  const d = H.initRepo('irb-conflict');
  const c0 = commit(d, 'ada', 'base', { 'x.txt': 'a\n' });
  const a = commit(d, 'ada', 'A', { 'x.txt': 'A\n' });
  const b = commit(d, 'ada', 'B', { 'x.txt': 'B\n' });
  await git.open(d);
  const r = await git.rebaseInteractive({ base: c0, steps: [{ hash: b, action: 'pick' }, { hash: a, action: 'pick' }] });
  assert.equal(r.conflicts, 1);
  await git.saveResolution({ path: 'x.txt', content: 'B\n' });
  const r2 = await git.continueOp();
  assert.ok(r2.conflicts === 1 || !r2.conflicts);
  if (r2.conflicts) { await git.saveResolution({ path: 'x.txt', content: 'A\n' }); await git.continueOp(); }
  assert.equal((await git.status()).state, null);
});

// ---------------------------------------------------------------- partial staging
test('applyPatch: stage one hunk, unstage it, discard a hunk from the working tree', async () => {
  const d = H.initRepo('hunks');
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  commit(d, 'ada', 'base', { 'f.txt': `${lines.join('\n')}\n` });
  lines[1] = 'CHANGED 2'; lines[27] = 'CHANGED 28';
  write(d, 'f.txt', `${lines.join('\n')}\n`);
  await git.open(d);
  const diff = await git.diff({ path: 'f.txt', mode: 'unstaged' });
  const header = diff.slice(0, diff.indexOf('@@'));
  const hunks = diff.slice(diff.indexOf('@@')).split(/(?=^@@ )/m);
  assert.equal(hunks.length, 2);
  await git.applyPatch({ patch: header + hunks[0], cached: true });
  assert.match(await git.diff({ path: 'f.txt', mode: 'staged' }), /\+CHANGED 2/);
  assert.doesNotMatch(await git.diff({ path: 'f.txt', mode: 'staged' }), /CHANGED 28/);
  const st = await git.status();
  assert.deepEqual([st.files[0].x, st.files[0].y], ['M', 'M']);
  const staged = await git.diff({ path: 'f.txt', mode: 'staged' });
  await git.applyPatch({ patch: staged, cached: true, reverse: true });
  assert.equal(await git.diff({ path: 'f.txt', mode: 'staged' }), '');
  await git.applyPatch({ patch: header + hunks[1], reverse: true });
  assert.match(read(d, 'f.txt'), /^line 28$/m);
  assert.match(read(d, 'f.txt'), /^CHANGED 2$/m);
  await assert.rejects(git.applyPatch({ patch: 'not a patch' }), /Invalid patch/);
});

// ---------------------------------------------------------------- history / blame / compare
test('fileHistory follows renames; blame attributes lines; compare counts both sides', async () => {
  const d = H.initRepo('hist');
  commit(d, 'ada', 'create', { 'old.txt': 'a\nb\n' });
  sh(d, ['mv', 'old.txt', 'new.txt']);
  commit(d, 'linus', 'rename');
  commit(d, 'grace', 'edit b', { 'new.txt': 'a\nB\n' });
  commit(d, 'ada', 'unrelated', { 'x.txt': 'x' });
  await git.open(d);
  const h = await git.fileHistory({ path: 'new.txt' });
  assert.deepEqual(h.map((c) => [c.subject, c.path]), [['edit b', 'new.txt'], ['rename', 'new.txt'], ['create', 'old.txt']]);
  const b = await git.blame({ path: 'new.txt' });
  assert.deepEqual(b.lines.map((l) => [l.text, b.commits[l.hash].author]), [['a', 'Ada Lovelace'], ['B', 'Grace Hopper']]);
  sh(d, ['switch', '-q', '-c', 'side', 'HEAD~1']);
  commit(d, 'linus', 'side work', { 's.txt': 's' });
  const c = await git.compare({ a: 'main', b: 'side' });
  assert.deepEqual([c.ahead, c.behind], [1, 1]);
  assert.deepEqual(c.files.map((f) => `${f.status}:${f.path}`), ['A:s.txt']);
  await assert.rejects(git.compare({ a: '--output=x', b: 'main' }), /Invalid ref/);
});

// ---------------------------------------------------------------- remotes / worktrees / submodules / lfs / fast-forward
test('remotes: add, rename, set-url, remove; worktrees add/list/remove; lfs detection', async () => {
  const { work, origin } = H.withRemote();
  await git.open(work);
  await git.addRemote({ name: 'upstream', url: origin });
  await git.renameRemote({ name: 'upstream', to: 'up' });
  await git.setRemoteUrl({ name: 'up', url: `${origin}/` });
  assert.deepEqual((await git.remotes()).map((r) => r.name), ['origin', 'up']);
  assert.equal((await git.fetchRemote({ name: 'up' })).summary, 'Fetched up');
  await git.removeRemote({ name: 'up' });
  assert.deepEqual((await git.remotes()).map((r) => r.name), ['origin']);
  await assert.rejects(git.addRemote({ name: '--mirror', url: 'x' }), /Invalid remote name/);

  const wt = path.join(H.tmpDir('wt-parent'), 'feature-wt');
  await git.addWorktree({ path: wt, newBranch: 'feature/wt' });
  let list = await git.worktrees();
  assert.equal(list.length, 2);
  assert.equal(list[0].main, true);
  assert.equal(list[1].branch, 'feature/wt');
  await assert.rejects(git.addWorktree({ path: 'relative', branch: 'main' }), /absolute/);
  await git.removeWorktree({ path: list[1].path });
  list = await git.worktrees();
  assert.equal(list.length, 1);

  assert.deepEqual(await git.lfsInfo(), { used: false, installed: false });
  write(work, '.gitattributes', '*.psd filter=lfs diff=lfs merge=lfs -text\n');
  assert.equal((await git.lfsInfo()).used, true);
  assert.deepEqual(await git.submodules(), []);
});

test('fastForward: moves a non-checked-out branch only when it is an ancestor', async () => {
  const d = H.initRepo('ff');
  commit(d, 'ada', 'base', { a: 'a' });
  sh(d, ['branch', 'behind']);
  commit(d, 'ada', 'ahead', { b: 'b' });
  await git.open(d);
  const r = await git.fastForward({ branch: 'behind', to: 'main' });
  assert.equal(r.summary, 'Fast-forwarded behind to main');
  assert.equal(head(d, 'behind'), head(d, 'main'));
  sh(d, ['switch', '-q', '-c', 'diverged', 'HEAD~1']);
  commit(d, 'linus', 'other', { c: 'c' });
  sh(d, ['switch', '-q', 'main']);
  await assert.rejects(git.fastForward({ branch: 'diverged', to: 'main' }), /cannot be fast-forwarded/);
});
