// Git backend: every operation shells out to the real `git` / `gh` binaries
// with argument arrays (never a shell string), so nothing gets interpolated.
const { execFile, spawn } = require('node:child_process');
const { AsyncLocalStorage } = require('node:async_hooks');
const crypto = require('node:crypto');
const path = require('node:path');
const os = require('node:os');

const US = '\x1f';
const RS = '\x1e';

// Electron apps launched from Finder get a minimal PATH; add the usual spots.
const EXTRA_PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
const ENV = {
  ...process.env,
  PATH: [...new Set([...(process.env.PATH || '').split(':'), ...EXTRA_PATH])].filter(Boolean).join(':'),
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GH_PROMPT_DISABLED: '1',
  GH_NO_UPDATE_NOTIFIER: '1',
};

let repo = null;
// Each IPC call runs inside withRepo(path): concurrent calls for different tabs never mix repos.
const ctx = new AsyncLocalStorage();
const cur = () => ctx.getStore()?.repo ?? repo;
const withRepo = (p, fn, extra = {}) => ctx.run({ repo: p, ...extra }, fn);

function run(cmd, args, { cwd = cur(), ok = [0], input, env } = {}) {
  return new Promise((resolve, reject) => {
    if (!cwd) return reject(new Error('No repository open'));
    const child = execFile(cmd, args, { cwd, env: env ? { ...ENV, ...env } : ENV, maxBuffer: 128 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
      if (ok.includes(code)) resolve(stdout);
      else reject(new Error((stderr || stdout || err?.message || `${cmd} failed`).trim()));
    });
    if (input != null) child.stdin.end(input);
  });
}
const git = (args, opts) => run('git', ['-c', 'core.quotepath=off', '-c', 'color.ui=false', ...args], opts);

// ---------- per-repo account routing ----------
// The resolver (wired by main.js) says which hosting account a repo should use.
// Its token is injected only into the commands Nebula runs — the global gh
// active account and the keychain are never touched.
let authResolver = null;
const setAuthResolver = (fn) => { authResolver = fn; };
const resolveAuth = async () => (authResolver && cur() ? authResolver(cur()) : null);

// GIT_CONFIG_* keeps the token out of argv and off disk.
function authEnv({ token, provider, remote }) {
  if (!token || remote?.protocol !== 'https') return undefined;
  const user = provider === 'gitlab' ? 'oauth2' : 'x-access-token';
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `http.${remote.scheme || 'https'}://${remote.host}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`${user}:${token}`).toString('base64')}`,
  };
}
async function netEnv() {
  const a = await resolveAuth().catch(() => null);
  return a ? authEnv(a) : undefined;
}
// Network commands stream stderr so the UI can show real progress ("Receiving objects 42%").
function runStream(cmd, args, { cwd = cur(), env, onProgress, ok = [0] } = {}) {
  return new Promise((resolve, reject) => {
    if (!cwd) return reject(new Error('No repository open'));
    const child = spawn(cmd, args, { cwd, env: env ? { ...ENV, ...env } : ENV });
    let out = '', err = '', pending = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => {
      err += d; pending += d;
      const parts = pending.split(/[\r\n]/); pending = parts.pop();
      for (const line of parts) {
        const m = line.match(/^(?:remote: )?([A-Za-z ]+?):\s+(\d+)%/);
        if (m) onProgress?.({ phase: m[1].trim(), pct: Number(m[2]) });
      }
    });
    child.on('error', reject);
    child.on('close', (code) => (ok.includes(code) ? resolve(`${out}${err}`) : reject(new Error((err || out || `${cmd} failed`).replace(/^(?:remote: )?[A-Za-z ]+:\s+\d+%.*$/gm, '').replace(/\n{2,}/g, '\n').trim()))));
  });
}
const EDITOR_ENV = { GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' }; // never wait for an editor
/** Exit code of a git command (for yes/no questions like merge-base --is-ancestor). */
const gitCode = (args) => new Promise((resolve) => execFile('git', args, { cwd: cur(), env: ENV }, (e) => resolve(e ? (typeof e.code === 'number' ? e.code : -1) : 0)));
/** Runs a history operation; if git stops on conflicts, that's a state to resolve, not an error. */
async function conflictAware(label, fn, okSummary) {
  try {
    const output = await fn();
    return { output, summary: okSummary };
  } catch (e) {
    const st = await status().catch(() => null);
    if (st?.state && st.conflicts) return { output: e.message, conflicts: st.conflicts, summary: `${label} stopped — ${st.conflicts} conflict${st.conflicts > 1 ? 's' : ''} to resolve` };
    throw e;
  }
}
/** Split a conflicted file into plain text and conflict blocks (supports diff3 base sections). */
function parseConflicts(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const finalNewline = text.endsWith('\n');
  if (finalNewline) lines.pop();
  const segments = [];
  let plain = [], block = null, part = null;
  for (const l of lines) {
    if (!block && l.startsWith('<<<<<<<') && (l.length === 7 || l[7] === ' ')) {
      if (plain.length) segments.push({ type: 'text', lines: plain });
      plain = [];
      block = { type: 'conflict', ours: [], base: null, theirs: [], oursLabel: l.slice(8), theirsLabel: '' };
      part = 'ours';
    } else if (block && part !== 'theirs' && l.startsWith('|||||||')) { block.base = []; part = 'base'; }
    else if (block && part !== 'theirs' && l === '=======') part = 'theirs';
    else if (block && part === 'theirs' && l.startsWith('>>>>>>>') && (l.length === 7 || l[7] === ' ')) {
      block.theirsLabel = l.slice(8);
      segments.push(block);
      block = null; part = null;
    } else if (block) block[part].push(l);
    else plain.push(l);
  }
  if (block) { plain = [...plain, `<<<<<<< ${block.oursLabel}`, ...block.ours, '=======', ...block.theirs]; }
  if (plain.length) segments.push({ type: 'text', lines: plain });
  return { segments, eol, finalNewline, conflicts: segments.filter((s) => s.type === 'conflict').length };
}
const netGit = async ([sub, ...rest], opts = {}) => runStream('git', ['-c', 'core.quotepath=off', '-c', 'color.ui=false', sub, '--progress', ...rest],
  { ...opts, env: await netEnv(), onProgress: ctx.getStore()?.onProgress });
const refSnapshot = async () => new Map((await git(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/remotes', 'refs/tags'])).split('\n').filter((l) => l && !/^refs\/remotes\/[^ ]+\/HEAD /.test(l)).map((l) => l.split(' '))); // origin/HEAD is just an alias
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// Refuse anything that git could parse as an option.
function arg(v, what = 'argument') {
  if (typeof v !== 'string' || !v || v.startsWith('-') || v.includes('\0')) throw new Error(`Invalid ${what}`);
  return v;
}
const files = (list) => (Array.isArray(list) ? list : [list]).map((f) => {
  if (typeof f !== 'string' || !f || f.includes('\0')) throw new Error('Invalid path');
  return f;
});
const isHash = (h) => typeof h === 'string' && /^[0-9a-f]{4,64}$/i.test(h);
const hash = (h) => { if (!isHash(h)) throw new Error('Invalid commit hash'); return h; };
const short = (h) => (h || '').slice(0, 7);
// Paths coming from the UI must stay inside the repository.
function inRepo(p) {
  files(p);
  const root = path.resolve(cur());
  const abs = path.resolve(root, p);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('Path is outside the repository');
  return abs;
}

async function validBranch(name) {
  arg(name, 'branch name');
  await git(['check-ref-format', '--branch', name]).catch(() => { throw new Error(`"${name}" is not a valid branch name`); });
  return name;
}

function avatarFor(email = '') {
  const e = email.trim().toLowerCase();
  const gh = e.match(/^(\d+)\+[^@]+@users\.noreply\.github\.com$/);
  if (gh) return `https://avatars.githubusercontent.com/u/${gh[1]}?s=80`;
  const md5 = crypto.createHash('md5').update(e).digest('hex');
  return `https://www.gravatar.com/avatar/${md5}?s=80&d=404`;
}

// ---------- repository ----------
async function open(dir) {
  const p = path.resolve(dir.replace(/^~(?=$|\/)/, os.homedir()));
  const top = (await run('git', ['rev-parse', '--show-toplevel'], { cwd: p })).trim();
  repo = top; // default for callers outside withRepo (tests, CLI); tabs always pass their repo explicitly
  return withRepo(top, info);
}

async function info() {
  const remotes = (await git(['remote']).catch(() => '')).split('\n').filter(Boolean);
  let remoteUrl = '';
  if (remotes.length) remoteUrl = (await git(['remote', 'get-url', remotes.includes('origin') ? 'origin' : remotes[0]]).catch(() => '')).trim();
  return { path: cur(), name: path.basename(cur()), remotes, remoteUrl };
}

async function hasHead() {
  return (await git(['rev-parse', '--verify', '-q', 'HEAD'], { ok: [0, 1] })).trim() !== '';
}

function parseRefs(D) {
  const refs = [];
  for (let r of D.split(', ').filter(Boolean)) {
    let current = false;
    if (r === 'HEAD') { refs.push({ type: 'head', name: 'HEAD' }); continue; }
    if (r.startsWith('HEAD -> ')) { current = true; r = r.slice(8); }
    if (r.startsWith('tag: ')) r = r.slice(5);
    if (r.startsWith('refs/heads/')) refs.push({ type: 'branch', name: r.slice(11), current });
    else if (r.startsWith('refs/remotes/')) {
      const name = r.slice(13);
      if (!name.endsWith('/HEAD')) refs.push({ type: 'remote', name });
    } else if (r.startsWith('refs/tags/')) refs.push({ type: 'tag', name: r.slice(10) });
  }
  return refs;
}

async function log({ limit = 600 } = {}) {
  if (!(await hasHead())) {
    const any = (await git(['for-each-ref', '--count=1', 'refs/heads', 'refs/remotes'])).trim();
    if (!any) return [];
  }
  const fmt = ['%H', '%P', '%an', '%ae', '%at', '%s', '%D'].join('%x1f') + '%x1e';
  const out = await git(['log', '--branches', '--remotes', '--tags', ...(await hasHead() ? ['HEAD'] : []),
    '--date-order', `-n${Math.min(Number(limit) || 600, 20000)}`, '--decorate=full', `--pretty=format:${fmt}`]);
  return out.split(RS).map((r) => r.replace(/^\n/, '')).filter(Boolean).map((r) => {
    const [h, p, an, ae, at, s, D] = r.split(US);
    return { hash: h, parents: p ? p.split(' ') : [], author: an, email: ae, avatar: avatarFor(ae), time: Number(at), subject: s, refs: parseRefs(D || '') };
  });
}

async function status() {
  const out = await git(['status', '--porcelain=v2', '--branch', '-z', '-uall']);
  const parts = out.split('\0');
  const st = { branch: null, oid: null, upstream: null, ahead: 0, behind: 0, files: [] };
  const fix = (c) => (c === '.' ? ' ' : c);
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    if (p.startsWith('# ')) {
      const [, k, ...v] = p.split(' ');
      const val = v.join(' ');
      if (k === 'branch.head') st.branch = val === '(detached)' ? null : val;
      else if (k === 'branch.oid') st.oid = val === '(initial)' ? null : val;
      else if (k === 'branch.upstream') st.upstream = val;
      else if (k === 'branch.ab') { const m = val.match(/\+(\d+) -(\d+)/); if (m) { st.ahead = +m[1]; st.behind = +m[2]; } }
    } else if (p[0] === '1') {
      const f = p.split(' ');
      st.files.push({ x: fix(f[1][0]), y: fix(f[1][1]), path: f.slice(8).join(' ') });
    } else if (p[0] === '2') {
      const f = p.split(' ');
      st.files.push({ x: fix(f[1][0]), y: fix(f[1][1]), path: f.slice(9).join(' '), orig: parts[++i] });
    } else if (p[0] === 'u') {
      const f = p.split(' ');
      st.files.push({ x: 'U', y: 'U', path: f.slice(10).join(' '), conflict: true, ckind: f[1] });
    } else if (p[0] === '?') {
      st.files.push({ x: '?', y: '?', path: p.slice(2), untracked: true });
    }
  }
  const gitDir = (await git(['rev-parse', '--git-dir'])).trim();
  const fs = require('node:fs');
  const g = path.resolve(cur(), gitDir);
  const rd = (f) => { try { return fs.readFileSync(path.join(g, f), 'utf8').trim(); } catch { return ''; } };
  const rebaseDir = fs.existsSync(path.join(g, 'rebase-merge')) ? 'rebase-merge' : fs.existsSync(path.join(g, 'rebase-apply')) ? 'rebase-apply' : null;
  st.state = rebaseDir ? 'rebasing'
    : fs.existsSync(path.join(g, 'MERGE_HEAD')) ? 'merging'
    : fs.existsSync(path.join(g, 'CHERRY_PICK_HEAD')) ? 'cherry-picking'
    : fs.existsSync(path.join(g, 'REVERT_HEAD')) ? 'reverting' : null;
  st.conflicts = st.files.filter((f) => f.conflict).length;
  if (st.state) {
    const subj = async (ref) => (await git(['log', '-1', '--format=%h %s', ref], { ok: [0, 128] }).catch(() => '')).trim();
    const op = { kind: st.state };
    if (st.state === 'merging') {
      const msg = rd('MERGE_MSG');
      op.incoming = msg.match(/^Merge (?:remote-tracking )?branch '([^']+)'/)?.[1] || (await subj('MERGE_HEAD')).split(' ')[0];
      op.current = st.branch || short(st.oid);
      op.message = msg.split('\n').filter((l) => !l.startsWith('#')).join('\n').trim();
    } else if (st.state === 'rebasing') {
      const headName = rd(`${rebaseDir}/head-name`).replace(/^refs\/heads\//, '');
      op.current = headName || 'HEAD';
      const onto = rd(`${rebaseDir}/onto`);
      op.onto = onto ? (await git(['name-rev', '--name-only', '--no-undefined', onto], { ok: [0, 128] }).catch(() => '')).trim().replace(/~\d+$/, '') || onto.slice(0, 7) : '';
      op.step = Number(rd(`${rebaseDir}/msgnum`) || rd(`${rebaseDir}/next`)) || 0;
      op.total = Number(rd(`${rebaseDir}/end`) || rd(`${rebaseDir}/last`)) || 0;
      op.incoming = (await subj('REBASE_HEAD')) || rd(`${rebaseDir}/stopped-sha`).slice(0, 7);
      op.origHead = rd(`${rebaseDir}/orig-head`) || null; // branch tip before the rebase started
    } else {
      op.incoming = await subj(st.state === 'cherry-picking' ? 'CHERRY_PICK_HEAD' : 'REVERT_HEAD');
      op.current = st.branch || short(st.oid);
    }
    st.op = op;
  }
  return st;
}

async function refs() {
  const fmt = ['%(refname)', '%(objectname)', '%(upstream:short)', '%(upstream:track)', '%(HEAD)', '%(committerdate:unix)'].join('%1f');
  const out = await git(['for-each-ref', `--format=${fmt}`, 'refs/heads', 'refs/remotes', 'refs/tags']);
  const res = { local: [], remote: [], tags: [] };
  for (const line of out.split('\n').filter(Boolean)) {
    const [ref, oid, upstream, track, head, date] = line.split(US);
    const ahead = +(track.match(/ahead (\d+)/)?.[1] || 0);
    const behind = +(track.match(/behind (\d+)/)?.[1] || 0);
    if (ref.startsWith('refs/heads/')) res.local.push({ name: ref.slice(11), oid, upstream, ahead, behind, gone: track.includes('gone'), current: head === '*', date: +date });
    else if (ref.startsWith('refs/remotes/')) { const n = ref.slice(13); if (!n.endsWith('/HEAD')) res.remote.push({ name: n, oid, date: +date }); }
    else res.tags.push({ name: ref.slice(10), oid, date: +date });
  }
  res.tags.sort((a, b) => b.date - a.date);
  return res;
}

async function stashes() {
  const out = await git(['stash', 'list', '--format=%gd%x1f%H%x1f%gs%x1f%at%x1f%an%x1f%ae']).catch(() => '');
  return out.split('\n').filter(Boolean).map((l) => {
    const [ref, h, msg, at, an, ae] = l.split(US);
    return { ref, hash: h, message: msg, time: +at, author: an, email: ae, avatar: avatarFor(ae) };
  });
}

function parseNameStatus(out) {
  const t = out.split('\0'); const res = [];
  for (let i = 0; i < t.length; i++) {
    if (!t[i]) continue;
    const s = t[i];
    if (s[0] === 'R' || s[0] === 'C') res.push({ status: s[0], orig: t[++i], path: t[++i] });
    else res.push({ status: s[0], path: t[++i] });
  }
  return res;
}
function parseNumstat(out) {
  const t = out.split('\0'); const res = [];
  for (let i = 0; i < t.length; i++) {
    if (!t[i]) continue;
    const [a, d, p] = t[i].split('\t');
    const pathName = p === '' ? (i += 2, t[i]) : p;
    res.push({ add: a === '-' ? null : +a, del: d === '-' ? null : +d, path: pathName });
  }
  return res;
}

async function commit({ hash: h }) {
  hash(h);
  const fmt = ['%H', '%P', '%an', '%ae', '%at', '%cn', '%ce', '%ct', '%B'].join('%x1f');
  const head = await git(['show', '-s', `--format=${fmt}`, h]);
  const [H, P, an, ae, at, cn, ce, ct, ...body] = head.split(US);
  const base = ['show', '--format=', '-m', '--first-parent', '--find-renames', '-z'];
  const [ns, num] = await Promise.all([git([...base, '--name-status', h]), git([...base, '--numstat', h])]);
  const stats = parseNumstat(num);
  const fl = parseNameStatus(ns).map((f) => {
    const s = stats.find((x) => x.path === f.path) || {};
    return { ...f, add: s.add, del: s.del };
  });
  return {
    hash: H, parents: P ? P.split(' ') : [], author: an, email: ae, avatar: avatarFor(ae), time: +at,
    committer: cn, committerEmail: ce, committerTime: +ct, message: body.join(US).trim(), files: fl,
  };
}

async function diff({ path: p, mode, hash: h, untracked, a, b, direct }) {
  files(p);
  let out;
  if (mode === 'compare') out = await git(['diff', '--find-renames', direct ? arg(a, 'ref') : `${arg(a, 'ref')}...${arg(b, 'ref')}`, ...(direct ? [arg(b, 'ref')] : []), '--', p]);
  else if (mode === 'commit') out = await git(['show', '--format=', '-m', '--first-parent', '--find-renames', hash(h), '--', p]);
  else if (mode === 'staged') out = await git(['diff', '--cached', '--find-renames', '--', p]);
  else if (untracked) out = await git(['diff', '--no-index', '--', '/dev/null', p], { ok: [0, 1] });
  else out = await git(['diff', '--', p]);
  if (out.length > 3_000_000) out = out.slice(0, 3_000_000) + '\n… diff truncated …';
  return out;
}

// ---------- write operations ----------
const ops = {
  stage: ({ paths }) => git(['add', '-A', '--', ...files(paths)]),
  stageAll: () => git(['add', '-A']),
  unstage: async ({ paths }) => (await hasHead())
    ? git(['restore', '--staged', '--', ...files(paths)])
    : git(['rm', '--cached', '-r', '-q', '--', ...files(paths)]),
  unstageAll: async () => (await hasHead()) ? git(['reset', '-q']) : git(['rm', '--cached', '-r', '-q', '.']),
  discard: async ({ paths, untracked }) => untracked
    ? git(['clean', '-f', '-q', '--', ...files(paths)])
    : git(['restore', '--', ...files(paths)]),
  commitCreate: ({ message, amend }) => {
    if (!message || !message.trim()) throw new Error('Commit message is empty');
    return git(['commit', ...(amend ? ['--amend'] : []), '-F', '-'], { input: message });
  },
  lastMessage: () => git(['log', '-1', '--format=%B']),
  checkout: async ({ ref, remote }) => {
    arg(ref, 'ref');
    if (remote) {
      const local = ref.split('/').slice(1).join('/');
      const exists = (await git(['rev-parse', '--verify', '-q', `refs/heads/${local}`], { ok: [0, 1] })).trim();
      return exists ? git(['switch', local]) : git(['switch', '-c', local, '--track', ref]);
    }
    return git(['switch', ref]);
  },
  checkoutCommit: ({ hash: h }) => git(['switch', '--detach', hash(h)]),
  createBranch: async ({ name, from, checkout }) => {
    await validBranch(name);
    const start = from ? arg(from, 'start point') : 'HEAD';
    return checkout ? git(['switch', '-c', name, start]) : git(['branch', name, start]);
  },
  deleteBranch: ({ name, force }) => git(['branch', force ? '-D' : '-d', arg(name, 'branch')]),
  deleteRemoteBranch: ({ name }) => {
    const [remote, ...rest] = arg(name, 'branch').split('/');
    return netGit(['push', remote, '--delete', rest.join('/')]);
  },
  renameBranch: async ({ name, to }) => git(['branch', '-m', arg(name), await validBranch(to)]),
  merge: ({ ref, ffOnly, noFf }) => conflictAware('Merge', () => git(['merge', '--no-edit', ...(ffOnly ? ['--ff-only'] : []), ...(noFf ? ['--no-ff'] : []), arg(ref, 'ref')]), `Merged ${ref}`),
  rebase: ({ ref }) => conflictAware('Rebase', () => git(['rebase', arg(ref, 'ref')], { env: EDITOR_ENV }), `Rebased onto ${ref}`),
  cherryPick: ({ hash: h }) => conflictAware('Cherry-pick', () => git(['cherry-pick', hash(h)]), `Cherry-picked ${short(h)}`),
  revert: ({ hash: h }) => conflictAware('Revert', () => git(['revert', '--no-edit', hash(h)]), `Reverted ${short(h)}`),
  /** Finish the operation in progress once every conflict is resolved. */
  continueOp: async ({ message } = {}) => {
    const st = await status();
    if (!st.state) throw new Error('Nothing to continue');
    if (st.conflicts) throw new Error(`Resolve the ${st.conflicts} remaining conflict${st.conflicts > 1 ? 's' : ''} first`);
    const label = { merging: 'Merge', rebasing: 'Rebase', 'cherry-picking': 'Cherry-pick', reverting: 'Revert' }[st.state];
    if (st.state === 'merging') {
      return conflictAware(label, () => git(['commit', '-F', '-'], { input: message?.trim() || st.op.message || 'Merge' }), `Merged ${st.op.incoming} into ${st.op.current}`);
    }
    const sub = { rebasing: 'rebase', 'cherry-picking': 'cherry-pick', reverting: 'revert' }[st.state];
    // the resolution made this step identical to HEAD → nothing to commit: skip it instead of failing
    if ((await gitCode(['diff', '--cached', '--quiet'])) === 0) return conflictAware(label, () => git([sub, '--skip'], { env: EDITOR_ENV }), `${label}: step had no changes left, skipped`);
    return conflictAware(label, () => git([sub, '--continue'], { env: EDITOR_ENV }), st.state === 'rebasing' ? `Rebased ${st.op.current} onto ${st.op.onto}` : `${label} completed`);
  },
  skipOp: async () => {
    const st = await status();
    const sub = { rebasing: 'rebase', 'cherry-picking': 'cherry-pick', reverting: 'revert' }[st.state];
    if (!sub) throw new Error(st.state === 'merging' ? 'A merge can only be continued or aborted' : 'Nothing to skip');
    return conflictAware({ rebasing: 'Rebase', 'cherry-picking': 'Cherry-pick', reverting: 'Revert' }[st.state], () => git([sub, '--skip'], { env: EDITOR_ENV }), 'Skipped this commit');
  },
  // ---------- conflict resolution ----------
  conflictFile: async ({ path: p }) => {
    const abs = inRepo(p);
    const stages = (await git(['ls-files', '-u', '-z', '--', p])).split('\0').filter(Boolean).map((l) => +l.split(/\s+/)[2]);
    const st = await status();
    const f = st.files.find((x) => x.path === p);
    const base = { path: p, kind: f?.ckind || 'UU', hasOurs: stages.includes(2), hasTheirs: stages.includes(3), op: st.op || null };
    if (!require('node:fs').existsSync(abs)) return { ...base, deleted: true, segments: [] };
    const buf = require('node:fs').readFileSync(abs);
    if (buf.includes(0)) return { ...base, binary: true, segments: [] };
    return { ...base, ...parseConflicts(buf.toString('utf8')) };
  },
  /** Take one whole side for a file (also handles "deleted by us/them"). */
  resolveFile: async ({ path: p, side }) => {
    inRepo(p);
    if (!['ours', 'theirs'].includes(side)) throw new Error('Invalid side');
    const stages = (await git(['ls-files', '-u', '-z', '--', p])).split('\0').filter(Boolean).map((l) => +l.split(/\s+/)[2]);
    const exists = stages.includes(side === 'ours' ? 2 : 3);
    if (!exists) return git(['rm', '-q', '--', p]); // that side deleted the file
    await git(['checkout', `--${side}`, '--', p]);
    return git(['add', '--', p]);
  },
  /** Save the merged text chosen in the UI and mark the file resolved. */
  saveResolution: async ({ path: p, content }) => {
    const abs = inRepo(p);
    if (typeof content !== 'string') throw new Error('Invalid content');
    if (/^(<{7}|>{7}) /m.test(content)) throw new Error('The file still contains conflict markers');
    const fsm = require('node:fs');
    const tmp = `${abs}.nebula-tmp`;
    fsm.writeFileSync(tmp, content);
    fsm.renameSync(tmp, abs);
    return git(['add', '--', p]);
  },
  markResolved: async ({ path: p }) => {
    const abs = inRepo(p);
    const fsm = require('node:fs');
    if (fsm.existsSync(abs) && /^(<{7}|>{7}) /m.test(fsm.readFileSync(abs, 'utf8'))) throw new Error(`${p} still contains conflict markers`);
    return git(['add', '-A', '--', p]);
  },
  // ---------- interactive rebase ----------
  rebasePlan: async ({ base }) => {
    const range = base ? [`${hash(base)}..HEAD`] : ['HEAD'];
    const out = await git(['log', '--reverse', '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%B%x1e', ...range]);
    const commits = out.split(RS).map((r) => r.replace(/^\n/, '')).filter(Boolean).map((r) => {
      const [h, p, an, ae, at, body] = r.split(US);
      return { hash: h, parents: p ? p.split(' ') : [], author: an, email: ae, avatar: avatarFor(ae), time: +at, message: body.trim(), subject: body.trim().split('\n')[0] };
    });
    if (commits.some((c) => c.parents.length > 1)) throw new Error('This range contains merge commits — interactive rebase of merges is not supported');
    if (commits.length > 300) throw new Error('Too many commits for an interactive rebase (max 300)');
    return commits;
  },
  rebaseInteractive: async ({ base, steps }) => {
    if (!Array.isArray(steps) || !steps.length) throw new Error('Nothing to rebase');
    const plan = await ops.rebasePlan({ base });
    const known = new Set(plan.map((c) => c.hash));
    if (steps.length !== plan.length || !steps.every((s) => known.has(s.hash))) throw new Error('The commit list changed — reopen the interactive rebase');
    const ACTIONS = ['pick', 'reword', 'squash', 'fixup', 'drop'];
    if (steps.some((s) => !ACTIONS.includes(s.action))) throw new Error('Invalid action');
    const kept = steps.filter((s) => s.action !== 'drop');
    if (kept[0] && ['squash', 'fixup'].includes(kept[0].action)) throw new Error('The first commit cannot be squashed into a previous one');
    const st = await status();
    if (st.state) throw new Error(`Finish or abort the ${st.state} first`);
    const os = require('node:os'), fsm = require('node:fs');
    const dir = fsm.mkdtempSync(path.join(os.tmpdir(), 'nebula-rebase-'));
    const lines = [];
    let n = 0;
    const flush = (leader) => {
      if (leader?.message == null) return;
      const f = path.join(dir, `msg-${n++}.txt`);
      fsm.writeFileSync(f, leader.message.trim() + '\n');
      lines.push(`exec git commit --amend --only --allow-empty --no-verify -F ${JSON.stringify(f)}`);
    };
    let leader = null;
    for (const s of steps) {
      if (s.action === 'drop') { lines.push(`drop ${s.hash}`); continue; }
      if (s.action === 'squash' || s.action === 'fixup') { lines.push(`fixup ${s.hash}`); continue; }
      flush(leader);
      lines.push(`pick ${s.hash}`);
      leader = s;
    }
    flush(leader);
    const todo = path.join(dir, 'todo');
    fsm.writeFileSync(todo, lines.join('\n') + '\n');
    const env = { ...EDITOR_ENV, GIT_SEQUENCE_EDITOR: `cp ${JSON.stringify(todo)}` };
    return conflictAware('Rebase', () => git(['rebase', '-i', '--autostash', ...(base ? [hash(base)] : ['--root'])], { env }), `Rewrote ${steps.length} commit${steps.length > 1 ? 's' : ''}`);
  },
  // ---------- partial staging ----------
  applyPatch: ({ patch: p, cached, reverse }) => {
    if (typeof p !== 'string' || !p.includes('@@')) throw new Error('Invalid patch');
    return git(['apply', '--recount', '--whitespace=nowarn', ...(cached ? ['--cached'] : []), ...(reverse ? ['--reverse'] : []), '-'], { input: p });
  },
  // ---------- history / blame / compare ----------
  fileHistory: async ({ path: p }) => {
    files(p);
    const out = await git(['log', '--follow', '-n', '500', '--name-only', '--format=%x1e%H%x1f%an%x1f%ae%x1f%at%x1f%s', '--', p]);
    return out.split(RS).filter((r) => r.trim()).map((r) => {
      const [head, ...rest] = r.trim().split('\n');
      const [h, an, ae, at, s] = head.split(US);
      return { hash: h, author: an, email: ae, avatar: avatarFor(ae), time: +at, subject: s, path: rest.find(Boolean) || p };
    });
  },
  blame: async ({ path: p, rev }) => {
    files(p);
    const out = await git(['blame', '--line-porcelain', ...(rev ? [hash(rev)] : []), '--', p]);
    const lines = [];
    const meta = {};
    let curr = null;
    for (const l of out.split('\n')) {
      const m = l.match(/^([0-9a-f]{40}) \d+ (\d+)/);
      if (m) { curr = { hash: m[1], n: +m[2] }; continue; }
      if (!curr) continue;
      if (l.startsWith('author ')) curr.author = l.slice(7);
      else if (l.startsWith('author-mail ')) curr.email = l.slice(12).replace(/[<>]/g, '');
      else if (l.startsWith('author-time ')) curr.time = +l.slice(12);
      else if (l.startsWith('summary ')) curr.summary = l.slice(8);
      else if (l.startsWith('\t')) {
        meta[curr.hash] ||= { author: curr.author, email: curr.email, time: curr.time, summary: curr.summary, avatar: avatarFor(curr.email) };
        lines.push({ hash: curr.hash, n: curr.n, text: l.slice(1) });
        curr = null;
      }
    }
    return { lines, commits: meta };
  },
  compare: async ({ a, b, direct }) => {
    arg(a, 'ref'); arg(b, 'ref');
    const base = ['diff', '--find-renames', '-z', ...(direct ? [a, b] : [`${a}...${b}`])];
    const [ns, num, counts] = await Promise.all([git([...base, '--name-status']), git([...base, '--numstat']), git(['rev-list', '--left-right', '--count', `${a}...${b}`])]);
    const [behind, ahead] = counts.trim().split(/\s+/).map(Number);
    const stats = parseNumstat(num);
    return { a, b, ahead, behind, files: parseNameStatus(ns).map((f) => ({ ...f, ...(stats.find((x) => x.path === f.path) || {}), path: f.path })) };
  },
  // ---------- remotes / worktrees / submodules / LFS ----------
  remotes: async () => {
    const out = await git(['remote', '-v']);
    const map = {};
    for (const l of out.split('\n').filter(Boolean)) { const [name, url, kind] = l.split(/\s+/); (map[name] ||= { name })[kind === '(push)' ? 'push' : 'fetch'] = url; }
    return Object.values(map);
  },
  addRemote: ({ name, url }) => git(['remote', 'add', arg(name, 'remote name'), arg(url, 'url')]),
  removeRemote: ({ name }) => git(['remote', 'remove', arg(name, 'remote name')]),
  renameRemote: ({ name, to }) => git(['remote', 'rename', arg(name, 'remote name'), arg(to, 'remote name')]),
  setRemoteUrl: ({ name, url }) => git(['remote', 'set-url', arg(name, 'remote name'), arg(url, 'url')]),
  fetchRemote: async ({ name }) => ({ output: await netGit(['fetch', '--prune', arg(name, 'remote name')]), summary: `Fetched ${name}` }),
  worktrees: async () => {
    const out = await git(['worktree', 'list', '--porcelain']);
    return out.split('\n\n').filter(Boolean).map((b) => {
      const w = {};
      for (const l of b.split('\n')) { const [k, ...v] = l.split(' '); w[k] = v.join(' ') || true; }
      return { path: w.worktree, head: w.HEAD, branch: typeof w.branch === 'string' ? w.branch.replace(/^refs\/heads\//, '') : null, bare: !!w.bare, detached: !!w.detached, locked: !!w.locked, main: false };
    }).map((w, i) => ({ ...w, main: i === 0 }));
  },
  addWorktree: async ({ path: p, branch, newBranch }) => {
    if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error('Choose an absolute folder for the worktree');
    if (newBranch) { await validBranch(newBranch); return git(['worktree', 'add', '-b', newBranch, p, ...(branch ? [arg(branch, 'branch')] : [])]); }
    return git(['worktree', 'add', p, arg(branch, 'branch')]);
  },
  removeWorktree: ({ path: p, force }) => git(['worktree', 'remove', ...(force ? ['--force'] : []), arg(p, 'path')]),
  submodules: async () => {
    const out = await git(['submodule', 'status', '--recursive'], { ok: [0, 1] }).catch(() => '');
    return out.split('\n').filter(Boolean).map((l) => {
      const m = l.match(/^([ +\-U])([0-9a-f]+) (\S+)(?: \((.+)\))?/);
      return m && { state: { ' ': 'ok', '+': 'changed', '-': 'uninitialized', U: 'conflict' }[m[1]], sha: m[2], path: m[3], describe: m[4] || '' };
    }).filter(Boolean);
  },
  submoduleUpdate: async () => ({ output: await netGit(['submodule', 'update', '--init', '--recursive']), summary: 'Submodules updated' }),
  lfsInfo: async () => {
    const fsm = require('node:fs');
    let attrs = '';
    try { attrs = fsm.readFileSync(path.join(cur(), '.gitattributes'), 'utf8'); } catch {}
    const used = /filter=lfs/.test(attrs);
    const installed = used ? await run('git', ['lfs', 'version']).then(() => true).catch(() => false) : false;
    return { used, installed };
  },
  lfsPull: async () => ({ output: await netGit(['lfs', 'pull']), summary: 'LFS files downloaded' }),
  /** Move a branch forward to `to` only if that's a fast-forward (no history rewrite). */
  fastForward: async ({ branch, to }) => {
    arg(branch, 'branch'); arg(to, 'ref');
    const st = await status();
    if (branch === st.branch) return conflictAware('Fast-forward', () => git(['merge', '--ff-only', to]), `Fast-forwarded ${branch} to ${to}`);
    if ((await gitCode(['merge-base', '--is-ancestor', `refs/heads/${branch}`, to])) !== 0) throw new Error(`${branch} cannot be fast-forwarded to ${to} (the branches diverged)`);
    const old = (await git(['rev-parse', `refs/heads/${branch}`])).trim();
    const target = (await git(['rev-parse', `${to}^{commit}`])).trim();
    await git(['update-ref', `refs/heads/${branch}`, target, old]);
    return { summary: `Fast-forwarded ${branch} to ${to}` };
  },
  reset: ({ hash: h, mode }) => {
    if (!['soft', 'mixed', 'hard'].includes(mode)) throw new Error('Invalid reset mode');
    return git(['reset', `--${mode}`, hash(h)]);
  },
  createTag: ({ name, hash: h }) => git(['tag', arg(name, 'tag'), hash(h)]),
  deleteTag: ({ name }) => git(['tag', '-d', arg(name, 'tag')]),
  abort: async () => {
    const st = await status();
    const map = { merging: ['merge', '--abort'], rebasing: ['rebase', '--abort'], 'cherry-picking': ['cherry-pick', '--abort'], reverting: ['revert', '--abort'] };
    if (!map[st.state]) throw new Error('Nothing to abort');
    return git(map[st.state]);
  },
  stash: ({ message }) => git(['stash', 'push', '-u', ...(message ? ['-m', message] : [])]),
  stashApply: ({ ref }) => git(['stash', 'apply', stashRef(ref)]),
  stashPop: ({ ref }) => git(['stash', 'pop', ...(ref ? [stashRef(ref)] : [])]),
  stashDrop: ({ ref }) => git(['stash', 'drop', stashRef(ref)]),
  fetch: async () => {
    const before = await refSnapshot();
    const output = await netGit(['fetch', '--all', '--prune', '--tags']);
    const after = await refSnapshot();
    let updated = 0, added = 0, removed = 0;
    for (const [r, h] of after) if (!before.has(r)) added++; else if (before.get(r) !== h) updated++;
    for (const r of before.keys()) if (!after.has(r)) removed++;
    const bits = [updated && `${plural(updated, 'ref')} updated`, added && `${added} new`, removed && `${removed} pruned`].filter(Boolean);
    return { output, summary: bits.length ? `Fetched — ${bits.join(', ')}` : 'Fetched — everything up to date' };
  },
  pull: async ({ mode = 'ff' } = {}) => {
    const modes = { ff: ['--no-rebase', '--ff', '--no-edit'], 'ff-only': ['--ff-only'], rebase: ['--rebase'] };
    if (!modes[mode]) throw new Error('Invalid pull mode');
    const st = await status();
    if (!st.upstream) throw new Error(`${st.branch || 'HEAD'} has no upstream branch — push it first`);
    const old = st.oid;
    let output;
    try { output = await netGit(['pull', ...modes[mode]]); } catch (e) {
      const after = await status();
      if (after.state && after.conflicts) return { output: e.message, conflicts: after.conflicts, summary: `Pull stopped — ${after.conflicts} conflict${after.conflicts > 1 ? 's' : ''} to resolve` };
      throw e;
    }
    const now = (await git(['rev-parse', 'HEAD'])).trim();
    const n = old && old !== now ? Number((await git(['rev-list', '--count', `${old}..${now}`])).trim()) : 0;
    return { output, summary: n ? `Pulled ${plural(n, 'commit')} into ${st.branch}${mode === 'rebase' ? ' (rebased)' : ''}` : `${st.branch} is already up to date` };
  },
  push: async ({ force, tags } = {}) => {
    const st = await status();
    const remotes = (await git(['remote'])).split('\n').filter(Boolean);
    if (!remotes.length) throw new Error('No remote configured');
    const remote = st.upstream ? st.upstream.split('/')[0] : (remotes.includes('origin') ? 'origin' : remotes[0]);
    if (tags) return { output: await netGit(['push', remote, '--tags']), summary: `Pushed tags to ${remote}` };
    if (!st.branch) throw new Error('Detached HEAD — check out a branch to push');
    const f = force ? ['--force-with-lease'] : [];
    if (st.upstream) {
      const output = await netGit(['push', ...f]);
      return { output, summary: /Everything up-to-date/.test(output) ? `${st.branch} is already up to date on ${remote}` : `${force ? 'Force-pushed' : 'Pushed'} ${st.ahead ? plural(st.ahead, 'commit') : st.branch} to ${st.upstream}` };
    }
    const output = await netGit(['push', ...f, '-u', remote, 'HEAD']);
    return { output, summary: `Published ${st.branch} to ${remote}` };
  },
  pushBranch: async ({ name }) => ({ output: await netGit(['push', '-u', 'origin', arg(name, 'branch')]), summary: `Pushed ${name} to origin` }),
};
function stashRef(r) { if (!/^stash@\{\d+\}$/.test(r || '')) throw new Error('Invalid stash'); return r; }

// ---------- pull / merge requests: GitHub via gh, GitLab via REST ----------
const gitlab = require('./gitlab');
const PR_FIELDS = 'number,title,author,headRefName,baseRefName,isDraft,url,createdAt,updatedAt,reviewDecision,additions,deletions,changedFiles,labels,body,state';

async function hosting() {
  const a = await resolveAuth().catch(() => null);
  if (!a?.provider) throw new Error('No GitHub or GitLab remote found for this repository');
  return a;
}
const ghEnv = (a) => ({ GH_HOST: a.remote.host, ...(a.token ? { GH_TOKEN: a.token } : {}) });
// Always name the repo explicitly: with an SSH alias remote (github.com-work) gh can't infer it.
const ghRepo = (a) => (a.remote?.path ? ['--repo', `${a.remote.host}/${a.remote.path}`] : []);
const gh = (a, args, opts = {}) => run('gh', [...args, ...ghRepo(a)], { ...opts, env: ghEnv(a) });
/** REST call through gh with the repo's account (gh api takes no --repo flag). */
const ghApi = async (a, apiPath, extra = []) => JSON.parse((await run('gh', ['api', apiPath, ...extra], { env: ghEnv(a) })) || 'null');

async function prs() {
  let a;
  try {
    a = await hosting();
    if (a.provider === 'gitlab') return { available: true, provider: 'gitlab', items: await gitlab.listMRs(a) };
    const out = await gh(a, ['pr', 'list', '--state', 'open', '--limit', '50', '--json', PR_FIELDS]);
    return { available: true, provider: 'github', items: JSON.parse(out || '[]') };
  } catch (e) {
    return { available: false, provider: a?.provider || null, error: e.message.split('\n')[0] };
  }
}
// ---------- issues: GitHub via gh, GitLab via REST ----------
const ISSUE_LIST = 'number,title,author,labels,assignees,comments,createdAt,updatedAt,url,state';
const ISSUE_VIEW = 'number,title,body,author,labels,assignees,comments,createdAt,updatedAt,url,state';
const ghIssue = (i) => ({ ...i, commentsCount: Array.isArray(i.comments) ? i.comments.length : i.comments || 0, comments: Array.isArray(i.comments) ? i.comments : undefined });
const issueNum = (n) => { const v = parseInt(n, 10); if (!(v > 0)) throw new Error('Invalid issue number'); return v; };
async function issues({ state = 'open' } = {}) {
  let a;
  try {
    if (!['open', 'closed'].includes(state)) throw new Error('Invalid state');
    a = await hosting();
    if (a.provider === 'gitlab') return { available: true, provider: 'gitlab', items: await gitlab.listIssues(a, { state: state === 'open' ? 'opened' : 'closed' }) };
    const out = await gh(a, ['issue', 'list', '--state', state, '--limit', '100', '--json', ISSUE_LIST]);
    return { available: true, provider: 'github', items: JSON.parse(out || '[]').map((i) => { const x = ghIssue(i); delete x.comments; return x; }) };
  } catch (e) {
    return { available: false, provider: a?.provider || null, error: e.message.split('\n')[0] };
  }
}
const issueOps = {
  issueView: async ({ number }) => {
    const n = issueNum(number);
    const a = await hosting();
    if (a.provider === 'gitlab') return gitlab.viewIssue(a, n);
    const i = JSON.parse(await gh(a, ['issue', 'view', String(n), '--json', ISSUE_VIEW]));
    return { ...ghIssue(i), comments: (i.comments || []).map((c) => ({ author: { login: c.author?.login }, body: c.body, createdAt: c.createdAt })) };
  },
  issueCreate: async ({ title, body }) => {
    if (!title?.trim()) throw new Error('A title is required');
    const a = await hosting();
    if (a.provider === 'gitlab') return gitlab.createIssue(a, { title: title.trim(), body });
    const url = (await gh(a, ['issue', 'create', '--title', title.trim(), '--body', body || ''])).trim();
    return { url, number: Number(url.match(/\/issues\/(\d+)/)?.[1]) || null };
  },
  issueComment: async ({ number, body }) => {
    if (!body?.trim()) throw new Error('The comment is empty');
    const n = issueNum(number);
    const a = await hosting();
    if (a.provider === 'gitlab') return gitlab.commentIssue(a, n, body.trim());
    return gh(a, ['issue', 'comment', String(n), '--body', body.trim()]);
  },
  issueSetState: async ({ number, open }) => {
    const n = issueNum(number);
    const a = await hosting();
    if (a.provider === 'gitlab') return gitlab.setIssueState(a, n, !!open);
    return gh(a, ['issue', open ? 'reopen' : 'close', String(n)]);
  },
  issueAssignMe: async ({ number }) => {
    const n = issueNum(number);
    const a = await hosting();
    if (a.provider === 'gitlab') return gitlab.assignMe(a, n);
    return gh(a, ['issue', 'edit', String(n), '--add-assignee', '@me']);
  },
  /** GitKraken-style: a branch named after the issue, e.g. "42-fix-login-redirect". */
  issueBranch: async ({ number, title, checkout = true, from }) => {
    const n = issueNum(number);
    const slug = String(title || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '');
    const name = `${n}${slug ? `-${slug}` : ''}`;
    await validBranch(name);
    await (checkout ? git(['switch', '-c', name, ...(from ? [arg(from, 'start point')] : [])]) : git(['branch', name, ...(from ? [arg(from, 'start point')] : [])]));
    return { name, summary: `Created ${name}${checkout ? ' and switched to it' : ''}` };
  },
};

const prOps = {
  prCheckout: async ({ number }) => {
    const n = parseInt(number, 10);
    const a = await hosting();
    if (a.provider === 'gitlab') {
      await netGit(['fetch', 'origin', `merge-requests/${n}/head:mr/${n}`]);
      return git(['switch', `mr/${n}`]);
    }
    return gh(a, ['pr', 'checkout', String(n)]);
  },
  /** Everything the "new pull request" form needs, from the hosting account of this repo. */
  prMeta: async () => {
    const a = await hosting();
    const fsm = require('node:fs');
    let template = null;
    for (const f of ['.github/pull_request_template.md', '.github/PULL_REQUEST_TEMPLATE.md', 'pull_request_template.md', 'docs/pull_request_template.md', '.gitlab/merge_request_templates/Default.md']) {
      try { template = fsm.readFileSync(path.join(cur(), f), 'utf8'); break; } catch {}
    }
    const st = await status();
    const remotes = (await git(['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin'])).split('\n').filter((r) => r && r !== 'origin/HEAD' && r !== 'origin').map((r) => r.replace(/^origin\//, ''));
    const local = (await git(['for-each-ref', '--format=%(refname:short)', 'refs/heads'])).split('\n').filter(Boolean);
    let meta;
    if (a.provider === 'gitlab') meta = await gitlab.mrMeta(a);
    else {
      const p = a.remote.path;
      const [repoInfo, users, labels, milestones, me] = await Promise.all([
        ghApi(a, `repos/${p}`),
        ghApi(a, `repos/${p}/assignees?per_page=100`).catch(() => []),
        ghApi(a, `repos/${p}/labels?per_page=100`).catch(() => []),
        ghApi(a, `repos/${p}/milestones?state=open&per_page=100`).catch(() => []),
        ghApi(a, 'user').catch(() => null),
      ]);
      // team reviewers exist only for organisation repos: teams with access to the repo, else the org's teams
      let teams = [];
      if (repoInfo?.owner?.type === 'Organization') {
        const org = repoInfo.owner.login;
        const raw = await ghApi(a, `repos/${p}/teams?per_page=100`).catch(() => null) || await ghApi(a, `orgs/${org}/teams?per_page=100`).catch(() => []);
        teams = (raw || []).map((t) => ({ slug: `${org}/${t.slug}`, name: t.name, description: t.description || '' }));
      }
      meta = {
        defaultBranch: repoInfo?.default_branch || 'main', me: me?.login || null, teams,
        users: (users || []).map((u) => ({ login: u.login, avatar: u.avatar_url })),
        labels: (labels || []).map((l) => ({ name: l.name, color: l.color, description: l.description || '' })),
        milestones: (milestones || []).map((m) => ({ title: m.title, number: m.number })),
      };
    }
    return { ...meta, provider: a.provider, repo: `${a.remote.host}/${a.remote.path}`, account: a.account?.login || null, template: meta.template ?? template,
      current: st.branch, remoteBranches: remotes, localBranches: local };
  },
  /** What the PR would contain: commits, files, mergeability (git merge-tree, no checkout), publish state. */
  prCompare: async ({ base, head }) => {
    arg(base, 'base'); arg(head, 'head');
    const baseRef = (await gitCode(['rev-parse', '--verify', '-q', `refs/remotes/origin/${base}`])) === 0 ? `origin/${base}` : base;
    const hasLocal = (await gitCode(['rev-parse', '--verify', '-q', `refs/heads/${head}`])) === 0;
    const hasRemote = (await gitCode(['rev-parse', '--verify', '-q', `refs/remotes/origin/${head}`])) === 0;
    if (!hasLocal && !hasRemote) throw new Error(`Branch ${head} not found`);
    const headRef = hasLocal ? head : `origin/${head}`;
    const log = (await git(['log', '--format=%H%x1f%s%x1f%an%x1f%ae', '-n', '250', `${baseRef}..${headRef}`])).split('\n').filter(Boolean).map((l) => {
      const [h, s, an, ae] = l.split(US); return { hash: h, subject: s, author: an, avatar: avatarFor(ae) };
    });
    const stat = (await git(['diff', '--shortstat', `${baseRef}...${headRef}`])).trim();
    const n = (re) => Number(stat.match(re)?.[1] || 0);
    let mergeable = 'unknown', conflicts = [];
    const mt = await new Promise((resolve) => execFile('git', ['merge-tree', '--write-tree', '--name-only', '--no-messages', baseRef, headRef], { cwd: cur(), env: ENV }, (e, out) => resolve({ code: e ? e.code : 0, out })));
    if (mt.code === 0) mergeable = 'clean';
    else if (mt.code === 1) { mergeable = 'conflicts'; conflicts = mt.out.split('\n').slice(1).filter(Boolean); }
    let unpushed = 0;
    if (hasLocal) unpushed = hasRemote ? Number((await git(['rev-list', '--count', `origin/${head}..${head}`])).trim()) : -1;
    return { base, head, commits: log, files: n(/(\d+) files? changed/), additions: n(/(\d+) insertions?/), deletions: n(/(\d+) deletions?/), mergeable, conflicts, published: hasRemote, unpushed };
  },
  prCreate: async ({ title, body, base, draft, head: headBranch, reviewers = [], assignees = [], labels = [], milestone }) => {
    if (headBranch) arg(headBranch, 'head');
    if (!title?.trim()) throw new Error('A title is required');
    if (base) arg(base, 'base');
    const list = (v) => (Array.isArray(v) ? v : []).map((x) => { if (typeof x !== 'string' || !/^[\w@./ :-]{1,100}$/.test(x) || x.startsWith('-')) throw new Error('Invalid reviewer, assignee or label'); return x; });
    const R = list(reviewers), A = list(assignees), L = list(labels);
    if (milestone) list([milestone]);
    const a = await hosting();
    const st = await status();
    const head = headBranch || st.branch;
    if (!head) throw new Error('Check out a branch first');
    // publish the source branch first if needed (GitHub/GitLab need it on the remote)
    const hasLocal = (await gitCode(['rev-parse', '--verify', '-q', `refs/heads/${head}`])) === 0;
    const hasRemote = (await gitCode(['rev-parse', '--verify', '-q', `refs/remotes/origin/${head}`])) === 0;
    if (hasLocal && (!hasRemote || Number((await git(['rev-list', '--count', `origin/${head}..${head}`])).trim()) > 0)) {
      await netGit(['push', '-u', 'origin', head]);
    }
    if (a.provider === 'gitlab') {
      const mr = await gitlab.createMRFull(a, { source: head, target: base, title: title.trim(), body, draft, reviewers: R, assignees: A, labels: L, milestone });
      return { url: mr.web_url, number: mr.iid, summary: `Opened merge request !${mr.iid}` };
    }
    const out = (await gh(a, ['pr', 'create', '--title', title.trim(), '--body', body || '', '--head', head, ...(base ? ['--base', base] : []), ...(draft ? ['--draft'] : []),
      ...R.flatMap((r) => ['--reviewer', r]), ...A.flatMap((x) => ['--assignee', x]), ...L.flatMap((l) => ['--label', l]), ...(milestone ? ['--milestone', milestone] : [])])).trim();
    const url = out.split('\n').reverse().find((l) => /^https?:\/\//.test(l)) || out;
    const number = Number(url.match(/\/pull\/(\d+)/)?.[1]) || null;
    return { url, number, summary: `Opened pull request${number ? ` #${number}` : ''}` };
  },
  prMerge: async ({ number, method }) => {
    if (!['merge', 'squash', 'rebase'].includes(method)) throw new Error('Invalid merge method');
    const a = await hosting();
    if (a.provider === 'gitlab') return gitlab.mergeMR(a, parseInt(number, 10), method);
    return gh(a, ['pr', 'merge', String(parseInt(number, 10)), `--${method}`]);
  },
};

// Every operation returns a promise, even when argument validation fails synchronously.
const asAsync = (o) => Object.fromEntries(Object.entries(o).map(([k, fn]) => [k, async (...a) => fn(...a)]));

module.exports = {
  open, info, log, status, refs, stashes, commit, diff, prs,
  ...asAsync(ops), ...asAsync(prOps), ...asAsync(issueOps), issues,
  setAuthResolver, run, runStream, authEnv, parseConflicts,
  gitAt: (cwd, args, opts = {}) => git(args, { ...opts, cwd }),
  withRepo,
  get repo() { return cur(); },
};
