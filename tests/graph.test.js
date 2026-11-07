const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const H = require('./helpers');
const git = require('../src/git');

// graph.js is a browser script: load it into a sandbox and pull out its globals.
const ctx = {};
vm.runInNewContext(`${fs.readFileSync(path.join(__dirname, '../src/renderer/graph.js'), 'utf8')}; this.layoutGraph = layoutGraph; this.LANE_COLORS = LANE_COLORS;`, ctx);
const { layoutGraph } = ctx;

/**
 * Structural invariants of a valid layout:
 *  - lanes leaving the bottom of row r are exactly the lanes entering the top of row r+1 (no broken/dangling lines)
 *  - a lane carries the same color across the row boundary
 *  - the node's own lane receives every "in" edge and emits every "out" edge
 *  - each parent edge is emitted, merges get one extra edge per extra parent
 *  - no two distinct commits share a lane at the same time
 */
function checkInvariants(commits, L) {
  assert.equal(L.rows.length, commits.length);
  const loaded = new Set(commits.map((c) => c.hash));
  for (let r = 0; r < L.rows.length; r++) {
    const row = L.rows[r];
    const c = commits[r];
    for (const s of row.segs) {
      if (s.kind === 'in') assert.equal(s.to, row.col, `row ${r}: in-edge must land on node`);
      if (s.kind === 'out') assert.equal(s.from, row.col, `row ${r}: out-edge must leave node`);
      assert.ok(s.from >= 0 && s.to >= 0 && s.from < L.maxLanes && s.to < L.maxLanes, `row ${r}: lane within maxLanes`);
    }
    const outs = row.segs.filter((s) => s.kind === 'out');
    assert.equal(outs.length, c.parents.length, `row ${r}: one out-edge per parent`);
    assert.equal(outs.filter((s) => s.merge).length, Math.max(0, c.parents.length - 1));
    assert.equal(row.merge, c.parents.length > 1);

    const bottom = new Map();
    for (const s of row.segs) if (s.kind !== 'in') {
      const prev = bottom.get(s.to);
      if (prev) assert.equal(prev, s.color, `row ${r}: two edges into lane ${s.to} with different colors`);
      bottom.set(s.to, s.color);
    }
    if (r + 1 < L.rows.length) {
      const top = new Map();
      for (const s of L.rows[r + 1].segs) if (s.kind !== 'out') top.set(s.from, s.color);
      assert.deepEqual([...top.keys()].sort((a, b) => a - b), [...bottom.keys()].sort((a, b) => a - b), `rows ${r}->${r + 1}: lanes must connect`);
      for (const [lane, color] of top) assert.equal(bottom.get(lane), color, `rows ${r}->${r + 1}: lane ${lane} changes color`);
    } else {
      // last row: only edges to parents that are not loaded (truncated history) may continue downward
      for (const s of row.segs) if (s.kind === 'out') assert.ok(!loaded.has(c.parents[outs.indexOf(s)]));
    }
    // first row has nothing coming from above
    if (r === 0) assert.equal(row.segs.filter((s) => s.kind !== 'out').length, 0);
  }
}

const C = (hash, ...parents) => ({ hash, parents });

test('linear history uses a single lane', () => {
  const commits = [C('d', 'c'), C('c', 'b'), C('b', 'a'), C('a')];
  const L = layoutGraph(commits);
  checkInvariants(commits, L);
  assert.equal(L.maxLanes, 1);
  assert.ok(L.rows.every((r) => r.col === 0));
});

test('feature branch + merge: branch gets its own lane and converges at the fork point', () => {
  //   m (merge of b2 into a2)
  //   | \
  //   a2 b2
  //   |  b1
  //   | /
  //   a1
  const commits = [C('m', 'a2', 'b2'), C('a2', 'a1'), C('b2', 'b1'), C('b1', 'a1'), C('a1')];
  const L = layoutGraph(commits);
  checkInvariants(commits, L);
  assert.equal(L.maxLanes, 2);
  assert.equal(L.rows[0].col, 0);
  assert.equal(L.rows[2].col, 1, 'b2 on second lane');
  assert.equal(L.rows[4].col, 0, 'fork point back on main lane');
  assert.equal(L.rows[4].segs.filter((s) => s.kind === 'in').length, 2, 'two lanes converge into the fork point');
  assert.notEqual(L.rows[2].color, L.rows[0].color, 'branch has a different color');
});

test('several branch tips and an octopus merge', () => {
  const commits = [
    C('t3', 'x'), C('t2', 'x'), C('t1', 'x'),
    C('oct', 'p1', 'p2', 'p3'), C('p1', 'x'), C('p2', 'x'), C('p3', 'x'),
    C('x', 'root'), C('root'),
  ];
  const L = layoutGraph(commits);
  checkInvariants(commits, L);
  assert.equal(L.rows[3].segs.filter((s) => s.kind === 'out').length, 3);
});

test('truncated history: edges to unloaded parents run off the bottom', () => {
  const commits = [C('b', 'a'), C('a', 'zzz-not-loaded')];
  const L = layoutGraph(commits);
  checkInvariants(commits, L);
});

test('WIP pseudo-commit on top of HEAD and on an empty repo', () => {
  const withHead = [C('WIP', 'h'), C('h', 'g'), C('g')];
  checkInvariants(withHead, layoutGraph(withHead));
  const empty = [C('WIP')];
  checkInvariants(empty, layoutGraph(empty));
  assert.equal(layoutGraph([]).rows.length, 0);
});

test('lanes are reused after a branch ends (graph stays narrow)', () => {
  // 10 short-lived branches merged one after another into main
  const commits = [];
  let mainHash = 'm10';
  for (let i = 10; i >= 1; i--) {
    commits.push(C(`m${i}`, `m${i - 1}`, `f${i}`), C(`f${i}`, `m${i - 1}`));
    mainHash = `m${i - 1}`;
  }
  commits.push(C(mainHash));
  const L = layoutGraph(commits);
  checkInvariants(commits, L);
  assert.ok(L.maxLanes <= 2, `expected ≤2 lanes, got ${L.maxLanes}`);
});

test('fuzz: 300 random DAGs keep every invariant', () => {
  let seed = 1234567;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let run = 0; run < 300; run++) {
    const n = 2 + Math.floor(rand() * 60);
    // generate oldest→newest, each commit picks 1-3 earlier parents, then reverse (children first)
    const made = [];
    for (let i = 0; i < n; i++) {
      const parents = [];
      if (i > 0) {
        const k = rand() < 0.15 ? (rand() < 0.2 ? 3 : 2) : 1;
        for (let j = 0; j < k; j++) {
          const p = made[Math.floor(rand() * i)].hash;
          if (!parents.includes(p)) parents.push(p);
        }
      }
      made.push(C(`c${i}`, ...parents));
    }
    const commits = made.reverse();
    checkInvariants(commits, layoutGraph(commits));
  }
});

test('real git history (date-ordered, with merges) keeps every invariant', async () => {
  const d = H.initRepo('graph-real');
  H.commit(d, 'ada', 'root', { a: '0' });
  for (let i = 0; i < 6; i++) {
    H.sh(d, ['switch', '-q', '-c', `b${i}`]);
    H.commit(d, 'linus', `b${i} 1`, { [`b${i}`]: '1' });
    H.sh(d, ['switch', '-q', 'main']);
    H.commit(d, 'grace', `main ${i}`, { a: String(i) });
    H.sh(d, ['switch', '-q', `b${i}`]);
    H.commit(d, 'octo', `b${i} 2`, { [`b${i}`]: '2' });
    H.sh(d, ['switch', '-q', 'main']);
    if (i % 2 === 0) H.sh(d, ['merge', '-q', '--no-ff', `b${i}`, '-m', `merge b${i}`]);
  }
  await git.open(d);
  const log = await git.log();
  checkInvariants(log, layoutGraph(log));
  // the same with a truncated window
  const cut = await git.log({ limit: 7 });
  checkInvariants(cut, layoutGraph(cut));
});
