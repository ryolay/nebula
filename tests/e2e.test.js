// End-to-end: launches the real Electron app on throwaway repos, drives the UI
// through DOM events, then verifies both the UI and the resulting git state.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./helpers');

const ELECTRON = require('electron'); // path to the binary when required from node
const APP = path.join(__dirname, '..');

function launch(repoArg, evalSrc, { userData = H.tmpDir('userdata'), confirm } = {}) {
  return new Promise((resolve, reject) => {
    const shot = path.join(H.ROOT, `shot-${Date.now()}.png`);
    const p = spawn(ELECTRON, [APP, ...(repoArg ? [repoArg] : [])], {
      env: { ...process.env, NEBULA_SNAPSHOT: shot, NEBULA_EVAL: evalSrc, NEBULA_USER_DATA: userData, NEBULA_NO_EXTERNAL: '1', ...(confirm ? { NEBULA_TEST_CONFIRM: confirm } : {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`timeout\n${out}`)); }, 90_000);
    p.on('exit', () => {
      clearTimeout(timer);
      const res = out.match(/^NEBULA_EVAL_RESULT (.*)$/m);
      const err = out.match(/^NEBULA_EVAL_ERROR (.*)$/m);
      const consoleErrors = [...out.matchAll(/^NEBULA_CONSOLE (.*)$/gm)].map((m) => m[1]);
      if (err) return reject(new Error(`eval error: ${err[1]}\n${out}`));
      if (!res) return reject(new Error(`no result from app\n${out}`));
      resolve({ result: JSON.parse(res[1]), consoleErrors, screenshot: shot, confirms: [...out.matchAll(/^NEBULA_CONFIRM (.*)$/gm)].map((m) => m[1]) });
    });
  });
}

// Runs inside the renderer. `steps` is an async function body with helpers in scope.
const script = (body) => `(async () => {
  const $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, what, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { try { const v = fn(); if (v) return v; } catch {} await sleep(60); } throw new Error('timeout waiting for ' + what); };
  const click = (el) => { if (typeof el === 'string') { const n = $(el); if (!n) throw new Error('missing ' + el); el = n; } el.dispatchEvent(new MouseEvent('click', { bubbles: true })); };
  const dbl = (el) => el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  const type = (el, v) => { el = typeof el === 'string' ? $(el) : el; el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
  const key = (k, opts = {}) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...opts }));
  const txt = (s) => ($(s)?.textContent || '').replace(/\\s+/g, ' ').trim();
  const idle = () => waitFor(() => !$('#busy').classList.contains('on'), 'idle');
  const R = {};
  ${body}
  return R;
})()`;

function fixture() {
  const { origin, work, other } = H.withRemote();
  H.commit(work, 'linus', 'Add app skeleton', { 'src/app.js': 'console.log(1)\n' });
  H.sh(work, ['tag', 'v0.1.0']);
  H.sh(work, ['switch', '-q', '-c', 'feature/auth']);
  H.commit(work, 'grace', 'Implement login flow', { 'src/auth.js': 'login()\n' });
  H.commit(work, 'grace', 'Add logout', { 'src/auth.js': 'login()\nlogout()\n' });
  H.sh(work, ['switch', '-q', 'main']);
  H.commit(work, 'octo', 'Improve startup', { 'src/app.js': 'console.log(2)\n' });
  H.sh(work, ['merge', '-q', '--no-ff', 'feature/auth', '-m', "Merge branch 'feature/auth'"]);
  // collaborator branch on the remote
  H.sh(other, ['switch', '-q', '-c', 'feature/remote']);
  H.commit(other, 'ada', 'Remote feature', { 'r.txt': 'r\n' });
  H.sh(other, ['push', '-q', '-u', 'origin', 'feature/remote']);
  H.sh(work, ['fetch', '-q']);
  // a stash and a dirty tree (1 staged, 1 modified, 1 untracked)
  H.write(work, 'src/app.js', 'stashed\n');
  H.sh(work, ['stash', 'push', '-q', '-m', 'experiment with caching']);
  H.write(work, 'README.md', '# Demo\nmore\n');
  H.sh(work, ['add', 'README.md']);
  H.write(work, 'src/app.js', 'console.log(3)\n');
  H.write(work, 'src/new file.js', 'new\n');
  // the remote *looks* like GitHub (so PRs/accounts route to github.com) but git really talks to the local bare repo
  H.sh(work, ['remote', 'set-url', 'origin', 'https://github.com/acme/demo.git']);
  H.sh(work, ['config', `url.${origin}.insteadOf`, 'https://github.com/acme/demo.git']);
  // fake GitHub PR + two gh accounts
  H.resetGh();
  H.setGhAccounts([{ host: 'github.com', login: 'perso', token: 'tok-perso', active: true }, { host: 'github.com', login: 'work', token: 'tok-work', active: false }]);
  fs.writeFileSync(H.GH_JSON, JSON.stringify([{ number: 42, title: 'Add dark mode', author: { login: 'octocat' }, headRefName: 'feature/auth', baseRefName: 'main', isDraft: false, url: 'https://github.com/acme/demo/pull/42', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', reviewDecision: 'APPROVED', additions: 10, deletions: 2, changedFiles: 3, labels: [{ name: 'ui', color: 'a78bfa' }], body: 'Adds a dark mode.', state: 'OPEN' }]));
  return { origin, work, other };
}

test('e2e: full tour of the UI on a realistic repository', { timeout: 120_000 }, async () => {
  const { origin, work } = fixture();
  const ahead = Number(H.sh(work, ['rev-list', '--count', 'origin/main..main']).trim());
  const commitCount = Number(H.sh(work, ['rev-list', '--count', '--branches', '--remotes', '--tags', 'HEAD']).trim());

  const { result: R, consoleErrors, screenshot } = await launch(work, script(`
    await waitFor(() => $$('#rows .row').length, 'rows');
    await waitFor(() => $('#sideScroll .item[data-kind="pr"]'), 'PR list');
    // ---------- initial render
    R.repoName = txt('#repoName');
    R.branchLabel = txt('#repoBranch');
    R.rows = $$('#rows .row').length;
    R.nodes = $$('#nodes .node').length;
    R.firstRowIsWip = $('#rows .row').classList.contains('wip');
    R.wipCounts = txt('#rows .row.wip .wip-counts');
    R.paths = $$('#lanes path').length;
    R.refPills = $$('#rows .ref').map((e) => e.textContent.trim());
    R.headPill = txt('#rows .ref.head');
    R.mergeNodes = $$('#nodes .node.merge').length;
    R.aheadBadge = txt('#aheadBadge');
    R.sections = Object.fromEntries($$('.sec').map((s) => [s.dataset.sec, txt('.sec[data-sec="' + s.dataset.sec + '"] .count')]));
    R.authors = [...new Set($$('#rows .col-author .nm').map((e) => e.textContent))].sort();
    R.detailIsWip = txt('#detail .d-kicker').includes('Work in progress');

    // ---------- commit details + diff
    const row = $$('#rows .row').find((r) => r.textContent.includes('Implement login flow'));
    click(row);
    await waitFor(() => txt('#detail .d-title') === 'Implement login flow', 'commit detail');
    R.commitDetail = { title: txt('#detail .d-title'), author: txt('#detail .who b'), files: $$('#detail .file').length, selected: row.classList.contains('sel') };
    click('#detail .file');
    await waitFor(() => $('#diffBody .dl.add'), 'diff');
    R.diff = { open: !$('#diffView').hidden, path: txt('#diffPath'), added: $$('#diffBody .dl.add').length };
    key('Escape');
    R.diffClosedByEsc = $('#diffView').hidden;

    // parent pill navigates
    click('#detail [data-goto]');
    await waitFor(() => txt('#detail .d-title') === 'Add app skeleton', 'parent navigation');
    R.parentNav = true;

    // ---------- keyboard navigation
    const before = txt('#detail .d-title');
    key('ArrowUp');
    await waitFor(() => txt('#detail .d-title') && txt('#detail .d-title') !== before, 'arrow nav');
    R.arrowNav = txt('#detail .d-title');

    // ---------- search
    type('#search', 'grace');
    R.search = { hits: $$('#rows .row.hit').length, dimmed: $$('#rows .row.dim').length };
    type('#search', '');
    R.searchCleared = $$('#rows .row.dim').length;

    // ---------- sidebar: branch click jumps to commit, filter, collapse
    click($('#sideScroll .item[data-kind="remote"][data-name="origin/feature/remote"]'));
    await waitFor(() => txt('#detail .d-title') === 'Remote feature', 'remote branch selects commit');
    R.remoteBranchJump = true;
    type('#sideFilter', 'auth');
    R.filteredLocal = $$('#sideScroll .item[data-kind="local"]').map((e) => e.dataset.name);
    type('#sideFilter', '');

    // ---------- pull request
    click($('#sideScroll .item[data-kind="pr"]'));
    await waitFor(() => txt('#detail .d-kicker').includes('#42'), 'PR detail');
    R.pr = { kicker: txt('#detail .d-kicker'), title: txt('#detail .d-title'), labels: txt('#detail .labels'), stats: txt('#detail .stat-grid') };

    // ---------- stash detail from sidebar
    click($('#sideScroll .item[data-kind="stash"]'));
    await waitFor(() => txt('#detail .d-kicker').includes('Stash'), 'stash detail');
    R.stashDetail = { kicker: txt('#detail .d-kicker'), files: $$('#detail .file').map((f) => f.dataset.path) };

    // ---------- WIP: stage one file via its + button, then commit
    click('#rows .row.wip');
    await waitFor(() => $('#cSummary'), 'composer');
    R.wipBefore = { unstaged: $$('#detail .file[data-mode="unstaged"]').map((f) => f.dataset.path), staged: $$('#detail .file[data-mode="staged"]').map((f) => f.dataset.path) };
    R.commitDisabledEmpty = $('#cGo').disabled;
    const appFile = $('#detail .file[data-mode="unstaged"][data-path="src/app.js"]');
    click(appFile.querySelector('[data-op="stage"]'));
    await waitFor(() => $('#detail .file[data-mode="staged"][data-path="src/app.js"]'), 'stage via +');
    // unstaged diff of the untracked file
    click($('#detail .file[data-mode="unstaged"][data-path="src/new file.js"]'));
    await waitFor(() => $('#diffBody .dl.add'), 'untracked diff');
    R.untrackedDiff = txt('#diffBody .dl.add .c');
    click('#diffClose');
    type('#cSummary', 'Ship it from the UI');
    type('#cBody', 'Body written in the composer');
    R.commitBtn = txt('#cGoTxt');
    R.wipRowShowsDraft = txt('#rows .row.wip .col-msg').includes('Ship it from the UI');
    click('#cGo');
    await waitFor(() => $$('#rows .row .col-msg').some((m) => m.textContent === 'Ship it from the UI'), 'new commit in graph');
    await idle();
    R.afterCommitWip = $('#rows .row.wip') ? txt('#rows .row.wip .wip-counts') : null;

    // ---------- new branch via toolbar + modal
    click('.toolbar [data-act="branch"]');
    await waitFor(() => !$('#modalWrap').hidden, 'branch modal');
    type($('#modal input[name="name"]'), 'feature/from-ui');
    $('#modal form').requestSubmit();
    await waitFor(() => txt('#repoBranch').includes('feature/from-ui'), 'switched to new branch');
    await idle();
    R.newBranchInSidebar = !!$('#sideScroll .item.current[data-name="feature/from-ui"]');

    // ---------- stash via toolbar (leftover untracked file) then pop
    const stashesBefore = Number(txt('.sec[data-sec="stashes"] .count'));
    click('.toolbar [data-act="stash"]');
    await waitFor(() => !$('#modalWrap').hidden, 'stash modal');
    type($('#modal input[name="message"]'), 'ui stash');
    $('#modal form').requestSubmit();
    await waitFor(() => Number(txt('.sec[data-sec="stashes"] .count')) === stashesBefore + 1, 'stash count +1');
    await idle();
    R.wipGoneAfterStash = !$('#rows .row.wip');
    click('.toolbar [data-act="pop"]');
    await waitFor(() => Number(txt('.sec[data-sec="stashes"] .count')) === stashesBefore, 'stash popped');
    await waitFor(() => $('#rows .row.wip'), 'wip back after pop');
    await idle();

    // ---------- modal cancel with Escape does nothing
    click('.toolbar [data-act="branch"]');
    await waitFor(() => !$('#modalWrap').hidden, 'modal');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    R.modalEscClosed = $('#modalWrap').hidden;

    // ---------- push new branch (no upstream yet), fetch
    click('.toolbar [data-act="push"]');
    await waitFor(() => $('#hud').classList.contains('ok') && $('#hudTitle').textContent.startsWith('Published'), 'push HUD', 15000);
    R.pushHud = $('#hudTitle').textContent;
    await idle();
    click('.toolbar [data-act="fetch"]');
    await waitFor(() => $('#hud').classList.contains('ok') && $('#hudTitle').textContent.startsWith('Fetched'), 'fetch HUD', 15000);
    R.fetchHud = $('#hudTitle').textContent;
    await idle();
    R.errorToasts = $$('.toast.err').map((t) => t.textContent);

    // ---------- double-click a branch in the sidebar checks it out
    dbl($('#sideScroll .item[data-kind="local"][data-name="main"]'));
    await waitFor(() => txt('#repoBranch').includes('main'), 'checkout main', 10000);
    await idle();
    R.finalBranch = txt('#repoBranch');
    R.wipPanelBranch = txt('#detail .d-kicker .pill');
    R.detailKicker = txt('#detail .d-kicker') + ' | sel=' + JSON.stringify(S.sel) + ' | files=' + S.status.files.length;
    R.finalErrorToasts = $$('.toast.err').map((t) => t.textContent);
  `));

  assert.deepEqual(consoleErrors, [], 'no renderer console errors');
  assert.ok(fs.statSync(screenshot).size > 50_000, 'screenshot captured');

  // initial render
  assert.equal(R.repoName, path.basename(work));
  assert.equal(R.branchLabel, 'main');
  assert.equal(R.rows, commitCount + 1, 'one row per commit + WIP');
  assert.equal(R.nodes, R.rows);
  assert.equal(R.firstRowIsWip, true);
  assert.match(R.wipCounts, /1.*2/, '1 staged, 2 unstaged');
  assert.ok(R.paths >= commitCount, 'graph edges drawn');
  for (const label of ['main', 'feature/auth', 'origin/feature/remote', 'v0.1.0']) assert.ok(R.refPills.some((p) => p.includes(label)), `pill ${label}`);
  assert.match(R.headPill, /main/);
  assert.equal(R.mergeNodes, 1);
  assert.equal(R.aheadBadge, String(ahead), 'ahead badge matches git');
  assert.deepEqual(R.sections, { local: '2', remote: '2', prs: '1', issues: '0', stashes: '1', tags: '1', worktrees: '0' });
  assert.deepEqual(R.authors, ['Ada Lovelace', 'Grace Hopper', 'Linus Torvalds', 'Octo Cat', 'Test Runner']);
  assert.equal(R.detailIsWip, true, 'dirty repo opens on WIP');

  // details / diff / navigation
  assert.deepEqual(R.commitDetail, { title: 'Implement login flow', author: 'Grace Hopper', files: 1, selected: true });
  assert.deepEqual(R.diff, { open: true, path: 'src/auth.js', added: 1 });
  assert.equal(R.diffClosedByEsc, true);
  assert.equal(R.parentNav, true);
  assert.ok(R.arrowNav);
  assert.equal(R.search.hits, 2, 'login + logout are by Grace');
  assert.ok(R.search.dimmed > 0);
  assert.equal(R.searchCleared, 0);
  assert.equal(R.remoteBranchJump, true);
  assert.deepEqual(R.filteredLocal, ['feature/auth']);

  // PR + stash
  assert.match(R.pr.kicker, /#42.*Open.*Approved/);
  assert.equal(R.pr.title, 'Add dark mode');
  assert.match(R.pr.labels, /ui/);
  assert.match(R.pr.stats, /\+10.*−2.*3/);
  assert.match(R.stashDetail.kicker, /stash@\{0\}/);
  assert.deepEqual(R.stashDetail.files, ['src/app.js']);

  // WIP + commit
  assert.deepEqual(R.wipBefore, { unstaged: ['src/app.js', 'src/new file.js'], staged: ['README.md'] });
  assert.equal(R.commitDisabledEmpty, true, 'commit disabled without a message');
  assert.equal(R.untrackedDiff, 'new');
  assert.equal(R.commitBtn, 'Commit 2 files');
  assert.equal(R.wipRowShowsDraft, true);
  assert.match(R.afterCommitWip, /1/, 'untracked file still pending');

  // branch / stash / modal / push / fetch / checkout
  assert.equal(R.newBranchInSidebar, true);
  assert.equal(R.wipGoneAfterStash, true);
  assert.equal(R.modalEscClosed, true);
  assert.deepEqual(R.errorToasts, []);
  assert.equal(R.pushHud, 'Published feature/from-ui to origin');
  assert.match(R.fetchHud, /^Fetched — /);
  assert.equal(R.finalBranch, 'main');
  assert.equal(R.wipPanelBranch, 'main', `WIP panel header follows the current branch — ${R.detailKicker}`);
  assert.deepEqual(R.finalErrorToasts, []);

  // ---------- verify the real git state
  const log = H.sh(work, ['log', 'feature/from-ui', '-1', '--format=%B']).trim();
  assert.equal(log, 'Ship it from the UI\n\nBody written in the composer');
  const committed = H.sh(work, ['show', '--name-only', '--format=', 'feature/from-ui']).trim().split('\n').sort();
  assert.deepEqual(committed, ['README.md', 'src/app.js'], 'only staged files were committed');
  assert.equal(H.sh(work, ['branch', '--show-current']).trim(), 'main');
  assert.equal(H.sh(origin, ['rev-parse', 'feature/from-ui']).trim(), H.sh(work, ['rev-parse', 'feature/from-ui']).trim(), 'branch pushed to origin');
  assert.equal(H.sh(work, ['rev-parse', '--abbrev-ref', 'feature/from-ui@{u}']).trim(), 'origin/feature/from-ui', 'upstream set');
  assert.equal(H.sh(work, ['stash', 'list']).trim().split('\n').length, 1, 'ui stash was popped, original stash kept');
  assert.equal(H.read(work, 'src/new file.js'), 'new\n', 'popped untracked file restored');
  assert.ok(H.ghCalls().some((c) => c[0] === 'pr' && c[1] === 'list'), 'PRs fetched through gh');
});

test('e2e: empty repository and non-repository folders', { timeout: 120_000 }, async () => {
  // brand-new repo with one untracked file: commit the very first commit from the UI
  const d = H.initRepo('e2e-empty');
  H.write(d, 'hello.txt', 'hi\n');
  const { result: R, consoleErrors } = await launch(d, script(`
    await waitFor(() => $('#rows .row.wip'), 'wip row');
    R.rows = $$('#rows .row').length;
    R.branch = txt('#repoBranch');
    click('[data-act="stageAll"]');
    await waitFor(() => $('#detail .file[data-mode="staged"]'), 'staged');
    type('#cSummary', 'Initial commit');
    click('#cGo');
    await waitFor(() => $$('#rows .row').length === 1 && !$('#rows .row.wip'), 'first commit');
    await idle();
    R.after = txt('#rows .row .col-msg');
    R.errors = $$('.toast.err').map((t) => t.textContent);
  `));
  assert.deepEqual(consoleErrors, []);
  assert.equal(R.rows, 1);
  assert.equal(R.branch, 'main');
  assert.equal(R.after, 'Initial commit');
  assert.deepEqual(R.errors, []);
  assert.equal(H.sh(d, ['log', '--format=%s']).trim(), 'Initial commit');

  // a folder that is not a repo → welcome screen, no crash
  const { result: W, consoleErrors: e2 } = await launch(H.tmpDir('plain-folder'), script(`
    await sleep(300);
    R.welcome = $('#empty').classList.contains('on');
    R.title = txt('#empty h1');
  `));
  assert.deepEqual(e2, []);
  assert.equal(W.welcome, true);
  assert.equal(W.title, 'Welcome to Nebula');
});

test('e2e: large history renders quickly', { timeout: 120_000 }, async () => {
  const d = H.initRepo('e2e-big');
  // 2000 commits with branches, created fast via fast-import
  let stream = '';
  let mark = 0;
  const ts = 1767261600;
  const lines = [];
  const commitAt = (ref, parent, msg, i, merge) => {
    mark++;
    lines.push(`commit ${ref}`, `mark :${mark}`, `author Dev ${i % 7} <dev${i % 7}@example.com> ${ts + mark * 60} +0000`, `committer Dev ${i % 7} <dev${i % 7}@example.com> ${ts + mark * 60} +0000`, `data ${Buffer.byteLength(msg)}`, msg);
    if (parent) lines.push(`from :${parent}`);
    if (merge) lines.push(`merge :${merge}`);
    lines.push(`M 644 inline f${i % 50}.txt`, `data ${String(i).length}`, String(i), '');
    return mark;
  };
  let main = commitAt('refs/heads/main', null, 'root', 0);
  for (let i = 1; i < 2000; i++) {
    if (i % 25 === 0) {
      let b = main;
      for (let k = 0; k < 3; k++) b = commitAt(`refs/heads/topic${i}`, b, `topic ${i}.${k}`, i * 10 + k);
      main = commitAt('refs/heads/main', main, `Merge topic${i}`, i, b);
    } else main = commitAt('refs/heads/main', main, `commit ${i}`, i);
  }
  stream = lines.join('\n') + '\n';
  require('node:child_process').execFileSync('git', ['fast-import', '--quiet'], { cwd: d, input: stream });
  H.sh(d, ['reset', '-q', '--hard', 'main']);

  const { result: R, consoleErrors } = await launch(d, script(`
    await waitFor(() => $$('#rows .row').length, 'rows');
    R.rows = $$('#rows .row').length;
    R.loadMoreVisible = $('#loadMore').classList.contains('on');
    let t = performance.now();
    click('#loadMore button');
    await waitFor(() => $$('#rows .row').length > 600, 'more rows', 20000);
    R.loadMoreMs = performance.now() - t;
    R.rowsAfter = $$('#rows .row').length;
    t = performance.now();
    for (let i = 0; i < 20; i++) key('ArrowDown');
    R.arrow20Ms = performance.now() - t;
  `));
  assert.deepEqual(consoleErrors, []);
  assert.equal(R.rows, 600, 'first page is 600 commits');
  assert.equal(R.loadMoreVisible, true);
  assert.equal(R.rowsAfter, 1600);
  assert.ok(R.loadMoreMs < 5000, `load more took ${R.loadMoreMs}ms`);
  assert.ok(R.arrow20Ms < 2000, `20 arrow presses took ${R.arrow20Ms}ms`);
});

test('e2e: identities & accounts — wrong-identity guard, one-click fix, per-repo account, add account', { timeout: 120_000 }, async () => {
  // The user's real situation: a "Work" folder whose repos must use the company email via includeIf…
  const workDir = fs.realpathSync(H.tmpDir('Work'));
  const inc = path.join(path.dirname(process.env.GIT_CONFIG_GLOBAL), '.gitconfig-e2e-work');
  fs.writeFileSync(inc, '[user]\n\temail = me@company.com\n');
  H.sh(H.ROOT, ['config', '--global', `includeIf.gitdir/i:${workDir}/.path`, inc]);
  const { origin } = H.withRemote();
  const repo = path.join(workDir, 'api');
  H.sh(workDir, ['clone', '-q', origin, 'api']);
  H.sh(repo, ['remote', 'set-url', 'origin', 'https://github.com/company/api.git']);
  H.sh(repo, ['config', `url.${origin}.insteadOf`, 'https://github.com/company/api.git']);
  // …but this repo was configured locally with the personal address (the mistake we want to catch)
  H.sh(repo, ['config', 'user.email', 'runner@example.com']);
  H.write(repo, 'feature.txt', 'work\n');
  H.resetGh();
  H.setGhAccounts([{ host: 'github.com', login: 'perso', token: 'tok-perso', active: true }, { host: 'github.com', login: 'work', token: 'tok-work', active: false }]);

  // approve the device login as soon as the app starts it (simulates the user in the browser)
  const approve = setInterval(() => {
    if (H.ghLog().some((l) => l.argv[0] === 'auth' && l.argv[1] === 'login') && !fs.existsSync(H.GH_APPROVE)) { fs.writeFileSync(H.GH_APPROVE, 'newbie'); clearInterval(approve); }
  }, 100);

  let result;
  try {
    result = await launch(repo, script(`
      await waitFor(() => $('#idChip:not([hidden])') && $('#idBanner .id-banner'), 'identity chip + banner');
      R.chip = { warn: $('#idChip').classList.contains('warn'), text: txt('#idChip') };
      R.banner = txt('#idBanner');
      R.asBar = txt('#asBtn');
      type('#cSummary', 'Work feature');
      R.commitBtnMismatch = txt('#cGoTxt');
      R.commitBtnWarn = $('#cGo').classList.contains('warn');

      // one-click fix from the banner
      click('#idBanner [data-use-profile]');
      await waitFor(() => !$('#idBanner .id-banner'), 'banner gone');
      R.chipAfter = { warn: $('#idChip').classList.contains('warn'), text: txt('#idChip') };
      R.asBarAfter = txt('#asBtn');
      click('[data-act="stageAll"]');
      await waitFor(() => $('#detail .file[data-mode="staged"]'), 'staged');
      R.commitBtnOk = txt('#cGoTxt');
      click('#cGo');
      await waitFor(() => $$('#rows .row .col-msg').some((m) => m.textContent === 'Work feature'), 'committed');
      await idle();

      // sheet: repo tab → pin the "work" GitHub account for this repo
      click('#idChip');
      await waitFor(() => $('#sheet [data-repo-account="github:github.com/work"]'), 'repo tab accounts');
      R.tabs = $$('#sheet .seg button').map((b) => b.textContent.trim());
      R.repoTab = txt('#sheet .sheet-b');
      click('#sheet [data-repo-account="github:github.com/work"]');
      await waitFor(() => $('#sheet [data-repo-account="github:github.com/work"].on'), 'work pinned');
      await sleep(400);

      // accounts tab → add a GitHub account through the device flow
      click('#sheet [data-tab="accounts"]');
      await waitFor(() => $('#sheet [data-gh-login]'), 'accounts tab');
      R.accountsBefore = $$('#sheet .acc .meta b').map((b) => b.textContent);
      click('#sheet [data-gh-login]');
      await waitFor(() => $('#sheet .device .code'), 'device code', 10000);
      R.deviceCode = txt('#sheet .device .code');
      await waitFor(() => !$('#sheet .device') && $$('#sheet .acc .meta b').some((b) => b.textContent === 'newbie'), 'new account listed', 20000);
      R.accountsAfter = $$('#sheet .acc .meta b').map((b) => b.textContent);
      R.activeBadge = $$('#sheet .acc').filter((a) => a.querySelector('.pill.green')).map((a) => a.querySelector('.meta b').textContent);

      // identities tab → create a new identity with a remote rule
      click('#sheet [data-tab="identities"]');
      await waitFor(() => $('#sheet .id-card'), 'identities tab');
      R.importedIdentities = $$('#sheet .id-card:not(.add) .id-card-h b').map((b) => b.textContent);
      click('#sheet .id-card.add');
      await waitFor(() => $('#idForm'), 'form');
      const f = $('#idForm');
      const el = f.elements; el.label.value = 'Open source'; el.name.value = 'Ada OSS'; el.email.value = 'ada@oss.dev'; el.remotes.value = 'github.com/oss-org/*';
      f.requestSubmit();
      await waitFor(() => $$('#sheet .id-card-h b').some((b) => b.textContent === 'Open source'), 'new identity card');
      R.newCardChips = [...$$('#sheet .id-card')].find((c) => c.textContent.includes('Open source')).querySelector('.chips').textContent;
      key('Escape');
      await sleep(100);
      R.sheetClosed = $('#sheetWrap').hidden;
      R.errors = $$('.toast.err').map((t) => t.textContent);
    `));
  } finally { clearInterval(approve); }
  const { result: R, consoleErrors } = result;

  assert.deepEqual(consoleErrors, []);
  // the guard
  assert.equal(R.chip.warn, true);
  assert.match(R.chip.text, /runner@example\.com/);
  assert.match(R.banner, /Wrong identity for this repo\?.*This repo is inside .*Work.*Company.*me@company\.com.*runner@example\.com.*Use Company/);
  assert.match(R.asBar, /Committing as.*runner@example\.com.*this repo/);
  assert.equal(R.commitBtnMismatch, 'Stage files to commit');
  assert.equal(R.commitBtnWarn, true);
  // the fix
  assert.equal(R.chipAfter.warn, false);
  assert.match(R.chipAfter.text, /Company.*me@company\.com/);
  assert.match(R.asBarAfter, /me@company\.com/);
  assert.equal(R.commitBtnOk, 'Commit 1 file');
  assert.equal(H.sh(repo, ['log', '-1', '--format=%ae']).trim(), 'me@company.com', 'commit authored with the right identity');
  // per-repo account
  assert.deepEqual(R.tabs, ['This repository', 'Identities', 'Accounts']);
  assert.match(R.repoTab, /github\.com\/company\/api/);
  assert.equal(H.sh(repo, ['config', '--local', 'nebula.account']).trim(), 'github:github.com/work');
  const prCalls = H.ghLog().filter((l) => l.argv[0] === 'pr' && l.argv[1] === 'list');
  assert.equal(prCalls[0].token, 'tok-perso', 'before pinning: active gh account');
  assert.equal(prCalls.at(-1).token, 'tok-work', 'after pinning: the work account, for this repo only');
  // add account
  assert.deepEqual(R.accountsBefore, ['perso', 'work']);
  assert.equal(R.deviceCode, 'ABCD-1234');
  assert.deepEqual(R.accountsAfter, ['perso', 'work', 'newbie']);
  assert.deepEqual(R.activeBadge, ['perso'], 'adding an account does not change the active gh account');
  assert.deepEqual(H.ghAccounts().filter((a) => a.active).map((a) => a.login), ['perso']);
  // identities
  assert.deepEqual(R.importedIdentities, ['Example', 'Company']);
  assert.match(R.newCardChips, /github\.com\/oss-org\/\*/);
  assert.equal(R.sheetClosed, true);
  assert.deepEqual(R.errors, []);
});

test('e2e: one-click SSH for a second GitHub account, then switch the repo to it', { timeout: 120_000 }, async () => {
  fs.rmSync(H.SSH_DIR, { recursive: true, force: true });
  const { origin, work } = H.withRemote();
  H.sh(work, ['remote', 'set-url', 'origin', 'https://github.com/company/api.git']);
  H.sh(work, ['config', `url.${origin}.insteadOf`, 'https://github.com/company/api.git']);
  H.sh(work, ['config', 'nebula.account', 'github:github.com/work']);
  H.resetGh();
  H.setGhAccounts([{ host: 'github.com', login: 'perso', token: 'tok-perso', active: true }, { host: 'github.com', login: 'work', token: 'tok-work', active: false }]);
  H.setSshUsers({ 'github.com-work': 'work' });
  const approve = setInterval(() => {
    if (H.ghLog().some((l) => l.argv[0] === 'auth' && l.argv[1] === 'refresh') && !fs.existsSync(H.GH_APPROVE)) { fs.writeFileSync(H.GH_APPROVE, 'ok'); clearInterval(approve); }
  }, 100);
  let res;
  try {
    res = await launch(work, script(`
      await waitFor(() => !$('#idChip').hidden, 'chip');
      click('#idChip');
      await waitFor(() => $('#sheet [data-ssh-setup-repo]'), 'Set up SSH button on repo tab');
      R.repoLineBefore = txt('#sheet .remote-line');
      click('#sheet [data-ssh-setup-repo]');
      await waitFor(() => $('#sheet .ssh-run'), 'progress');
      await waitFor(() => $('#sheet .ssh-run .device .code'), 'permission code', 10000);
      R.code = txt('#sheet .ssh-run .device .code');
      R.stepsDuringCode = $$('#sheet .ssh-run li').map((l) => l.className);
      await waitFor(() => !$('#sheet .ssh-run') && $('#sheet .acc .pill.green'), 'ssh ready', 20000);
      const row = (who) => $$('#sheet .acc').find((a) => a.querySelector('.meta b').textContent === who).textContent.split(String.fromCharCode(10)).map((x) => x.trim()).filter(Boolean).join(' ');
      R.workRow = row('work');
      R.persoRow = row('perso');
      click('#sheet [data-tab="repo"]');
      await waitFor(() => $('#sheet [data-ssh-remote]'), 'Use SSH button');
      click('#sheet [data-ssh-remote]');
      await waitFor(() => /SSH · github\\.com-work/.test(txt('#sheet .remote-line')), 'remote switched');
      R.repoLineAfter = txt('#sheet .remote-line');
      R.errors = $$('.toast.err').map((t) => t.textContent);
    `), { confirm: 'yes' });
  } finally { clearInterval(approve); }
  const { result: R, consoleErrors, confirms } = res;
  assert.deepEqual(consoleErrors, []);
  assert.deepEqual(R.errors, []);
  assert.match(R.repoLineBefore, /github\.com\/company\/api.*HTTPS.*Set up SSH/);
  assert.deepEqual(confirms, ['Set up SSH for work on github.com?'], 'the plan was confirmed before touching anything');
  assert.equal(R.code, 'WXYZ-9876');
  assert.deepEqual(R.stepsDuringCode, ['done', 'done', 'code', 'todo']);
  assert.match(R.workRow, /work.*ssh github\.com-work.*SSH/);
  assert.match(R.persoRow, /Set up SSH/, 'other account untouched');
  assert.match(R.repoLineAfter, /SSH · github\.com-work/);
  assert.equal(H.sh(work, ['config', '--get', 'remote.origin.url']).trim(), 'git@github.com-work:company/api.git');
  assert.match(fs.readFileSync(path.join(H.SSH_DIR, 'config'), 'utf8'), /Host github\.com-work\n {2}HostName github\.com/);
  assert.equal(H.ghAccounts().find((a) => a.login === 'work').keys.length, 1);
  assert.deepEqual(H.ghAccounts().filter((a) => a.active).map((a) => a.login), ['perso']);
  const lastPr = H.ghLog().filter((l) => l.argv[0] === 'pr').at(-1);
  assert.deepEqual([lastPr.token, ...lastPr.argv.slice(-2)], ['tok-work', '--repo', 'github.com/company/api']);
});

test('e2e: tabs + new-tab launchpad — recent, clone from URL, init, ⌘1, close', { timeout: 120_000 }, async () => {
  H.resetGh();
  const { origin, work } = H.withRemote();
  H.commit(work, 'ada', 'Feature A', { 'a.txt': 'a' });
  H.sh(work, ['push', '-q']);
  const parent = H.tmpDir('clones');
  const userData = H.tmpDir('userdata');
  // seed "recent" with a repo, a deleted folder and a non-repo folder
  const gone = H.tmpDir('gone-repo');
  fs.rmdirSync(gone);
  fs.writeFileSync(path.join(userData, 'state.json'), JSON.stringify({ recent: [work, gone] }));
  const { result: R, consoleErrors } = await launch(null, script(`
    await waitFor(() => S.tab?.kind === 'new' && $('#lpRecent'), 'launchpad on start (no tabs)');
    await waitFor(() => $$('#lpRecent .lp-repo').length === 2, 'recent list');
    R.recent = $$('#lpRecent .lp-repo').map((r) => r.querySelector('b').textContent + (r.classList.contains('gone') ? ':gone' : ''));
    R.topbar = txt('#repoName') + ' / ' + txt('#repoBranch');
    // filter + Enter opens the first match, turning the New Tab into the repo tab
    type('#lpSearch', '${path.basename(work)}');
    $('#lpSearch').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await waitFor(() => S.tab?.info?.path && $$('#rows .row').length, 'opened from recent');
    R.afterOpen = $$('.tab .tab-name').map((t) => t.textContent);
    // + → launchpad again → clone from URL
    click('#tabNew');
    await waitFor(() => S.tab?.kind === 'new', 'new tab');
    LP.cloneParent = ${JSON.stringify(parent)};
    click('[data-lp="clone"]');
    type('#lpUrl', ${JSON.stringify(origin)});
    R.autoName = $('#lpName').value;
    type('#lpName', 'my-clone');
    click('#lpClone');
    await waitFor(() => S.tab?.info?.name === 'my-clone' && $$('#rows .row').length, 'cloned tab', 30000);
    R.cloneHud = $$('.hud').length && $('#hudTitle').textContent;
    R.clonedCommits = S.commits.map((c) => c.subject);
    // + → init
    click('#tabNew');
    await waitFor(() => S.tab?.kind === 'new', 'new tab 2');
    click('[data-lp="init"]');
    type('#lpInitName', 'fresh');
    click('#lpInit');
    await waitFor(() => S.tab?.info?.name === 'fresh' && S.commits?.length === 1, 'init tab', 15000);
    R.tabsBefore = $$('.tab .tab-name').map((t) => t.textContent);
    // ⌘1 switches to the first tab; ⌘W-equivalent closes the active one
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '1', metaKey: true, bubbles: true }));
    await waitFor(() => S.tab === S.tabs[0] && $$('#rows .row').length, 'cmd+1');
    R.cmd1 = txt('.tab.active .tab-name');
    await closeTab(S.tab);
    await waitFor(() => !S.tabs.some((t) => t.info?.name === R.cmd1), 'closed');
    R.tabsAfterClose = $$('.tab .tab-name').map((t) => t.textContent);
    while (S.tabs.some((t) => t.kind !== 'new')) await closeTab(S.tabs.find((t) => t.kind !== 'new'));
    await waitFor(() => S.tab?.kind === 'new', 'last close shows launchpad');
    R.lastClose = $$('.tab .tab-name').map((t) => t.textContent);
    R.errors = $$('.toast.err').map((t) => t.textContent);
  `), { userData });
  assert.deepEqual(consoleErrors, []);
  assert.deepEqual(R.recent, [path.basename(work), `${path.basename(gone)}:gone`]);
  assert.equal(R.topbar, 'New tab / Open a repository');
  assert.deepEqual(R.afterOpen, [path.basename(work)], 'the New Tab was replaced in place');
  assert.equal(R.autoName, path.basename(origin).replace(/\.git$/, ''), 'folder name derived from the URL');
  assert.deepEqual(R.clonedCommits, ['Feature A', 'Initial commit']);
  assert.equal(H.sh(path.join(parent, 'my-clone'), ['log', '-1', '--format=%s']).trim(), 'Feature A');
  assert.deepEqual(R.tabsBefore, [path.basename(work), 'my-clone', 'fresh']);
  assert.equal(R.cmd1, path.basename(work));
  assert.deepEqual(R.tabsAfterClose, ['my-clone', 'fresh']);
  assert.deepEqual(R.lastClose, ['New Tab']);
  assert.deepEqual(R.errors, []);
  assert.ok(fs.existsSync(path.join(parent, 'fresh', 'README.md')));
  const st = JSON.parse(fs.readFileSync(path.join(userData, 'state.json'), 'utf8'));
  assert.deepEqual(st.tabs, [], 'tabs persisted (New Tab is not saved)');
});

test('e2e: conflicts → resolve with keys/whole-file → continue merge → undo/redo', { timeout: 150_000 }, async () => {
  const d = H.initRepo('power');
  H.commit(d, 'ada', 'Initial', { 'config.js': 'port = 3000\ntheme = "light"\n', 'README.md': 'v1\n' });
  H.sh(d, ['switch', '-q', '-c', 'feature']);
  H.commit(d, 'linus', 'Dark mode', { 'config.js': 'port = 8080\ntheme = "dark"\n', 'README.md': 'v2 dark\n' });
  H.sh(d, ['switch', '-q', 'main']);
  H.commit(d, 'grace', 'Solarized', { 'config.js': 'port = 4000\ntheme = "solarized"\n', 'README.md': 'v1.1\n' });
  const beforeMerge = H.sh(d, ['rev-parse', 'HEAD']).trim();
  try { H.sh(d, ['merge', 'feature']); } catch { /* conflicts expected */ }

  const { result: R, consoleErrors } = await launch(d, script(`
    const hudOk = (re) => waitFor(() => $('#hud').classList.contains('ok') && re.test($('#hudTitle').textContent), 'hud ' + re, 15000);
    await waitFor(() => $('#detail .op-card'), 'conflict center');
    R.center = txt('#detail .op-card');
    R.wipRow = txt('#rows .row.wip .col-msg');
    R.goDisabled = $('#opGo').disabled;
    R.conflictFiles = $$('#detail [data-resolve]').map((f) => f.dataset.resolve).sort();
    click('[data-resolve="config.js"]');
    await waitFor(() => $('.rz-block'), 'resolver');
    R.legend = txt('.rz-legend');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true })); // 2 = theirs
    await waitFor(() => $('.rz-block.done'), 'block picked');
    R.resolvedText = txt('.rz-result');
    click('[data-save-resolution]');
    await waitFor(() => $('#diffPath').textContent === 'README.md' && $('.rz-block'), 'auto-advance to the next conflicted file');
    click('[data-whole="ours"]');
    await waitFor(() => $('#diffView').hidden && $('#opGo') && !$('#opGo').disabled, 'all resolved');
    R.centerDone = txt('#detail .op-card');
    type('#opMsg', 'Merge feature — kept dark config');
    click('#opGo');
    await hudOk(/^Merged feature into main$/);
    await idle();
    R.afterMergeState = S.status.state;
    R.undoTitle = $('#tbUndo').title;
    click('#tbUndo');
    await hudOk(/^Undid merge of feature$/);
    await idle();
    R.afterUndoHead = S.status.oid;
    R.redoTitle = $('#tbRedo').title;
    click('#tbRedo');
    await hudOk(/^Redid merge of feature$/);
    await idle();
    R.afterRedoSubject = S.commits[0].subject;
    R.errors = $$('.toast.err').map((t) => t.textContent);
  `), { confirm: 'yes' });
  assert.deepEqual(consoleErrors, []);
  assert.match(R.center, /Merging feature into main.*0 of 2 conflicted files resolved/);
  assert.equal(R.wipRow, 'Merging · 2 conflicts', 'warning is an icon, not an emoji');
  assert.equal(R.goDisabled, true);
  assert.deepEqual(R.conflictFiles, ['README.md', 'config.js']);
  assert.match(R.legend, /Mine · main.*Theirs · feature/);
  assert.match(R.resolvedText, /port = 8080.*theme = "dark"/);
  assert.match(R.centerDone, /All conflicts resolved/);
  assert.equal(R.afterMergeState, null);
  assert.equal(R.undoTitle, 'Undo merge of feature (⌘Z)');
  assert.equal(R.afterUndoHead, beforeMerge, 'undo resets to before the merge');
  assert.equal(R.redoTitle, 'Redo merge of feature (⇧⌘Z)');
  assert.equal(R.afterRedoSubject, 'Merge feature — kept dark config');
  assert.equal(H.read(d, 'config.js'), 'port = 8080\ntheme = "dark"\n');
  assert.equal(H.read(d, 'README.md'), 'v1.1\n');
  assert.deepEqual(R.errors, []);
});

test('e2e: hunk & line staging, commit undo/redo, ⌘-click compare, history, blame', { timeout: 150_000 }, async () => {
  const d = H.initRepo('partial');
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  H.commit(d, 'ada', 'Initial', { 'long.txt': `${lines.join('\n')}\n`, 'config.js': 'port = 3000\n' });
  H.commit(d, 'grace', 'Port 4000', { 'config.js': 'port = 4000\n' });
  H.commit(d, 'linus', 'Port 8080', { 'config.js': 'port = 8080\n' });
  lines[1] = 'CHANGED 2'; lines[26] = 'CHANGED 27'; lines[27] = 'EXTRA 28';
  H.write(d, 'long.txt', `${lines.join('\n')}\n`);
  const { result: R, consoleErrors } = await launch(d, script(`
    const hudOk = (re) => waitFor(() => $('#hud').classList.contains('ok') && re.test($('#hudTitle').textContent), 'hud ' + re, 15000);
    const stagedHas = async (re) => re.test(await G('diff', { path: 'long.txt', mode: 'staged' }));
    await waitFor(() => S.status && $$('#rows .row').length, 'loaded');
    await openDiff({ path: 'long.txt', mode: 'unstaged', st: 'M' });
    await waitFor(() => $$('.hunk').length === 2, 'two hunks');
    click($$('[data-hunk="stage"]')[0]);
    await waitFor(() => S.status.files[0]?.x === 'M' && S.status.files[0]?.y === 'M', 'hunk staged');
    R.staged1 = await G('diff', { path: 'long.txt', mode: 'staged' });
    await waitFor(() => $$('.hunk').length === 1, 'diff refreshed');
    click($$('.dl.add.sel-able').find((l) => l.textContent.includes('CHANGED 27')));
    R.lineBar = txt('#lineBar');
    click('[data-lines="stage"]');
    for (let i = 0; i < 60 && !(await stagedHas(/CHANGED 27/)); i++) await sleep(100);
    R.staged2 = await G('diff', { path: 'long.txt', mode: 'staged' });
    R.unstaged2 = await G('diff', { path: 'long.txt', mode: 'unstaged' });
    closeDiff();
    S.draft.summary = 'Edit long.txt';
    await doCommit();
    await idle();
    R.commitUndoTitle = $('#tbUndo').title;
    click('#tbUndo');
    await hudOk(/^Undid commit “Edit long.txt”$/);
    await idle();
    R.afterUndo = { head: S.commits[0].subject, files: S.status.files.map((f) => f.x + f.y) };
    click('#tbRedo');
    await hudOk(/^Redid commit “Edit long.txt”$/);
    await idle();
    R.afterRedo = S.commits[0].subject;
    const rowOf = (s) => $$('#rows .row').find((r) => r.querySelector('.col-msg')?.textContent === s);
    click(rowOf('Port 4000'));
    rowOf('Port 8080').dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }));
    await waitFor(() => $('#detail [data-multi="compare"]'), 'multi panel');
    R.multi = txt('#detail .d-kicker');
    click('#detail [data-multi="compare"]');
    for (let i = 0; i < 40 && !$('#detail [data-cmp-a]'); i++) await sleep(100);
    R.dbgCompare = $('#detail').dataset.view + ' | ' + $('#detail').innerText.slice(0, 160) + ' | multi=' + S.multi.length + ' | toasts=' + $$('.toast').map((t) => t.textContent).join(';');
    await waitFor(() => $('#detail [data-cmp-a]'), 'compare: ' + R.dbgCompare);
    R.compareFiles = $$('#detail [data-cmp-a]').map((f) => f.dataset.path);
    click('#detail [data-cmp-a]');
    await waitFor(() => !$('#diffView').hidden && $$('#diffBody .dl.add').length, 'compare diff');
    R.compareDiff = txt('#diffBody');
    await showHistory('config.js');
    await waitFor(() => $$('.hist-c').length === 3, 'history');
    R.history = $$('.hist-c b').map((b) => b.textContent);
    await showBlame('config.js');
    await waitFor(() => $$('.bl').length, 'blame');
    R.blame = $$('.bl').map((b) => b.querySelector('.c').textContent + '|' + (b.querySelector('.bl-who b')?.textContent || ''));
    R.errors = $$('.toast.err').map((t) => t.textContent);
  `));
  assert.deepEqual(consoleErrors, []);
  assert.match(R.staged1, /\+CHANGED 2/);
  assert.doesNotMatch(R.staged1, /CHANGED 27|EXTRA/);
  assert.match(R.lineBar, /1 line selected/);
  assert.match(R.staged2, /\+CHANGED 27/);
  assert.doesNotMatch(R.staged2, /EXTRA 28/, 'only the selected line was staged');
  assert.match(R.unstaged2, /\+EXTRA 28/, 'the other line stays unstaged');
  assert.equal(R.commitUndoTitle, 'Undo commit “Edit long.txt” (⌘Z)');
  assert.equal(R.afterUndo.head, 'Port 8080');
  assert.ok(R.afterUndo.files.some((f) => f[0] === 'M'), 'undo keeps the changes staged (soft reset)');
  assert.equal(R.afterRedo, 'Edit long.txt');
  assert.match(R.multi, /2 commits selected/);
  assert.deepEqual(R.compareFiles, ['config.js']);
  assert.match(R.compareDiff, /port = 4000.*port = 8080/);
  assert.deepEqual(R.history, ['Port 8080', 'Port 4000', 'Initial']);
  assert.deepEqual(R.blame, ['port = 8080|Linus Torvalds']);
  assert.deepEqual(R.errors, []);
});

test('e2e: interactive rebase dialog — squash, reword, drop, reorder by keyboard', { timeout: 120_000 }, async () => {
  const d = H.initRepo('irb-ui');
  const c0 = H.commit(d, 'ada', 'base', { 'f.txt': '0\n' });
  for (const n of ['one', 'two', 'three']) H.commit(d, 'linus', `commit ${n}`, { [`${n}.txt`]: `${n}\n` });
  const { result: R, consoleErrors } = await launch(d, script(`
    await waitFor(() => $$('#rows .row').length === 4, 'rows');
    await openInteractiveRebase('${c0}');
    await waitFor(() => !$('#irbWrap').hidden && $$('.irb-row').length === 3, 'irb dialog');
    R.rows = $$('.irb-row .irb-main b').map((b) => b.textContent);
    // newest on top: "three" squashes into "two"; "one" is dropped (keyboard D)
    click('.irb-row[data-i="0"] [data-a="squash"]');
    const r2 = $('.irb-row[data-i="2"]'); r2.focus();
    r2.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true }));
    R.leaderMsg = $('.irb-row[data-i="1"] textarea')?.value;
    R.summary = txt('.irb-sum');
    const ta = $('.irb-row[data-i="1"] textarea');
    ta.value = 'Two and three together'; ta.dispatchEvent(new Event('input', { bubbles: true }));
    click('#irbGo');
    await waitFor(() => $('#hud').classList.contains('ok'), 'rebased', 15000);
    await idle();
    R.hud = $('#hudTitle').textContent;
    R.subjects = S.commits.map((c) => c.subject);
    R.squashedFiles = (await G('commit', { hash: S.commits[0].hash })).files.map((f) => f.path).sort();
    click('#tbUndo');
    await waitFor(() => $('#hud').classList.contains('ok') && /^Undid/.test($('#hudTitle').textContent), 'undo rebase', 15000);
    await idle();
    R.afterUndo = S.commits.map((c) => c.subject);
  `));
  assert.deepEqual(consoleErrors, []);
  assert.deepEqual(R.rows, ['commit three', 'commit two', 'commit one']);
  assert.equal(R.leaderMsg, 'commit two\n\ncommit three', 'squash pre-fills the combined message');
  assert.match(R.summary, /3 → 1 commit/);
  assert.equal(R.hud, 'Rewrote 3 commits');
  assert.deepEqual(R.subjects, ['Two and three together', 'base']);
  assert.deepEqual(R.squashedFiles, ['three.txt', 'two.txt'], 'two + three squashed, one dropped');
  assert.equal(H.read(d, 'one.txt'), 'one\n', 'undo brought the dropped commit back');
  assert.deepEqual(R.afterUndo, ['commit three', 'commit two', 'commit one', 'base']);
});

test('e2e: drag a branch onto another → rebase with a conflict → skip; remotes & worktrees in the sidebar', { timeout: 150_000 }, async () => {
  const { work, origin } = H.withRemote();
  const d = work;
  H.commit(d, 'ada', 'base', { 'c.txt': 'shared\n' });
  H.sh(d, ['switch', '-q', '-c', 'topic']);
  H.commit(d, 'linus', 'topic conflicting', { 'c.txt': 'TOPIC\n' });
  H.commit(d, 'linus', 'topic clean', { 't.txt': 't\n' });
  H.sh(d, ['switch', '-q', 'main']);
  H.commit(d, 'grace', 'main edit', { 'c.txt': 'MAIN\n' });
  const { result: R, consoleErrors } = await launch(d, script(`
    const hudOk = (re) => waitFor(() => $('#hud').classList.contains('ok') && re.test($('#hudTitle').textContent), 'hud ' + re, 15000);
    await waitFor(() => $$('#rows .row').length && $('#sideScroll .item[data-kind="local"][data-name="topic"]'), 'loaded');
    // drag the "topic" branch (sidebar) onto the "main" pill (graph)
    const src = $('#sideScroll .item[data-kind="local"][data-name="topic"]');
    const dst = $('#rows .ref[data-dnd-name="main"]');
    const dt = new DataTransfer();
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    R.highlight = dst.classList.contains('dnd-over');
    dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    await waitFor(() => !$('#popover').hidden, 'drop menu');
    R.dropMenu = $$('#popover .pop-i b').map((b) => b.textContent);
    click($$('#popover .pop-i').find((b) => b.textContent.includes('Rebase topic onto main')));
    await waitFor(() => $('#detail .op-card'), 'rebase stopped on a conflict');
    await idle();
    R.op = txt('#detail .op-card');
    R.hasSkip = !!$('#opSkip');
    R.branch = txt('#repoBranch');
    click('#opSkip');
    await waitFor(() => !S.status.state && !$('#detail .op-card'), 'rebase finished after skip', 15000);
    await idle();
    R.afterSkip = S.commits.slice(0, 3).map((c) => c.subject);
    R.undoTitle = $('#tbUndo').title;
    // remotes: add one through the sidebar "+"
    await waitFor(() => S.extras, 'extras loaded');
    $('#sideScroll [data-add="remote"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await waitFor(() => !$('#modalWrap').hidden, 'add remote modal');
    type($('#modal input[name="name"]'), 'upstream');
    type($('#modal input[name="url"]'), ${JSON.stringify(origin)});
    $('#modal form').requestSubmit();
    await waitFor(() => S.extras?.remotes.some((r) => r.name === 'upstream'), 'remote added');
    R.remotes = S.extras.remotes.map((r) => r.name);
    R.grp = $$('#sideScroll .grp[data-remote]').map((g) => g.dataset.remote);
    R.worktreeSection = !!$('.sec[data-sec="worktrees"]');
    R.errors = $$('.toast.err').map((t) => t.textContent);
  `), { confirm: 'yes' });
  assert.deepEqual(consoleErrors, []);
  assert.equal(R.highlight, true, 'drop target lights up');
  assert.ok(R.dropMenu.includes('Merge topic into main') && R.dropMenu.includes('Rebase topic onto main') && R.dropMenu.includes('Fast-forward main to topic'));
  assert.match(R.op, /Rebasing topic onto main/);
  assert.match(R.op, /Commit 1 of 2/);
  assert.equal(R.hasSkip, true);
  assert.deepEqual(R.afterSkip, ['topic clean', 'main edit', 'base'], 'conflicting commit skipped, the other replayed on main');
  assert.equal(R.undoTitle, 'Undo rebase onto main (⌘Z)', 'the rebase started by drag & drop is undoable once finished');
  assert.deepEqual(R.remotes, ['origin', 'upstream']);
  assert.equal(R.worktreeSection, true);
  assert.deepEqual(R.errors, []);
  assert.equal(H.sh(d, ['branch', '--show-current']).trim(), 'topic');
});

test('e2e: GitHub issues — list, read, comment, close with comment, create, branch from issue (+undo), PR says "Closes #N"', { timeout: 150_000 }, async () => {
  const { origin, work } = H.withRemote();
  H.sh(work, ['remote', 'set-url', 'origin', 'https://github.com/acme/demo.git']);
  H.sh(work, ['config', `url.${origin}.insteadOf`, 'https://github.com/acme/demo.git']);
  H.resetGh();
  H.setGhAccounts([{ host: 'github.com', login: 'work', token: 'tok-work', active: true }], [
    { number: 7, title: 'Login redirects to a blank page', body: 'Steps:\n- open **/login**\n- see `blank`\n\nSee #3', state: 'OPEN', author: { login: 'ada' }, labels: [{ name: 'bug', color: 'd73a4a' }], assignees: [], comments: [{ author: { login: 'linus' }, body: 'Repro on Safari', createdAt: '2026-01-02T00:00:00Z' }], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', url: 'https://github.com/acme/demo/issues/7' },
    { number: 3, title: 'Old closed one', body: 'done', state: 'CLOSED', author: { login: 'grace' }, labels: [], assignees: [], comments: [], createdAt: '2025-12-01T00:00:00Z', updatedAt: '2025-12-02T00:00:00Z', url: 'https://github.com/acme/demo/issues/3' },
  ]);
  const { result: R, consoleErrors } = await launch(work, script(`
    const hudOk = (re) => waitFor(() => $('#hud').classList.contains('ok') && re.test($('#hudTitle').textContent), 'hud ' + re, 15000);
    await waitFor(() => $('#sideScroll .item[data-kind="issue"]'), 'issues in the sidebar');
    R.section = txt('.sec[data-sec="issues"] .sec-h');
    R.items = $$('#sideScroll .item[data-kind="issue"]').map((i) => i.textContent.replace(/\\s+/g, ' ').trim());
    click('#sideScroll .item[data-kind="issue"][data-num="7"]');
    await waitFor(() => $('#detail .issue-body') && $$('#detail .cmt').length === 1, 'issue detail');
    R.kicker = txt('#detail .d-kicker');
    R.bodyHtml = $('#detail .issue-body').innerHTML;
    R.comment = txt('#detail .cmt');
    // comment
    type('#issueReply', 'Fixed in **next** release');
    R.commentEnabled = !$('[data-issue-act="comment"]').disabled;
    R.closeLabel = txt('[data-issue-act="close"]');
    click('[data-issue-act="comment"]');
    await hudOk(/^Commented on #7$/);
    await waitFor(() => $$('#detail .cmt').length === 2, 'comment shown');
    R.newComment = $$('#detail .cmt .md')[1].innerHTML;
    // branch from issue (+ undo)
    click('[data-issue-act="branch"]');
    await hudOk(/^Created 7-login-redirects-to-a-blank-page and switched to it$/);
    await idle();
    R.branch = txt('#repoBranch');
    R.undoTitle = $('#tbUndo').title;
    // the PR form knows which issue it closes
    createPR();
    await waitFor(() => !$('#prWrap').hidden && PR.cmp && $('#prBody'), 'pr form', 15000);
    R.prBody = $('#prBody').value;
    R.prBranches = [PR.base, PR.head];
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await waitFor(() => $('#prWrap').hidden, 'pr form closed');
    click('#tbUndo');
    await hudOk(/^Undid create branch 7-login-redirects-to-a-blank-page$/);
    await idle();
    R.branchAfterUndo = txt('#repoBranch');
    // close with a comment
    click('#sideScroll .item[data-kind="issue"][data-num="7"]');
    await waitFor(() => $('#issueReply'), 'detail again');
    type('#issueReply', 'Closing, thanks!');
    click('[data-issue-act="close"]');
    await hudOk(/^Closed #7$/);
    await waitFor(() => !$('#sideScroll .item[data-kind="issue"]'), 'no more open issues');
    R.emptyNote = txt('.sec[data-sec="issues"] .sec-body');
    // closed issues view
    click('[data-issue-state="closed"]');
    await waitFor(() => $$('#sideScroll .item[data-kind="issue"]').length === 2, 'closed list');
    R.closed = $$('#sideScroll .item[data-kind="issue"]').map((i) => i.dataset.num).sort();
    click('[data-issue-state="open"]');
    // create a new issue with the "+"
    await waitFor(() => $('.sec[data-sec="issues"] [data-add="issue"]'), 'plus');
    $('.sec[data-sec="issues"] [data-add="issue"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await waitFor(() => !$('#modalWrap').hidden, 'new issue modal');
    type($('#modal input[name="title"]'), 'Crash on save');
    $('#modal textarea[name="body"]').value = 'stack trace';
    $('#modal form').requestSubmit();
    await hudOk(/^Created issue #8$/);
    await waitFor(() => $('#detail .d-title') && txt('#detail .d-title') === 'Crash on save', 'new issue opened');
    R.created = txt('#detail .d-kicker');
    R.errors = $$('.toast.err').map((t) => t.textContent);
  `), { confirm: 'yes' });
  assert.deepEqual(consoleErrors, []);
  assert.match(R.section, /Issues\s*1/);
  assert.equal(R.items.length, 1);
  assert.match(R.items[0], /^Login redirects to a blank page\s*#7 · bug · 1$/);
  assert.match(R.kicker, /Issue #7.*Open/);
  assert.match(R.bodyHtml, /<li>open <b>\/login<\/b><\/li>/);
  assert.match(R.bodyHtml, /<code>blank<\/code>/);
  assert.match(R.bodyHtml, /data-issue-ref="3"/, '#3 becomes a link to issue 3');
  assert.match(R.comment, /linus.*Repro on Safari/);
  assert.equal(R.commentEnabled, true);
  assert.equal(R.closeLabel, 'Close with comment');
  assert.match(R.newComment, /Fixed in <b>next<\/b> release/);
  assert.equal(R.branch, '7-login-redirects-to-a-blank-page');
  assert.equal(R.undoTitle, 'Undo create branch 7-login-redirects-to-a-blank-page (⌘Z)');
  assert.equal(R.prBody, 'Closes #7');
  assert.deepEqual(R.prBranches, ['main', '7-login-redirects-to-a-blank-page'], 'the PR form targets the default branch from the issue branch');
  assert.equal(R.branchAfterUndo, 'main');
  assert.match(R.emptyNote, /No open issues/);
  assert.deepEqual(R.closed, ['3', '7']);
  assert.match(R.created, /Issue #8.*Open/);
  assert.deepEqual(R.errors, []);
  const i7 = H.ghIssues().find((i) => i.number === 7);
  assert.deepEqual([i7.state, i7.comments.map((c) => c.body)], ['CLOSED', ['Repro on Safari', 'Fixed in **next** release', 'Closing, thanks!']]);
  assert.equal(H.sh(work, ['branch', '--list', '7-*']).trim(), '', 'undo deleted the issue branch');
});

test('e2e: integrated terminal — real shell in the repo, git commands refresh the graph, one session per tab', { timeout: 150_000 }, async () => {
  const a = H.initRepo('term-a');
  H.commit(a, 'ada', 'Initial A', { 'a.txt': 'a' });
  H.write(a, 'new.txt', 'from the terminal\n');
  const b = H.initRepo('term-b');
  H.commit(b, 'ada', 'Initial B', { 'b.txt': 'b' });
  const { result: R, consoleErrors } = await launch(a, script(`
    const screen = (t) => { const buf = t.xterm.buffer.active; let o = ''; for (let i = 0; i < buf.length; i++) o += buf.getLine(i).translateToString(true) + '\\n'; return o; };
    const typeIn = (t, s) => { t.xterm.focus(); api.term.write(t.id, s); };
    await waitFor(() => $$('#rows .row').length, 'loaded');
    R.closedAtStart = !document.body.classList.contains('term-on');
    click('#tbTerm');
    await waitFor(() => S.tab.term?.alive, 'shell started', 15000);
    const ta = S.tab.term;
    R.restartHidden = getComputedStyle($('#termRestart')).display === 'none';
    R.header = txt('#termTitle');
    await sleep(800);
    typeIn(ta, 'pwd; echo marker-$((6*7))\\r');
    await waitFor(() => screen(ta).includes('marker-42'), 'command output', 10000);
    R.pwdOk = screen(ta).includes(${JSON.stringify(path.basename(a))});
    // a commit made in the terminal shows up in the graph (status polling / refresh after Enter)
    typeIn(ta, 'git add new.txt && git commit -q -m "Committed in the terminal"\\r');
    await waitFor(() => S.commits[0]?.subject === 'Committed in the terminal', 'graph refreshed', 15000);
    R.graphHead = S.commits[0].subject;
    // second tab gets its own shell, in its own folder
    await openTab(${JSON.stringify(b)});
    await waitFor(() => S.tab.info.name === ${JSON.stringify(path.basename(b))} && S.tab.term?.alive, 'second shell', 15000);
    const tb = S.tab.term;
    R.separateSessions = tb.id !== ta.id;
    await sleep(800);
    typeIn(tb, 'basename "$PWD"\\r');
    await waitFor(() => screen(tb).includes(${JSON.stringify(path.basename(b))}), 'second cwd', 10000);
    R.onlyActiveVisible = $$('#termBody .term-host').filter((h) => !h.hidden).length === 1;
    // exit → restart
    typeIn(tb, 'exit\\r');
    await waitFor(() => !tb.alive, 'exited', 10000);
    await waitFor(() => getComputedStyle($('#termRestart')).display !== 'none', 'restart button', 5000);
    click('#termRestart');
    await waitFor(() => S.tab.term?.alive && S.tab.term !== tb, 'restarted', 15000);
    R.restarted = true;
    // toggle off keeps sessions alive
    click('#termClose');
    R.hidden = !document.body.classList.contains('term-on');
    R.aliveWhileHidden = S.tabs.every((t) => t.term?.alive);
    R.errors = $$('.toast.err').map((t) => t.textContent);
  `));
  assert.deepEqual(consoleErrors, []);
  assert.equal(R.closedAtStart, true);
  assert.equal(R.restartHidden, true, 'no Restart button while the shell runs');
  assert.match(R.header, new RegExp(`${path.basename(a)}.*(zsh|bash)`));
  assert.equal(R.pwdOk, true, 'shell starts in the repository');
  assert.equal(R.graphHead, 'Committed in the terminal');
  assert.equal(R.separateSessions, true);
  assert.equal(R.onlyActiveVisible, true);
  assert.equal(R.restarted, true);
  assert.equal(R.hidden, true);
  assert.equal(R.aliveWhileHidden, true, 'hiding the panel does not kill the shells');
  assert.deepEqual(R.errors, []);
  assert.equal(H.sh(a, ['log', '-1', '--format=%s']).trim(), 'Committed in the terminal');
});
