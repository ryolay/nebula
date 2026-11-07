// Power features: conflicts, undo/redo, interactive rebase, partial staging, drag & drop, history/blame/compare, remotes & co.

// ===================================================================== helpers
const OP = {
  merging: { verb: 'Merging', noun: 'merge', go: 'Commit merge', icon: 'merge' },
  rebasing: { verb: 'Rebasing', noun: 'rebase', go: 'Continue rebase', icon: 'branch' },
  'cherry-picking': { verb: 'Cherry-picking', noun: 'cherry-pick', go: 'Continue cherry-pick', icon: 'sparkle' },
  reverting: { verb: 'Reverting', noun: 'revert', go: 'Continue revert', icon: 'undo' },
};
/** Human labels for the two sides of a conflict, which depend on the operation. */
function sides(op) {
  if (!op) return { ours: 'Mine', theirs: 'Theirs' };
  if (op.kind === 'rebasing') return { ours: `Base · ${op.onto || 'upstream'}`, theirs: `Your commit · ${op.incoming || ''}`.trim() };
  if (op.kind === 'cherry-picking') return { ours: `Mine · ${op.current}`, theirs: `Cherry-pick · ${op.incoming}` };
  if (op.kind === 'reverting') return { ours: `Mine · ${op.current}`, theirs: `Revert of ${op.incoming}` };
  return { ours: `Mine · ${op.current}`, theirs: `Theirs · ${op.incoming}` };
}
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// ===================================================================== undo / redo
const stacks = () => { const t = S.tab || {}; t.undo ||= []; t.redo ||= []; return t; };
const headOf = () => ({ oid: S.status?.oid || null, branch: S.status?.branch || null });

/** Called by act() after a successful undoable action. `spec.kind` says how to invert it. */
function recordUndo(spec, before) {
  if (!spec || !before) return;
  const after = headOf();
  const sameHead = before.oid === after.oid && before.branch === after.branch;
  const t = stacks();
  let e = null;
  const k = spec.kind;
  if (k === 'commit' && before.oid && !sameHead) {
    e = { undo: () => G('reset', { hash: before.oid, mode: 'soft' }), redo: () => G('reset', { hash: after.oid, mode: 'soft' }), expect: { undo: after, redo: before } };
  } else if (k === 'head' && before.oid && !sameHead) {
    const mode = spec.mode === 'soft' || spec.mode === 'mixed' ? 'soft' : 'hard';
    e = { undo: () => G('reset', { hash: before.oid, mode }), redo: () => G('reset', { hash: after.oid, mode }), expect: { undo: after, redo: before }, needsClean: mode === 'hard' };
  } else if (k === 'checkout' && !sameHead) {
    const go = (h) => (h.branch ? G('checkout', { ref: h.branch }) : G('checkoutCommit', { hash: h.oid }));
    e = { undo: () => go(before), redo: () => go(after), expect: { undo: after, redo: before } };
  } else if (k === 'branchCreate') {
    const sha = S.refs.local.find((b) => b.name === spec.name)?.oid;
    if (!sha) return;
    e = {
      undo: async () => { if (spec.checkout) await (before.branch ? G('checkout', { ref: before.branch }) : G('checkoutCommit', { hash: before.oid })); await G('deleteBranch', { name: spec.name, force: true }); },
      redo: () => G('createBranch', { name: spec.name, from: sha, checkout: spec.checkout }),
    };
  } else if (k === 'branchDelete' && spec.sha) {
    e = { undo: () => G('createBranch', { name: spec.name, from: spec.sha, checkout: false }), redo: () => G('deleteBranch', { name: spec.name, force: true }) };
  } else if (k === 'stash') {
    e = { undo: () => G('stashPop', {}), redo: () => G('stash', { message: spec.message || '' }) };
  }
  if (!e) return;
  t.undo.push({ ...e, label: spec.label });
  if (t.undo.length > 50) t.undo.shift();
  t.redo = [];
  renderUndo();
}
function renderUndo() {
  const t = S.tab?.kind === 'new' || !S.tab ? { undo: [], redo: [] } : stacks();
  const u = $('#tbUndo'), r = $('#tbRedo');
  if (!u) return;
  u.classList.toggle('off', !t.undo.length); r.classList.toggle('off', !t.redo.length);
  u.title = t.undo.length ? `Undo ${t.undo.at(-1).label} (⌘Z)` : 'Nothing to undo';
  r.title = t.redo.length ? `Redo ${t.redo.at(-1).label} (⇧⌘Z)` : 'Nothing to redo';
}
async function undoRedo(dir) {
  if (!S.info) return;
  const t = stacks();
  const from = dir === 'undo' ? t.undo : t.redo, to = dir === 'undo' ? t.redo : t.undo;
  const e = from.at(-1);
  if (!e) return hudInfo(dir === 'undo' ? 'Nothing to undo' : 'Nothing to redo', dir);
  const now = headOf();
  const exp = e.expect?.[dir];
  if (exp && (exp.oid !== now.oid || exp.branch !== now.branch)) { from.length = 0; renderUndo(); return hudInfo(`Can't ${dir} safely — the repository changed since`, 'alert'); }
  if (e.needsClean && S.status.files.length) return hudInfo(`Commit or stash your changes before ${dir === 'undo' ? 'undoing' : 'redoing'} “${e.label}”`, 'alert');
  if (S.status.state) return hudInfo(`Finish or abort the ${OP[S.status.state].noun} first`, 'alert');
  const ok = await act(dir === 'undo' ? 'Undo' : 'Redo', async () => { await e[dir](); return { summary: `${dir === 'undo' ? 'Undid' : 'Redid'} ${e.label}` }; },
    { button: dir === 'undo' ? $('#tbUndo') : $('#tbRedo'), hud: { title: `${dir === 'undo' ? 'Undoing' : 'Redoing'} ${e.label}`, icon: dir } });
  if (ok) { from.pop(); to.push(e); }
  renderUndo();
}

// ===================================================================== conflict center (right panel)
function renderOpPanel() {
  const d = $('#detail');
  const st = S.status;
  const meta = OP[st.state];
  const op = st.op || {};
  const t = S.tab;
  t.opMax = Math.max(t.opMax || 0, st.conflicts);
  const total = t.opMax, done = total - st.conflicts;
  const conflicted = st.files.filter((f) => f.conflict);
  const others = st.files.filter((f) => !f.conflict && (f.x !== ' ' && f.x !== '?'));
  const unstaged = st.files.filter((f) => !f.conflict && f.y !== ' ');
  const what = st.state === 'rebasing' ? `<code>${esc(op.current)}</code> onto <code>${esc(op.onto)}</code>`
    : st.state === 'merging' ? `<code>${esc(op.incoming)}</code> into <code>${esc(op.current)}</code>` : `<code>${esc(op.incoming)}</code>`;
  const msgBox = st.state === 'merging' ? `<label class="op-msg">Merge commit message<textarea class="field" id="opMsg" spellcheck="true">${esc(S.tab.opMsg ?? op.message ?? '')}</textarea></label>` : '';
  const allDone = st.conflicts === 0;
  d.dataset.view = 'op';
  d.innerHTML = `<div class="op-card ${allDone ? 'ready' : 'blocked'}">
      <div class="op-h"><span class="op-ic">${icon(meta.icon)}</span><div><b>${meta.verb} ${what}</b>
        <small>${st.state === 'rebasing' && op.total ? `Commit ${op.step} of ${op.total}${op.incoming ? ` · ${esc(op.incoming)}` : ''}` : st.state === 'cherry-picking' || st.state === 'reverting' ? esc(op.incoming || '') : 'Git paused to let you resolve conflicts'}</small></div></div>
      <div class="op-prog"><div class="op-bar"><i style="width:${total ? Math.round((done / total) * 100) : 100}%"></i></div>
        <span>${allDone ? `${icon('check')}All conflicts resolved` : `${done} of ${plural(total, 'conflicted file')} resolved`}</span></div>
    </div>
    ${conflicted.length ? `<div class="files-h"><span>${icon('alert')}Conflicts · ${conflicted.length}</span><span class="hint-k">click to resolve</span></div>
      <div class="files op-files">${conflicted.map((f) => `<div class="file conflict" data-resolve="${esc(f.path)}" title="${esc(f.path)}">
        <span class="st U">!</span><span class="fp">${pathHTML(f.path)}</span><span class="ckind">${esc(conflictLabel(f.ckind))}</span>
        <span class="acts"><button class="btn sm" data-side="ours" data-p="${esc(f.path)}" title="Keep the whole file from ${esc(sides(op).ours)}">Mine</button><button class="btn sm" data-side="theirs" data-p="${esc(f.path)}" title="Keep the whole file from ${esc(sides(op).theirs)}">Theirs</button></span><span class="go">${icon('right')}</span></div>`).join('')}</div>` : ''}
    ${others.length ? `<div class="files-h"><span>${icon('check')}Ready · ${others.length}</span></div>
      <div class="files">${others.map((f) => `<div class="file" data-path="${esc(f.path)}" data-mode="staged" data-st="${esc(f.x)}"><span class="st ${esc(f.x)}">${esc(f.x)}</span><span class="fp">${pathHTML(f.path)}</span></div>`).join('')}</div>` : ''}
    ${unstaged.length ? `<div class="files-h"><span>Unstaged · ${unstaged.length}</span><button class="btn sm" data-act="stageAll">Stage all</button></div>
      <div class="files">${unstaged.map((f) => `<div class="file" data-path="${esc(f.path)}" data-mode="unstaged" data-st="${esc(f.untracked ? '?' : f.y)}" ${f.untracked ? 'data-untracked="1"' : ''}><span class="st ${f.untracked ? 'A' : esc(f.y)}">${f.untracked ? 'A' : esc(f.y)}</span><span class="fp">${pathHTML(f.path)}</span></div>`).join('')}</div>` : ''}
    <div class="op-foot">
      ${msgBox}
      <button class="btn primary big ${allDone ? 'pulse' : ''}" id="opGo" ${allDone ? '' : 'disabled'}>${icon('check')}${allDone ? meta.go : `Resolve ${plural(st.conflicts, 'conflict')} to continue`}</button>
      <div class="op-alt">${st.state !== 'merging' ? `<button class="btn" id="opSkip" title="Drop this commit and go on">${icon('right')}Skip commit</button>` : ''}
        <button class="btn danger" id="opAbort">${icon('x')}Abort ${meta.noun}</button></div>
    </div>`;
  const msg = $('#opMsg');
  if (msg) msg.oninput = () => { S.tab.opMsg = msg.value; };
}
const conflictLabel = (k) => ({ UU: 'both modified', AA: 'both added', DU: 'deleted by us', UD: 'deleted by them', AU: 'added by us', UA: 'added by them', DD: 'both deleted' }[k] || 'conflict');

/** Operations started outside Nebula (terminal, editor) still get an undo entry when finished here. */
function ensurePendingUndo() {
  const t = S.tab, st = S.status;
  if (t.pendingUndo || !st.state) return;
  const before = st.state === 'rebasing'
    ? (st.op.origHead ? { oid: st.op.origHead, branch: st.op.current } : null)
    : { oid: st.oid, branch: st.branch };
  if (before) t.pendingUndo = { spec: { kind: 'head', label: `${OP[st.state].noun} of ${st.state === 'rebasing' ? st.op.current : (st.op.incoming || '').split(' ')[0]}`.trim() }, before };
}
async function opContinue() {
  ensurePendingUndo();
  const st = S.status;
  const r = await act(OP[st.state].go, () => G('continueOp', { message: S.tab.opMsg }), { button: $('#opGo'), hud: { title: OP[st.state].go, icon: OP[st.state].icon } });
  if (r && !r.conflicts) { finishOp(); }
}
function finishOp() {
  const t = S.tab;
  if (!S.status.state) {
    if (t.pendingUndo) recordUndo(t.pendingUndo.spec, t.pendingUndo.before);
    t.pendingUndo = null; t.opMax = 0; t.opMsg = null;
    $('#detail').dataset.view = '';
    S.sel = null;
    renderDetail();
  }
}
async function opAbort() {
  const meta = OP[S.status.state];
  if (!(await confirmDanger(`Abort the ${meta.noun}?`, 'Everything goes back to how it was before it started.', `Abort ${meta.noun}`))) return;
  const r = await act(`Abort ${meta.noun}`, async () => { await G('abort'); return { summary: `${meta.noun[0].toUpperCase() + meta.noun.slice(1)} aborted — back to where you were` }; }, { hud: { title: `Aborting ${meta.noun}`, icon: 'x' } });
  if (r) { S.tab.pendingUndo = null; S.tab.opMax = 0; S.tab.opMsg = null; $('#detail').dataset.view = ''; S.sel = null; renderDetail(); }
}
async function opSkip() {
  ensurePendingUndo();
  const r = await act('Skip', () => G('skipOp'), { hud: { title: 'Skipping this commit', icon: 'right' } });
  if (r && !r.conflicts) finishOp();
}

// ===================================================================== conflict resolver (center pane)
const RZ = { path: null, data: null, picks: [] };
async function openResolver(p) {
  closePopover();
  const v = $('#diffView');
  v.hidden = false;
  v.classList.add('resolver');
  $('#diffPath').textContent = p;
  $('#diffStatus').className = 'st U'; $('#diffStatus').textContent = '!';
  $('#diffMeta').textContent = 'resolve conflict';
  $('#diffBody').innerHTML = '<div class="diff-empty">Loading…</div>';
  $('#diffActions').innerHTML = '';
  let data;
  try { data = await G('conflictFile', { path: p }); } catch (e) { $('#diffBody').innerHTML = `<div class="diff-empty">${esc(e.message)}</div>`; return; }
  Object.assign(RZ, { path: p, data, picks: data.segments.filter((s) => s.type === 'conflict').map(() => null) });
  renderResolver();
}
function closeResolver() { $('#diffView').classList.remove('resolver'); RZ.path = null; closeDiff(); }

function renderResolver() {
  const { data } = RZ;
  const sd = sides(data.op);
  const n = RZ.picks.length, done = RZ.picks.filter(Boolean).length;
  const whole = `<button class="btn sm" data-whole="ours" title="${esc(sd.ours)}">${icon('check')}All mine</button><button class="btn sm" data-whole="theirs" title="${esc(sd.theirs)}">${icon('check')}All theirs</button>`;
  if (data.deleted || data.binary || !n) {
    const msg = data.binary ? 'This is a binary file — pick the version to keep.'
      : !data.hasOurs ? `It was deleted in “${esc(sd.ours)}” and changed in “${esc(sd.theirs)}”.`
      : !data.hasTheirs ? `It was changed in “${esc(sd.ours)}” and deleted in “${esc(sd.theirs)}”.`
      : 'No conflict markers left in this file.';
    $('#diffActions').innerHTML = `<button class="btn sm" data-open-editor>${icon('external')}Open in editor</button>`;
    $('#diffBody').innerHTML = `<div class="rz-whole"><div class="rz-whole-ic">${icon('alert')}</div><h3>${esc(RZ.path)}</h3><p>${msg}</p>
      <div class="rz-whole-btns">
        <button class="btn big ${data.hasOurs ? '' : 'danger'}" data-whole="ours">${data.hasOurs ? `${icon('check')}Keep ${esc(sd.ours)}` : `${icon('trash')}Delete the file`}</button>
        <button class="btn big ${data.hasTheirs ? '' : 'danger'}" data-whole="theirs">${data.hasTheirs ? `${icon('check')}Keep ${esc(sd.theirs)}` : `${icon('trash')}Delete the file`}</button>
        ${!data.binary && data.hasOurs && data.hasTheirs ? `<button class="btn big primary" data-mark-resolved>${icon('check')}Mark resolved</button>` : ''}
      </div></div>`;
    return;
  }
  $('#diffActions').innerHTML = `<span class="rz-count ${done === n ? 'ok' : ''}">${done}/${n} resolved</span>${whole}
    <button class="btn sm" data-open-editor title="Edit by hand, then Mark resolved">${icon('external')}Editor</button>
    <button class="btn sm primary" data-save-resolution ${done === n ? '' : 'disabled'}>${icon('check')}Save &amp; mark resolved</button>`;
  let bi = -1;
  const ctxLines = (lines, where) => {
    if (lines.length <= 8) return lines;
    return where === 'start' ? [null, ...lines.slice(-3)] : where === 'end' ? [...lines.slice(0, 3), null] : [...lines.slice(0, 3), null, ...lines.slice(-3)];
  };
  const code = (lines) => lines.map((l) => (l === null ? '<div class="rz-gap">⋯</div>' : `<div class="rz-l">${esc(l) || ' '}</div>`)).join('');
  const segs = data.segments;
  $('#diffBody').innerHTML = `<div class="rz">
    <div class="rz-legend"><span class="rz-key ours">${esc(sd.ours)}</span><span class="rz-key theirs">${esc(sd.theirs)}</span><span class="rz-tip">Pick a side for each block · keys <kbd>1</kbd> mine <kbd>2</kbd> theirs <kbd>3</kbd> both</span></div>
    ${segs.map((s, si) => {
      if (s.type === 'text') return `<div class="rz-text">${code(ctxLines(s.lines, si === 0 ? 'start' : si === segs.length - 1 ? 'end' : 'mid'))}</div>`;
      bi++;
      const pick = RZ.picks[bi];
      if (pick) {
        const lines = resolvedLines(s, pick);
        return `<div class="rz-block done" data-b="${bi}"><div class="rz-head">${icon('check')}<b>${pickLabel(pick, sd)}</b><button class="btn sm" data-undo-pick="${bi}">Change</button></div>
          <div class="rz-result">${code(lines.length ? lines : ['(empty)'])}</div></div>`;
      }
      return `<div class="rz-block" data-b="${bi}" tabindex="0">
        <div class="rz-head">${icon('alert')}<b>Conflict ${bi + 1} of ${n}</b><span class="rz-alt"><button class="btn sm" data-pick="both" data-b="${bi}">Use both</button><button class="btn sm" data-pick="both-rev" data-b="${bi}" title="Theirs first, then mine">Both, theirs first</button></span></div>
        <div class="rz-sides">
          <div class="rz-side ours"><div class="rz-label">${esc(sd.ours)}</div><div class="rz-code">${code(s.ours.length ? s.ours : ['(nothing)'])}</div>
            <button class="btn rz-take" data-pick="ours" data-b="${bi}">${icon('check')}Use mine <kbd>1</kbd></button></div>
          <div class="rz-side theirs"><div class="rz-label">${esc(sd.theirs)}</div><div class="rz-code">${code(s.theirs.length ? s.theirs : ['(nothing)'])}</div>
            <button class="btn rz-take" data-pick="theirs" data-b="${bi}">${icon('check')}Use theirs <kbd>2</kbd></button></div>
        </div></div>`;
    }).join('')}
  </div>`;
  focusNextBlock();
}
const pickLabel = (p, sd) => ({ ours: `Using ${sd.ours}`, theirs: `Using ${sd.theirs}`, both: 'Using both (mine first)', 'both-rev': 'Using both (theirs first)' }[p]);
const resolvedLines = (s, p) => (p === 'ours' ? s.ours : p === 'theirs' ? s.theirs : p === 'both' ? [...s.ours, ...s.theirs] : [...s.theirs, ...s.ours]);
function focusNextBlock() {
  const el = $('#diffBody .rz-block:not(.done)');
  if (el) { el.focus({ preventScroll: true }); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
}
function resolvedText() {
  const { data } = RZ;
  let bi = -1;
  const lines = data.segments.flatMap((s) => (s.type === 'text' ? s.lines : resolvedLines(s, RZ.picks[++bi])));
  return lines.join(data.eol) + (data.finalNewline ? data.eol : '');
}
async function afterResolved(p) {
  await reload();
  const left = S.status.files.filter((f) => f.conflict);
  if (left.length) { hudInfo(`${p} resolved — ${plural(left.length, 'conflict')} left`, 'check'); openResolver(left[0].path); }
  else { closeResolver(); hudInfo(`All conflicts resolved — ready to ${OP[S.status.state]?.noun || 'continue'}`, 'check'); }
}

// ===================================================================== interactive rebase
const IRB = { base: null, rows: [], drag: null };
const ACTIONS = [['pick', 'Pick'], ['reword', 'Reword'], ['squash', 'Squash'], ['drop', 'Drop']];

async function openInteractiveRebase(base, { preset } = {}) {
  if (S.status.state) return hudInfo(`Finish or abort the ${OP[S.status.state].noun} first`, 'alert');
  if (!S.status.branch) return hudInfo('Check out a branch first', 'alert');
  let plan;
  try { plan = await G('rebasePlan', { base }); } catch (e) { return toast('err', 'Interactive rebase unavailable', e.message); }
  if (!plan.length) return hudInfo('Nothing to rebase after this commit', 'branch');
  IRB.base = base;
  IRB.rows = plan.slice().reverse().map((c) => ({ ...c, action: preset?.[c.hash] || 'pick', msg: c.message }));
  IRB.pushed = S.status.upstream ? await G('compare', { a: S.status.upstream, b: 'HEAD' }).then((r) => r.behind > 0 || plan.length > r.ahead).catch(() => false) : false;
  renderIrb();
  $('#irbWrap').hidden = false;
}
function irbGroups() {
  // newest at top; a "squash" row folds into the next older kept row below it
  const kept = IRB.rows.filter((r) => r.action !== 'drop');
  const leaders = new Map();
  for (let i = kept.length - 1; i >= 0; i--) {
    const r = kept[i];
    if (r.action === 'squash') continue;
    const members = [];
    for (let j = i - 1; j >= 0 && kept[j].action === 'squash'; j--) members.push(kept[j]);
    leaders.set(r.hash, members);
  }
  return { kept, leaders };
}
function renderIrb() {
  const { kept, leaders } = irbGroups();
  const bottomKept = kept.at(-1);
  const invalid = bottomKept && bottomKept.action === 'squash';
  const resultCount = kept.filter((r) => r.action !== 'squash').length;
  $('#irb').innerHTML = `<header class="sheet-h"><h2>${icon('branch')}Interactive rebase <small>${esc(S.status.branch)} · ${plural(IRB.rows.length, 'commit')}</small></h2>
      <button class="icon-btn" data-irb-close title="Cancel (Esc)">${icon('x')}</button></header>
    <div class="irb-help">Newest on top. Drag rows to reorder · <kbd>P</kbd> pick · <kbd>R</kbd> reword · <kbd>S</kbd> squash into the commit below · <kbd>D</kbd> drop</div>
    <div class="irb-list">${IRB.rows.map((r, i) => {
      const members = leaders.get(r.hash);
      const showMsg = r.action === 'reword' || (members && members.length);
      return `<div class="irb-row a-${r.action}" draggable="true" data-i="${i}" tabindex="0">
        <span class="irb-grip">⋮⋮</span>
        <div class="seg irb-seg">${ACTIONS.map(([a, l]) => `<button class="${r.action === a ? 'on' : ''}" data-act-i="${i}" data-a="${a}">${l}</button>`).join('')}</div>
        ${avatar(r.author, r.email, r.avatar)}
        <div class="irb-main">${showMsg ? `<textarea class="field irb-msg" data-msg-i="${i}" rows="${Math.min(6, (r.msg.match(/\n/g) || []).length + 1)}">${esc(r.msg)}</textarea>` : `<b>${esc(r.subject)}</b>`}
          ${members?.length ? `<small>${icon('merge')}combines ${plural(members.length, 'commit')} from below</small>` : r.action === 'squash' ? `<small>${icon('merge')}folds into the commit below</small>` : ''}</div>
        <code>${short(r.hash)}</code></div>`;
    }).join('')}</div>
    <footer class="irb-foot">
      ${IRB.pushed ? `<span class="irb-warn">${icon('alert')}Some of these commits are already pushed — you'll need to force push.</span>` : '<span></span>'}
      <span class="irb-sum">${IRB.rows.length} → <b>${resultCount}</b> commit${resultCount === 1 ? '' : 's'}</span>
      <button class="btn" data-irb-close>Cancel</button>
      <button class="btn primary" id="irbGo" ${invalid || !resultCount ? 'disabled' : ''} title="${invalid ? 'The oldest commit has nothing below to squash into' : ''}">${icon('check')}Start rebase</button>
    </footer>`;
}
function irbSteps() {
  const { leaders } = irbGroups();
  // oldest first for git; leader messages combine their squashed members
  return IRB.rows.slice().reverse().map((r) => {
    const members = leaders.get(r.hash);
    if (r.action === 'squash') return { hash: r.hash, action: 'squash' };
    if (r.action === 'drop') return { hash: r.hash, action: 'drop' };
    const changed = r.msg.trim() !== r.message.trim();
    const message = members?.length || r.action === 'reword' || changed ? r.msg : undefined;
    return { hash: r.hash, action: message !== undefined && r.action === 'pick' && !members?.length ? 'reword' : r.action, ...(message !== undefined ? { message } : {}) };
  });
}
function irbSetAction(i, a) {
  const r = IRB.rows[i];
  r.action = a;
  if (a === 'squash') {
    // pre-fill the leader (next kept row below) with the combined message, git-style
    const below = IRB.rows.slice(i + 1).find((x) => x.action !== 'drop' && x.action !== 'squash');
    if (below && !below.msg.includes(r.message.split('\n')[0])) below.msg = `${below.msg.trim()}\n\n${r.message.trim()}`;
  }
  renderIrb();
}
async function irbStart() {
  const steps = irbSteps();
  const base = IRB.base;
  $('#irbWrap').hidden = true;
  await act('Interactive rebase', () => G('rebaseInteractive', { base, steps }),
    { hud: { title: 'Rewriting history', icon: 'branch' }, undo: { kind: 'head', label: 'interactive rebase' } });
}

// ===================================================================== multi-select (⌘-click)
S.multi = [];
function toggleMulti(hash) {
  const i = S.multi.indexOf(hash);
  if (i >= 0) S.multi.splice(i, 1); else S.multi.push(hash);
  if (S.sel?.type === 'commit' && !S.multi.includes(S.sel.id) && S.multi.length === 1) S.multi.unshift(S.sel.id);
  $$('#rows .row.multi').forEach((r) => r.classList.remove('multi'));
  S.multi.forEach((h) => $(`#rows .row[data-i="${S.byHash.get(h)}"]`)?.classList.add('multi'));
  if (S.multi.length >= 2) renderMultiPanel(); else { S.multi = []; renderDetail(); }
}
function clearMulti() { S.multi = []; $$('#rows .row.multi').forEach((r) => r.classList.remove('multi')); }
function firstParentChain() {
  const chain = [];
  let h = S.status.oid;
  const byHash = new Map(S.commits.map((c) => [c.hash, c]));
  while (h && byHash.has(h) && chain.length < 1000) { chain.push(h); h = byHash.get(h).parents[0]; }
  return chain;
}
function renderMultiPanel() {
  const sel = S.multi.map((h) => S.commits.find((c) => c.hash === h)).filter(Boolean).sort((a, b) => S.byHash.get(a.hash) - S.byHash.get(b.hash));
  const chain = firstParentChain();
  const idx = sel.map((c) => chain.indexOf(c.hash)).sort((a, b) => a - b);
  const contiguous = idx[0] >= 0 && idx.every((v, i) => i === 0 || v === idx[i - 1] + 1);
  const d = $('#detail');
  d.dataset.view = 'multi';
  d.innerHTML = `<div class="d-head"><div class="d-kicker">${icon('commit')} ${sel.length} commits selected</div>
      <div class="multi-list">${sel.map((c) => `<div class="multi-c">${avatar(c.author, c.email, c.avatar)}<span>${esc(c.subject)}</span><code>${short(c.hash)}</code></div>`).join('')}</div></div>
    <div class="d-actions col">
      ${sel.length === 2 ? `<button class="btn" data-multi="compare">${icon('commit')}Compare these 2 commits</button>` : ''}
      <button class="btn" data-multi="squash" ${contiguous && sel.length >= 2 && !S.status.state ? '' : 'disabled'} title="${contiguous ? '' : 'Select consecutive commits of the current branch'}">${icon('merge')}Squash into one commit</button>
      <button class="btn" data-multi="cherry">${icon('sparkle')}Cherry-pick ${sel.length} commits</button>
      <button class="btn" data-multi="clear">${icon('x')}Clear selection</button>
    </div>`;
  d._multi = { sel, chain, idx, contiguous };
}
async function multiAction(a) {
  const { sel, chain, idx } = $('#detail')._multi;
  if (a === 'clear') { clearMulti(); return renderDetail(); }
  if (a === 'compare') return showCompare(sel[1].hash, sel[0].hash, { direct: true, title: `${short(sel[1].hash)} → ${short(sel[0].hash)}` });
  if (a === 'cherry') {
    const ordered = sel.slice().reverse(); // oldest first
    clearMulti();
    return act('Cherry-pick', async () => {
      for (const c of ordered) { const r = await G('cherryPick', { hash: c.hash }); if (r.conflicts) return r; }
      return { summary: `Cherry-picked ${plural(ordered.length, 'commit')}` };
    }, { hud: { title: `Cherry-picking ${plural(ordered.length, 'commit')}`, icon: 'sparkle' }, undo: { kind: 'head', label: `cherry-pick of ${ordered.length} commits` } });
  }
  if (a === 'squash') {
    const oldest = chain[idx.at(-1)];
    const base = S.commits.find((c) => c.hash === oldest)?.parents[0] || null;
    const preset = {};
    idx.slice(0, -1).forEach((i) => { preset[chain[i]] = 'squash'; });
    clearMulti();
    return openInteractiveRebase(base, { preset });
  }
}

// ===================================================================== compare
async function showCompare(a, b, { direct, title } = {}) {
  const d = $('#detail');
  d.dataset.view = 'compare';
  d.innerHTML = '<div class="d-head"><p class="d-body">Comparing…</p></div>';
  let r;
  try { r = await G('compare', { a, b, direct }); } catch (e) { d.innerHTML = `<div class="d-head"><p class="d-body">${esc(e.message)}</p></div>`; return; }
  const adds = r.files.reduce((x, f) => x + (f.add || 0), 0), dels = r.files.reduce((x, f) => x + (f.del || 0), 0);
  d.innerHTML = `<div class="d-head"><div class="d-kicker">${icon('commit')} Compare</div><div class="d-title">${esc(title || `${a} … ${b}`)}</div>
      ${direct ? '' : `<div class="sha-line"><span class="pill green">${icon('up')}${r.ahead} ahead</span><span class="pill amber">${icon('chevron')}${r.behind} behind</span></div>`}</div>
    <div class="files-h"><span>${plural(r.files.length, 'file')} changed</span><span class="stats"><span class="add-c">+${adds}</span><span class="del-c">−${dels}</span></span></div>
    <div class="files">${r.files.map((f) => `<div class="file" data-cmp-a="${esc(a)}" data-cmp-b="${esc(b)}" data-cmp-direct="${direct ? 1 : ''}" data-path="${esc(f.path)}" data-st="${esc(f.status)}"><span class="st ${esc(f.status)}">${esc(f.status)}</span><span class="fp">${pathHTML(f.path)}</span></div>`).join('') || '<div class="wip-empty">No differences.</div>'}</div>`;
}

// ===================================================================== partial staging in the diff view
let DS = null; // { ctx, header, hunks: [{head, lines:[{t, s}]}], sel: Set("h:l") }
function parsePatch(text) {
  const i = text.indexOf('\n@@');
  if (i < 0 && !text.startsWith('@@')) return null;
  const header = text.startsWith('@@') ? '' : text.slice(0, i + 1);
  const body = text.startsWith('@@') ? text : text.slice(i + 1);
  const hunks = body.split(/(?=^@@ )/m).filter(Boolean).map((h) => {
    const [head, ...rest] = h.replace(/\n$/, '').split('\n');
    return { head, lines: rest.map((l) => ({ t: l[0] || ' ', s: l.slice(1) })) };
  });
  return { header, hunks };
}
/** Build a patch for some lines of one hunk. reverse=true for unstage/discard (applied with --reverse). */
function buildPatch(header, hunk, pickLine, reverse) {
  const out = [];
  let lastKept = true;
  hunk.lines.forEach((l, li) => {
    if (l.t === '\\') { if (lastKept) out.push('\\' + l.s); return; }
    const chosen = l.t === ' ' || pickLine(li);
    if (l.t === ' ' || chosen) { out.push(l.t + l.s); lastKept = true; return; }
    // unselected change: for forward apply, '-' stays as context and '+' is dropped; reversed: the opposite
    if ((l.t === '-' && !reverse) || (l.t === '+' && reverse)) { out.push(' ' + l.s); lastKept = true; } else lastKept = false;
  });
  return `${header}${hunk.head}\n${out.join('\n')}\n`;
}
function renderDiffInteractive(text, ctx) {
  const p = parsePatch(text);
  if (!p || ctx.untracked || !['unstaged', 'staged'].includes(ctx.mode) || /^Binary files/m.test(text)) return null;
  DS = { ctx, ...p, sel: new Set() };
  return p.hunks.map((h, hi) => {
    const m = h.head.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
    let o = +m[1], n = +m[2];
    const acts = ctx.mode === 'unstaged'
      ? `<button class="btn sm" data-hunk="discard" data-h="${hi}">${icon('trash')}Discard hunk</button><button class="btn sm" data-hunk="stage" data-h="${hi}">${icon('plus')}Stage hunk</button>`
      : `<button class="btn sm" data-hunk="unstage" data-h="${hi}">${icon('minus')}Unstage hunk</button>`;
    return `<div class="hunk"><div class="hunk-h"><span>${esc(h.head)}</span><span class="hunk-acts">${acts}</span></div>${h.lines.map((l, li) => {
      if (l.t === '+') return `<div class="dl add sel-able" data-h="${hi}" data-l="${li}"><span class="n"></span><span class="n">${n++}</span><span class="c">${esc(l.s) || ' '}</span></div>`;
      if (l.t === '-') return `<div class="dl del sel-able" data-h="${hi}" data-l="${li}"><span class="n">${o++}</span><span class="n"></span><span class="c">${esc(l.s) || ' '}</span></div>`;
      if (l.t === '\\') return `<div class="dl"><span class="n"></span><span class="n"></span><span class="c" style="color:var(--text-3)">\\${esc(l.s)}</span></div>`;
      return `<div class="dl"><span class="n">${o++}</span><span class="n">${n++}</span><span class="c">${esc(l.s) || ' '}</span></div>`;
    }).join('')}</div>`;
  }).join('');
}
function renderLineBar() {
  let bar = $('#lineBar');
  if (!DS || !DS.sel.size) { bar?.remove(); return; }
  if (!bar) { bar = document.createElement('div'); bar.id = 'lineBar'; bar.className = 'line-bar'; $('#diffView').append(bar); }
  const n = DS.sel.size;
  bar.innerHTML = `<span>${plural(n, 'line')} selected</span>${DS.ctx.mode === 'unstaged'
    ? `<button class="btn sm danger" data-lines="discard">${icon('trash')}Discard lines</button><button class="btn sm primary" data-lines="stage">${icon('plus')}Stage lines</button>`
    : `<button class="btn sm primary" data-lines="unstage">${icon('minus')}Unstage lines</button>`}<button class="icon-btn" data-lines="clear">${icon('x')}</button>`;
}
async function applyPart(op, hunkIndex, lineFilter) {
  const reverse = op !== 'stage';
  const hunks = hunkIndex != null ? [hunkIndex] : [...new Set([...DS.sel].map((k) => +k.split(':')[0]))];
  if (op === 'discard' && !(await confirmDanger(`Discard ${hunkIndex != null ? 'this hunk' : plural(DS.sel.size, 'selected line')}?`, 'These changes in your working copy will be lost.', 'Discard'))) return;
  const ctx = DS.ctx;
  const ok = await act({ stage: 'Stage', unstage: 'Unstage', discard: 'Discard' }[op], async () => {
    for (const hi of hunks) {
      const patch = buildPatch(DS.header, DS.hunks[hi], (li) => (lineFilter ? DS.sel.has(`${hi}:${li}`) : true), reverse);
      await G('applyPatch', { patch, cached: op !== 'discard', reverse });
    }
  }, { quiet: true });
  if (ok) openDiff({ ...ctx });
}

// ===================================================================== file history & blame
async function showHistory(p) {
  const v = $('#diffView');
  v.hidden = false; v.classList.add('history');
  $('#diffPath').textContent = p;
  $('#diffStatus').className = 'st M'; $('#diffStatus').innerHTML = icon('clock');
  $('#diffMeta').textContent = 'file history';
  $('#diffActions').innerHTML = `<button class="btn sm" data-blame="${esc(p)}">Blame</button>`;
  $('#diffBody').innerHTML = '<div class="diff-empty">Loading history…</div>';
  let list;
  try { list = await G('fileHistory', { path: p }); } catch (e) { $('#diffBody').innerHTML = `<div class="diff-empty">${esc(e.message)}</div>`; return; }
  $('#diffBody').innerHTML = `<div class="hist"><div class="hist-list">${list.map((c, i) => `<div class="hist-c ${i === 0 ? 'on' : ''}" data-hist="${c.hash}" data-hp="${esc(c.path)}">
      ${avatar(c.author, c.email, c.avatar)}<span class="lp-t"><b>${esc(c.subject)}</b><small>${esc(c.author)} · ${ago(c.time)}${c.path !== p ? ` · ${esc(c.path)}` : ''}</small></span><code>${short(c.hash)}</code></div>`).join('')}</div>
    <div class="hist-diff" id="histDiff"></div></div>`;
  if (list[0]) loadHistDiff(list[0].hash, list[0].path);
}
async function loadHistDiff(h, p) {
  $$('.hist-c').forEach((x) => x.classList.toggle('on', x.dataset.hist === h));
  const el = $('#histDiff');
  el.innerHTML = '<div class="diff-empty">Loading…</div>';
  try { el.innerHTML = renderDiff(await G('diff', { path: p, mode: 'commit', hash: h })); } catch (e) { el.innerHTML = `<div class="diff-empty">${esc(e.message)}</div>`; }
}
async function showBlame(p) {
  const v = $('#diffView');
  v.hidden = false; v.classList.add('history');
  $('#diffPath').textContent = p;
  $('#diffStatus').className = 'st M'; $('#diffStatus').innerHTML = icon('user');
  $('#diffMeta').textContent = 'blame';
  $('#diffActions').innerHTML = `<button class="btn sm" data-history="${esc(p)}">History</button>`;
  $('#diffBody').innerHTML = '<div class="diff-empty">Loading blame…</div>';
  let b;
  try { b = await G('blame', { path: p }); } catch (e) { $('#diffBody').innerHTML = `<div class="diff-empty">${esc(e.message)}</div>`; return; }
  const times = Object.values(b.commits).map((c) => c.time);
  const min = Math.min(...times), max = Math.max(...times);
  let prev = null;
  $('#diffBody').innerHTML = `<div class="blame">${b.lines.map((l) => {
    const c = b.commits[l.hash];
    const first = l.hash !== prev; prev = l.hash;
    const heat = max === min ? 1 : (c.time - min) / (max - min);
    return `<div class="bl ${first ? 'first' : ''}" style="--heat:${heat.toFixed(2)}" data-bl="${l.hash}">
      <span class="bl-who" title="${esc(c.summary)}\n${esc(c.author)} · ${esc(fullDate(c.time))}">${first ? `${avatar(c.author, c.email, c.avatar)}<b>${esc(c.author)}</b><small>${ago(c.time)}</small>` : ''}</span>
      <span class="n">${l.n}</span><span class="c">${esc(l.text) || ' '}</span></div>`;
  }).join('')}</div>`;
}

// ===================================================================== drag a branch onto another
let DND = null;
function bindDnd() {
  document.addEventListener('dragstart', (e) => {
    const el = e.target.closest?.('[data-dnd-name]');
    if (!el) return;
    DND = { kind: el.dataset.dndKind, name: el.dataset.dndName };
    e.dataTransfer.setData('text/x-nebula-ref', DND.name);
    e.dataTransfer.effectAllowed = 'move';
    document.body.classList.add('dnd-ref');
  });
  document.addEventListener('dragend', () => { DND = null; document.body.classList.remove('dnd-ref'); $$('.dnd-over').forEach((x) => x.classList.remove('dnd-over')); });
  document.addEventListener('dragover', (e) => {
    if (!DND) return;
    const el = e.target.closest?.('[data-dnd-name]');
    $$('.dnd-over').forEach((x) => x !== el && x.classList.remove('dnd-over'));
    if (el && el.dataset.dndName !== DND.name) { e.preventDefault(); el.classList.add('dnd-over'); }
  });
  document.addEventListener('drop', (e) => {
    if (!DND) return;
    const el = e.target.closest?.('[data-dnd-name]');
    const src = DND;
    DND = null; document.body.classList.remove('dnd-ref');
    if (!el || el.dataset.dndName === src.name) return;
    e.preventDefault(); e.stopPropagation();
    el.classList.remove('dnd-over');
    dropMenu(el, src, { kind: el.dataset.dndKind, name: el.dataset.dndName });
  }, true);
}
function dropMenu(anchor, src, dst) {
  const cur = S.status.branch;
  const localName = (r) => (r.kind === 'remote' ? r.name.split('/').slice(1).join('/') : r.name);
  const items = [];
  if (dst.kind === 'local') items.push(['merge', `Merge ${src.name} into ${dst.name}`, dst.name === cur ? 'Creates a merge commit if needed' : `Checks out ${dst.name} first`, 'merge']);
  if (src.kind === 'local') items.push(['rebase', `Rebase ${src.name} onto ${dst.name}`, src.name === cur ? 'Replays your commits on top' : `Checks out ${src.name} first`, 'branch']);
  if (dst.kind === 'local') items.push(['ff', `Fast-forward ${dst.name} to ${src.name}`, 'Only if no history would be lost', 'up']);
  if (S.tab?.provider !== 'git') items.push(['pr', `Pull request: ${localName(src)} → ${localName(dst)}`, 'Opens the pull request form', 'pr']);
  const html = `<div class="pop-h">${icon('branch')}<code>${esc(src.name)}</code> → <code>${esc(dst.name)}</code></div>
    ${items.map(([id, label, desc, ic]) => `<button class="pop-i" data-pick="${id}"><span class="pop-ic">${icon(ic)}</span><span class="pop-t"><b>${esc(label)}</b><small>${esc(desc)}</small></span></button>`).join('')}`;
  showPopover(anchor, html, async (id) => {
    if (S.status.state) return hudInfo(`Finish or abort the ${OP[S.status.state].noun} first`, 'alert');
    if (id === 'merge') {
      await act('Merge', async () => {
        if (dst.name !== cur) await G('checkout', { ref: dst.name });
        return G('merge', { ref: src.name });
      }, { hud: { title: `Merging ${src.name} into ${dst.name}`, icon: 'merge' }, undo: { kind: 'head', label: `merge of ${src.name}` } });
    } else if (id === 'rebase') {
      await act('Rebase', async () => {
        if (src.name !== cur) await G('checkout', { ref: src.name });
        return G('rebase', { ref: dst.name });
      }, { hud: { title: `Rebasing ${src.name} onto ${dst.name}`, icon: 'branch' }, undo: { kind: 'head', label: `rebase onto ${dst.name}` } });
    } else if (id === 'ff') {
      await act('Fast-forward', () => G('fastForward', { branch: dst.name, to: src.name }), { hud: { title: `Fast-forwarding ${dst.name}`, icon: 'up' }, undo: dst.name === cur ? { kind: 'head', label: `fast-forward of ${dst.name}` } : null });
    } else if (id === 'pr') createPR({ head: localName(src), base: localName(dst) });
  }, { width: 340 });
}

// ===================================================================== extras: remotes, worktrees, submodules, LFS
async function loadExtras() {
  if (!S.info) return;
  const tab = S.tab;
  const [remotes, worktrees, submodules, lfs] = await Promise.all([G('remotes'), G('worktrees'), G('submodules'), G('lfsInfo')].map((p) => p.catch(() => null)));
  if (tab !== S.tab) return;
  S.extras = { remotes: remotes || [], worktrees: worktrees || [], submodules: submodules || [], lfs: lfs || { used: false } };
  renderSidebar();
}
function extraSections(section) {
  const x = S.extras;
  if (!x) return '';
  const wt = x.worktrees.filter((w) => !w.main);
  let html = section('worktrees', 'Worktrees', wt.length, wt.map((w) => `<div class="item" data-kind="worktree" data-path="${esc(w.path)}" title="${esc(w.path)}">${icon('folder')}<span class="nm">${esc(w.path.split('/').pop())}</span><span class="ab">${esc(w.branch || 'detached')}</span></div>`).join('') || '<div class="side-note">Check out several branches side by side.</div>', 'worktree');
  if (x.submodules.length) html += section('submodules', 'Submodules', x.submodules.length, x.submodules.map((m) => `<div class="item" data-kind="submodule" data-path="${esc(m.path)}" title="${esc(m.describe)}">${icon('commit')}<span class="nm">${esc(m.path)}</span><span class="ab">${m.state === 'ok' ? '' : `<b class="dn">${esc(m.state)}</b>`}</span></div>`).join(''), 'submodule');
  if (x.lfs.used) html += `<div class="side-note lfs">${icon('stash')}Git LFS ${x.lfs.installed ? 'enabled — “Pull LFS files” is in the Pull menu' : 'is used here but not installed: <code>brew install git-lfs</code>'}</div>`;
  return html;
}
async function remoteMenu(name) {
  const r = S.extras?.remotes.find((x) => x.name === name);
  const id = await api.menu([{ id: 'fetch', label: `Fetch ${name}` }, { id: 'url', label: 'Edit URL…' }, { id: 'rename', label: 'Rename…' }, { type: 'separator' }, { id: 'remove', label: `Remove ${name}` }]);
  if (id === 'fetch') act('Fetch', () => G('fetchRemote', { name }), { hud: { title: `Fetching ${name}`, icon: 'fetch' } });
  else if (id === 'url') { const v = await modal({ title: `Edit ${name}`, iconName: 'cloud', ok: 'Save', fields: [{ name: 'url', label: 'URL', value: r?.fetch || '' }] }); if (v?.url) act('Remote updated', () => G('setRemoteUrl', { name, url: v.url })).then(loadExtras); }
  else if (id === 'rename') { const v = await modal({ title: `Rename ${name}`, iconName: 'cloud', ok: 'Rename', fields: [{ name: 'to', label: 'New name', value: name }] }); if (v?.to && v.to !== name) act('Remote renamed', () => G('renameRemote', { name, to: v.to })).then(loadExtras); }
  else if (id === 'remove') { if (await confirmDanger(`Remove the remote ${name}?`, 'Its remote-tracking branches are deleted locally. Nothing changes on the server.', 'Remove')) act('Remote removed', () => G('removeRemote', { name })).then(loadExtras); }
}
async function addRemote() {
  const v = await modal({ title: 'Add remote', iconName: 'cloud', ok: 'Add remote', fields: [{ name: 'name', label: 'Name', value: S.extras?.remotes.length ? 'upstream' : 'origin' }, { name: 'url', label: 'URL', placeholder: 'git@github.com:owner/repo.git' }] });
  if (v?.name && v.url) { await act(`Added ${v.name}`, () => G('addRemote', v)); loadExtras(); }
}
async function addWorktree() {
  const v = await modal({ title: 'New worktree', iconName: 'folder', text: 'Check out another branch in its own folder — no stashing needed.', ok: 'Choose folder…',
    fields: [{ name: 'branch', label: 'Existing branch (or leave empty)', placeholder: S.refs.local.find((b) => !b.current)?.name || '' }, { name: 'newBranch', label: 'or new branch name', placeholder: 'feature/side-quest' }] });
  if (!v || (!v.branch && !v.newBranch)) return;
  const parent = await api.pickFolder({ title: 'Where should the worktree folder go?' });
  if (!parent) return;
  const folder = `${parent}/${(v.newBranch || v.branch).replace(/[^A-Za-z0-9._-]+/g, '-')}`;
  const ok = await act('Worktree', async () => { await G('addWorktree', { path: folder, branch: v.branch || undefined, newBranch: v.newBranch || undefined }); return { summary: `Worktree ready at ${folder}` }; }, { hud: { title: 'Creating worktree', icon: 'folder' } });
  if (ok) { await loadExtras(); openTab(folder, { activate: false }); }
}

// ===================================================================== wiring
function bindPower() {
  // conflict center + resolver
  document.addEventListener('click', async (e) => {
    const t = e.target.closest('button, [data-resolve], [data-hist], [data-bl], .file[data-cmp-a], [data-multi]');
    if (!t) return;
    const d = t.dataset;
    if (t.id === 'opGo') return opContinue();
    if (t.id === 'opAbort') return opAbort();
    if (t.id === 'opSkip') return opSkip();
    if (d.side && d.p) { e.stopPropagation(); return act('Resolve', async () => { await G('resolveFile', { path: d.p, side: d.side }); return { summary: `${d.p}: kept ${d.side === 'ours' ? 'mine' : 'theirs'}` }; }, { quiet: true }).then(() => (S.status.conflicts ? null : hudInfo('All conflicts resolved', 'check'))); }
    if (d.resolve) return openResolver(d.resolve);
    if (d.multi) return multiAction(d.multi);
    if (d.hist) return loadHistDiff(d.hist, d.hp);
    if (d.bl) { closeDiff(); return selectHash(d.bl); }
    if (d.cmpA) return openDiff({ path: d.path, mode: 'compare', a: d.cmpA, b: d.cmpB, direct: !!d.cmpDirect, st: d.st, hash: `${d.cmpA}..${d.cmpB}` });
    if (d.history) return showHistory(d.history);
    if (d.blame) return showBlame(d.blame);
    if (!t.closest('#diffView') && !t.closest('#irb')) return;
    // resolver
    if (d.pick && d.b != null && RZ.path) { RZ.picks[+d.b] = d.pick; return renderResolver(); }
    if (d.undoPick != null && RZ.path) { RZ.picks[+d.undoPick] = null; return renderResolver(); }
    if (d.whole && RZ.path) { const p = RZ.path; const ok = await act('Resolve', () => G('resolveFile', { path: p, side: d.whole }), { quiet: true, refresh: false }); if (ok) afterResolved(p); return; }
    if ('saveResolution' in d && RZ.path) { const p = RZ.path; const ok = await act('Resolve', () => G('saveResolution', { path: p, content: resolvedText() }), { quiet: true, refresh: false }); if (ok) afterResolved(p); return; }
    if ('markResolved' in d && RZ.path) { const p = RZ.path; const ok = await act('Resolve', () => G('markResolved', { path: p }), { quiet: true, refresh: false }); if (ok) afterResolved(p); return; }
    if ('openEditor' in d && RZ.path) return api.openFile(S.tab.path, RZ.path);
    // partial staging
    if (d.hunk) return applyPart(d.hunk, +d.h, false);
    if (d.lines === 'clear') { DS.sel.clear(); $$('.dl.picked').forEach((x) => x.classList.remove('picked')); return renderLineBar(); }
    if (d.lines) return applyPart(d.lines, null, true);
    // interactive rebase
    if ('irbClose' in d) { $('#irbWrap').hidden = true; return; }
    if (t.id === 'irbGo') return irbStart();
    if (d.actI != null) return irbSetAction(+d.actI, d.a);
  });
  // line selection (click / shift-click a range)
  let lastLine = null;
  $('#diffBody').addEventListener('click', (e) => {
    const l = e.target.closest('.dl.sel-able');
    if (!l || !DS) return;
    const key = `${l.dataset.h}:${l.dataset.l}`;
    if (e.shiftKey && lastLine && lastLine.h === l.dataset.h) {
      const [a, b] = [+lastLine.l, +l.dataset.l].sort((x, y) => x - y);
      for (let i = a; i <= b; i++) { const el = $(`.dl.sel-able[data-h="${l.dataset.h}"][data-l="${i}"]`); if (el) { DS.sel.add(`${l.dataset.h}:${i}`); el.classList.add('picked'); } }
    } else if (DS.sel.has(key)) { DS.sel.delete(key); l.classList.remove('picked'); } else { DS.sel.add(key); l.classList.add('picked'); }
    lastLine = { h: l.dataset.h, l: l.dataset.l };
    renderLineBar();
  });
  // keyboard: resolver 1/2/3, ⌘S; irb P/R/S/D; undo/redo
  document.addEventListener('keydown', (e) => {
    const inField = e.target.closest?.('input, textarea');
    if (!$('#irbWrap').hidden) {
      if (e.key === 'Escape') { $('#irbWrap').hidden = true; return; }
      const row = e.target.closest?.('.irb-row');
      const map = { p: 'pick', r: 'reword', s: 'squash', d: 'drop' };
      if (row && !inField && map[e.key.toLowerCase()]) { e.preventDefault(); irbSetAction(+row.dataset.i, map[e.key.toLowerCase()]); $(`.irb-row[data-i="${row.dataset.i}"]`)?.focus(); }
      return;
    }
    if (RZ.path && !$('#diffView').hidden && !inField) {
      const blk = $('#diffBody .rz-block:not(.done)');
      const k = { 1: 'ours', 2: 'theirs', 3: 'both' }[e.key];
      if (k && blk) { e.preventDefault(); RZ.picks[+blk.dataset.b] = k; return renderResolver(); }
      if (e.key === 's' && e.metaKey) { e.preventDefault(); $('[data-save-resolution]:not([disabled])')?.click(); }
      if (e.key === 'Escape') { e.stopPropagation(); closeResolver(); }
    }
  }, true);
  // irb inline message edits + drag to reorder
  document.addEventListener('input', (e) => { const i = e.target.dataset?.msgI; if (i != null) IRB.rows[+i].msg = e.target.value; });
  $('#irb').addEventListener('dragstart', (e) => { const r = e.target.closest('.irb-row'); if (r) { IRB.drag = +r.dataset.i; r.classList.add('dragging'); } });
  $('#irb').addEventListener('dragover', (e) => { if (IRB.drag != null && e.target.closest('.irb-row')) e.preventDefault(); });
  $('#irb').addEventListener('drop', (e) => {
    const r = e.target.closest('.irb-row');
    if (IRB.drag == null || !r) return;
    e.preventDefault();
    const [moved] = IRB.rows.splice(IRB.drag, 1);
    IRB.rows.splice(+r.dataset.i, 0, moved);
    IRB.drag = null; renderIrb();
  });
  $('#irb').addEventListener('dragend', () => { IRB.drag = null; $$('.irb-row.dragging').forEach((x) => x.classList.remove('dragging')); });
  // file context menu (history, blame, open, reveal)
  $('#detail').addEventListener('contextmenu', async (e) => {
    const f = e.target.closest('.file');
    if (!f) return;
    e.preventDefault();
    const p = f.dataset.path || f.dataset.resolve;
    const id = await api.menu([
      { id: 'history', label: 'File history' }, { id: 'blame', label: 'Blame', enabled: f.dataset.st !== 'D' && f.dataset.st !== '?' },
      { type: 'separator' }, { id: 'open', label: 'Open file' }, { id: 'reveal', label: 'Reveal in Finder' }, { id: 'copy', label: 'Copy path' },
    ]);
    if (id === 'history') showHistory(p);
    else if (id === 'blame') showBlame(p);
    else if (id === 'open') api.openFile(S.tab.path, p);
    else if (id === 'reveal') api.revealFile(S.tab.path, p);
    else if (id === 'copy') { api.copy(p); toast('ok', 'Path copied', p); }
  });
  bindDnd();
}
bindPower();
