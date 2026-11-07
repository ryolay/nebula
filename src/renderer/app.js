const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const api = window.nebula;
// Every git call names the repository of the active tab (main process validates it is open).
const G = (name, args) => api.git(name, args, S.tab?.path);

const ROW_H = 36, LANE_W = 22, PAD = 12, REFS_W = 200, ROW_MARGIN = 6;

const S = {
  info: null, commits: [], list: [], layout: null, byHash: new Map(),
  status: null, refs: { local: [], remote: [], tags: [] }, stashes: [], prs: { available: false, items: [] },
  sel: null, limit: 600, query: '', sideQuery: '', draft: { summary: '', body: '', amend: false },
  collapsed: { tags: true, worktrees: true, ...JSON.parse(localStorage.getItem('collapsed') || '{}') },
  statusSig: '', busy: 0, tabs: [], tab: null, matches: [], matchIdx: -1,
};

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (h) => (h || '').slice(0, 7);
function hashColor(str) {
  let h = 0; for (const ch of str || '') h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 70% 55%)`;
}
function initials(name) {
  const p = (name || '?').trim().split(/[\s._-]+/).filter(Boolean);
  return ((p[0]?.[0] || '?') + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
}
function avatar(name, email, url, cls = '') {
  return `<span class="av ${cls}" style="--c:${hashColor(email || name)}">${esc(initials(name))}${url ? `<img src="${esc(url)}" loading="lazy" alt="">` : ''}</span>`;
}
function ago(t) {
  const s = Date.now() / 1000 - t;
  if (s < 60) return 'just now';
  const units = [[60, 'min'], [3600, 'h'], [86400, 'd'], [604800, 'w'], [2629800, 'mo'], [31557600, 'y']];
  let out = '';
  for (let i = units.length - 1; i >= 0; i--) if (s >= units[i][0]) { out = `${Math.floor(s / units[i][0])}${units[i][1]} ago`; break; }
  return out;
}
const fullDate = (t) => new Date(t * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
function splitPath(p) { const i = p.lastIndexOf('/'); return i === -1 ? ['', p] : [p.slice(0, i + 1), p.slice(i + 1)]; }
// rtl trick keeps the filename visible when truncating; the bdi keeps punctuation in order.
const pathHTML = (p) => { const [d, f] = splitPath(p); return `<bdi><span>${esc(d)}</span><b>${esc(f)}</b></bdi>`; };
document.addEventListener('error', (e) => { if (e.target.tagName === 'IMG') e.target.remove(); }, true);

function busy(d) {
  S.busy += d;
  $('#busy').classList.toggle('on', S.busy > 0);
}
function toast(kind, title, detail) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `${icon(kind === 'ok' ? 'check' : 'alert')}<div><b>${esc(title)}</b>${detail ? `<pre>${esc(detail)}</pre>` : ''}</div>`;
  $('#toasts').append(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 260); }, kind === 'err' ? 8000 : 3200);
}
async function act(label, fn, { refresh = true, quiet = false, button, hud, undo } = {}) {
  busy(1);
  const before = S.status ? { oid: S.status.oid, branch: S.status.branch } : null;
  button?.classList.remove('done', 'failed');
  button?.classList.add('running');
  const h = hud ? hudStart(hud, button) : null;
  try {
    const r = await fn();
    const summary = r && typeof r === 'object' && r.summary ? r.summary : null;
    const out = typeof r === 'string' ? r.trim().split('\n').slice(-4).join('\n') : '';
    if (h) hudDone(h, summary || label);
    else if (!quiet) toast('ok', summary || label, summary ? '' : out.length < 400 ? out : '');
    button?.classList.add('done');
    if (refresh) await reload();
    if (r && typeof r === 'object' && r.conflicts) {
      // stopped on conflicts: the undo entry is recorded once the operation is completed
      if (S.tab) { S.tab.pendingUndo = undo ? { spec: typeof undo === 'function' ? undo(r) : undo, before } : null; S.sel = { type: 'wip' }; renderDetail(); }
    } else if (undo && refresh) recordUndo(typeof undo === 'function' ? undo(r) : undo, before);
    return r == null || r === "" ? true : r; // git often prints nothing on success
  } catch (e) {
    if (h) hudFail(h, `${label} failed`, e.message);
    toast('err', `${label} failed`, e.message);
    button?.classList.add('failed');
    if (refresh) await reload().catch(() => {});
    return null;
  } finally {
    busy(-1);
    button?.classList.remove('running');
    if (button) setTimeout(() => button.classList.remove('done', 'failed'), 1600);
  }
}
const confirmDanger = (message, detail, ok) => api.confirm({ message, detail, ok, danger: true });

// ---------- modal ----------
function modal({ title, iconName = 'sparkle', text, fields = [], ok = 'OK' }) {
  return new Promise((resolve) => {
    const wrap = $('#modalWrap'), m = $('#modal');
    m.innerHTML = `<h2>${icon(iconName)}${esc(title)}</h2>${text ? `<p>${esc(text)}</p>` : ''}
      <form class="fields">${fields.map((f) => f.type === 'checkbox'
        ? `<label class="check"><input type="checkbox" name="${f.name}" ${f.value ? 'checked' : ''}> ${esc(f.label)}</label>`
        : `<label>${esc(f.label)}${f.type === 'textarea'
          ? `<textarea class="field" name="${f.name}" placeholder="${esc(f.placeholder || '')}">${esc(f.value || '')}</textarea>`
          : `<input class="field" name="${f.name}" value="${esc(f.value || '')}" placeholder="${esc(f.placeholder || '')}" spellcheck="false">`}</label>`).join('')}
      <div class="row-btns"><button type="button" class="btn" data-x>Cancel</button><button class="btn primary">${esc(ok)}</button></div></form>`;
    wrap.hidden = false;
    const form = $('form', m);
    const done = (v) => { wrap.hidden = true; document.removeEventListener('keydown', onKey, true); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } };
    document.addEventListener('keydown', onKey, true);
    $('[data-x]', m).onclick = () => done(null);
    wrap.onclick = (e) => { if (e.target === wrap) done(null); };
    form.onsubmit = (e) => {
      e.preventDefault();
      const v = {};
      fields.forEach((f) => { const el = form.elements[f.name]; v[f.name] = f.type === 'checkbox' ? el.checked : el.value.trim(); });
      done(v);
    };
    form.querySelectorAll('textarea').forEach((t) => t.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.metaKey) form.requestSubmit(); }));
    setTimeout(() => form.querySelector('input.field, textarea')?.focus(), 30);
  });
}

// ---------- data loading ----------
// Never rebuild the UI while a mouse button is held: the element under the cursor would be replaced
// between mousedown and mouseup and the click would be lost (e.g. the first click after switching apps).
let pointerIsDown = false;
const afterPointerUp = [];
document.addEventListener('pointerdown', () => { pointerIsDown = true; }, true);
document.addEventListener('pointerup', () => {
  pointerIsDown = false;
  const fns = afterPointerUp.splice(0);
  if (fns.length) setTimeout(() => fns.forEach((f) => f()), 0); // after the click event has been dispatched
}, true);
const whenPointerUp = () => (pointerIsDown ? new Promise((r) => afterPointerUp.push(r)) : Promise.resolve());
const dataSig = (d) => JSON.stringify([d.commits.map((c) => c.hash + c.refs.map((r) => r.name).join()), d.status, d.refs, d.stashes.map((x) => x.hash)]);

/** soft: only redraw if something actually changed (window focus, background refresh). */
async function reload({ soft = false } = {}) {
  if (!S.info || !S.tab) { renderEmpty(); return; }
  const tab = S.tab;
  const [commits, status, refs, stashes] = await Promise.all([
    G('log', { limit: S.limit }), G('status'), G('refs'), G('stashes'),
  ]);
  if (tab !== S.tab) return; // the user switched tabs meanwhile
  const nextSig = dataSig({ commits, status, refs, stashes });
  if (soft && nextSig === tab.dataSig) return; // nothing changed: keep the DOM (and the user's click) intact
  await whenPointerUp();
  if (tab !== S.tab) return;
  tab.dataSig = nextSig;
  Object.assign(S, { commits, status, refs, stashes });
  tab.dirty = status.files.length > 0; tab.branch = status.branch;
  renderTabs();
  S.statusSig = sig(status);
  renderAll();
  loadIdentity();
  loadExtras();
  renderUndo();
}
async function loadPRs() {
  if (!S.info) return;
  const tab = S.tab;
  const prs = await G('prs').catch((e) => ({ available: false, error: e.message, items: [] }));
  if (tab !== S.tab) return;
  S.prs = prs;
  loadIssues();
  renderSidebar();
  if (S.sel?.type === 'pr') { const pr = S.prs.items?.find((p) => p.number === S.sel.id); if (pr) renderPR(pr); }
}
const sig = (st) => JSON.stringify([st.oid, st.branch, st.ahead, st.behind, st.state, st.files]);

const openRepo = (dir) => openTab(dir); // repositories always open in a tab (tabs.js)

// ---------- rendering ----------
function renderAll() {
  renderTop();
  renderGraph();
  renderSidebar();
  renderDetail();
}

function renderEmpty() {
  $('#empty').classList.add('on');
  $('#graphHead').style.display = 'none';
  $('#graphScroll').style.display = 'none';
  api.state().then((st) => {
    $('#recentList').innerHTML = (st.recent || []).slice(0, 6).map((p) => `<button data-path="${esc(p)}"><b>${esc(p.split('/').pop())}</b><small>${esc(p)}</small></button>`).join('');
  });
  $('#detail').innerHTML = `<div class="d-head"><div class="d-kicker">Nebula</div><p class="d-body">Open a repository with ⌘O, or drag a folder onto the window.</p></div>`;
  $('#sideScroll').innerHTML = '';
}

function renderTop() {
  const st = S.status;
  $('#empty').classList.remove('on');
  $('#graphHead').style.display = '';
  $('#graphScroll').style.display = '';
  $('#repoName').textContent = S.info.name;
  $('#repoBranch').textContent = st.state === 'rebasing' ? `rebasing ${st.op?.current || ''}` : st.branch || `detached @ ${short(st.oid)}`;
  $('#repoBtn').title = `${S.info.path}\nClick to switch branch`;
  $('#pullMode') && ($('#pullMode').textContent = '');
  $$('.toolbar [data-act="pull"]').forEach((b) => { b.title = `${PULL_MODES[pullMode()].label} (⌘⇧L)`; });
  const prov = S.tab?.provider;
  $('#prIcon').innerHTML = prov === 'github' || prov === 'gitlab' ? brand(prov) : icon('pr');
  $('#prLabel').textContent = prov === 'gitlab' ? 'Merge Request' : 'Pull Request';
  const set = (id, n) => { const b = $(id); b.textContent = n || ''; b.classList.toggle('on', n > 0); };
  set('#behindBadge', st.behind);
  set('#aheadBadge', st.ahead);
}

function refsByHash() {
  const map = new Map();
  const add = (h, r) => { if (!map.has(h)) map.set(h, []); map.get(h).push(r); };
  const remoteSet = new Map(S.refs.remote.map((r) => [r.name, r.oid]));
  const merged = new Set();
  for (const b of S.refs.local) {
    const remotes = [...remoteSet.keys()].filter((rn) => rn.split('/').slice(1).join('/') === b.name && remoteSet.get(rn) === b.oid);
    remotes.forEach((r) => merged.add(r));
    add(b.oid, { kind: 'branch', name: b.name, remote: remotes.length > 0, current: b.current });
  }
  for (const r of S.refs.remote) if (!merged.has(r.name)) add(r.oid, { kind: 'remote', name: r.name });
  for (const t of S.refs.tags) add(t.oid, { kind: 'tag', name: t.name });
  return map;
}

function renderGraph() {
  const st = S.status;
  const list = S.commits.slice();
  const dirty = st.files.length > 0;
  if (dirty) list.unshift({ hash: 'WIP', parents: st.oid ? [st.oid] : [], wip: true });
  S.list = list;
  S.byHash = new Map(list.map((c, i) => [c.hash, i]));
  // Tags point at tag objects in for-each-ref; map them to commits using the log decorations instead.
  const decorated = new Map();
  for (const c of S.commits) for (const r of c.refs) if (r.type === 'tag') decorated.set(r.name, c.hash);
  S.refs.tags.forEach((t) => { if (decorated.has(t.name)) t.oid = decorated.get(t.name); });
  const refMap = refsByHash();

  const L = layoutGraph(list);
  S.layout = L;
  const gw = Math.max(2, L.maxLanes) * LANE_W + PAD * 2;
  $('#headGraph').style.width = `${gw}px`;
  const x = (lane) => PAD + lane * LANE_W + LANE_W / 2;
  const svgLeft = ROW_MARGIN + REFS_W;
  const H = list.length * ROW_H;

  let paths = '';
  const nodes = [];
  const rowsHTML = [];
  L.rows.forEach((row, r) => {
    const c = list[r];
    const top = r * ROW_H, mid = top + ROW_H / 2, bot = top + ROW_H;
    const curve = (x1, y1, x2, y2) => (x1 === x2 ? `M${x1} ${y1}V${y2}` : `M${x1} ${y1}C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`);
    for (const s of row.segs) {
      const col = LANE_COLORS[s.color];
      let d;
      if (s.kind === 'pass') d = `M${x(s.from)} ${top}V${bot}`;
      else if (s.kind === 'in') d = s.from === s.to ? `M${x(s.from)} ${top}V${mid}` : curve(x(s.from), top, x(s.to), mid);
      else d = s.from === s.to ? `M${x(s.from)} ${mid}V${bot}` : curve(x(s.from), mid, x(s.to), bot);
      const dash = c.wip ? ' stroke-dasharray="3 4" stroke-opacity=".8"' : '';
      paths += `<path d="${d}" style="stroke:${col}"${dash}/>`;
    }
    const color = c.wip ? 'var(--amber)' : LANE_COLORS[row.color];
    const refs = refMap.get(c.hash) || [];
    if (refs.length) paths += `<path d="M-6 ${mid}H${x(row.col)}" style="stroke:${color}" stroke-opacity=".45" stroke-width="1.5"/>`;

    // node
    const nx = svgLeft + x(row.col);
    let nodeInner = '';
    let cls = 'node';
    if (c.wip) { cls += ' wip'; nodeInner = icon('pencil'); }
    else if (row.merge) cls += ' merge';
    else nodeInner = `${esc(initials(c.author))}<img src="${esc(c.avatar)}" loading="lazy" alt="">`;
    nodes.push(`<div class="${cls}" data-i="${r}" style="left:${nx}px;top:${mid}px;--c:${color}">${nodeInner}</div>`);

    // ref pills
    const pills = refs.slice(0, 2).map((rf) => {
      if (rf.kind === 'tag') return `<span class="ref tag" title="tag ${esc(rf.name)}">${icon('tag')}<span>${esc(rf.name)}</span></span>`;
      const ic = rf.kind === 'remote' ? icon('cloud') : icon('laptop') + (rf.remote ? icon('cloud') : '');
      return `<span class="ref ${rf.kind === 'remote' ? 'remote-only' : ''} ${rf.current ? 'head' : ''}" style="--c:${color}" title="${esc(rf.name)} — drag onto another branch to merge or rebase" draggable="true" data-dnd-kind="${rf.kind === 'remote' ? 'remote' : 'local'}" data-dnd-name="${esc(rf.name)}">${rf.current ? icon('check') : ''}${ic}<span>${esc(rf.name)}</span></span>`;
    }).join('') + (refs.length > 2 ? `<span class="ref more" title="${esc(refs.slice(2).map((r) => r.name).join('\n'))}">+${refs.length - 2}</span>` : '');

    if (c.wip) {
      const staged = st.files.filter((f) => f.x !== ' ' && f.x !== '?').length;
      const unstaged = st.files.filter((f) => f.y !== ' ').length;
      rowsHTML.push(`<div class="row wip ${S.sel?.type === 'wip' ? 'sel' : ''}" data-i="${r}">
        <div class="col-refs"></div><div class="col-graph" style="width:${gw}px"></div>
        <div class="col-msg ${st.state ? 'op' : ''}"><span class="wip-draft">${wipLabel()}</span>${st.state ? '' : `<span class="wip-counts">${staged ? `<span>${icon('check')}${staged}</span>` : ''}${unstaged ? `<span>${icon('pencil')}${unstaged}</span>` : ''}</span>`}</div>
        <div class="col-author"></div><div class="col-date">now</div><div class="col-sha"></div></div>`);
    } else {
      rowsHTML.push(`<div class="row ${S.sel?.type === 'commit' && S.sel.id === c.hash ? 'sel' : ''}" data-i="${r}">
        <div class="col-refs">${pills}</div><div class="col-graph" style="width:${gw}px"></div>
        <div class="col-msg" title="${esc(c.subject)}">${row.merge ? `<span class="merge-tag">${esc(c.subject)}</span>` : esc(c.subject)}</div>
        <div class="col-author">${avatar(c.author, c.email, c.avatar)}<span class="nm">${esc(c.author)}</span></div>
        <div class="col-date" title="${esc(fullDate(c.time))}">${ago(c.time)}</div>
        <div class="col-sha">${short(c.hash)}</div></div>`);
    }
  });

  const svg = $('#lanes');
  svg.setAttribute('width', gw); svg.setAttribute('height', H);
  svg.style.left = `${svgLeft}px`;
  svg.innerHTML = `<g fill="none" stroke-width="2" stroke-linecap="round">${paths}</g>`;
  $('#rows').innerHTML = rowsHTML.join('');
  $('#nodes').innerHTML = nodes.join('');
  $('#graphContent').style.height = `${H}px`;
  $('#loadMore').classList.toggle('on', S.commits.length >= S.limit);
  applySearch();
}

function wipLabel() {
  const st = S.status;
  if (st?.state) return `${icon('alert')}${esc(OP[st.state].verb)} · ${st.conflicts ? `${st.conflicts} conflict${st.conflicts > 1 ? 's' : ''}` : 'ready to continue'}`;
  return `// WIP${S.draft.summary ? ` — ${esc(S.draft.summary)}` : ''}`;
}

const matchesQuery = (c, q) => !c.wip && (c.subject?.toLowerCase().includes(q) || c.author?.toLowerCase().includes(q) || c.email?.toLowerCase().includes(q) || c.hash.startsWith(q) || c.refs?.some((r) => r.name.toLowerCase().includes(q)));
function applySearch() {
  const q = S.query.toLowerCase();
  const rows = $$('#rows .row'), nodes = $$('#nodes .node');
  S.matches = [];
  S.list.forEach((c, i) => {
    const hit = !!q && matchesQuery(c, q);
    if (hit) S.matches.push(i);
    const dim = !!q && !hit && !c.wip;
    rows[i]?.classList.toggle('dim', dim);
    rows[i]?.classList.toggle('hit', hit);
    nodes[i]?.classList.toggle('dim', dim);
  });
  renderSearchCount();
}

function markSelection() {
  $$('#rows .row.sel').forEach((r) => r.classList.remove('sel'));
  $$('#nodes .node.sel').forEach((r) => r.classList.remove('sel'));
  let i = -1;
  if (S.sel?.type === 'wip') i = S.byHash.get('WIP');
  else if (S.sel?.type === 'commit' || S.sel?.type === 'stash') i = S.byHash.get(S.sel.id);
  if (i == null || i < 0) return;
  $(`#rows .row[data-i="${i}"]`)?.classList.add('sel');
  $(`#nodes .node[data-i="${i}"]`)?.classList.add('sel');
}
function scrollToRow(i, { center = false } = {}) {
  const sc = $('#graphScroll');
  const y = i * ROW_H;
  if (center || y < sc.scrollTop || y > sc.scrollTop + sc.clientHeight - ROW_H * 2) sc.scrollTo({ top: Math.max(0, y - sc.clientHeight / 3), behavior: 'smooth' });
}
function select(sel, { scroll } = {}) {
  S.sel = sel;
  closeDiff();
  markSelection();
  renderDetail();
  renderSidebarSelection();
  if (scroll) { const i = S.byHash.get(sel.type === 'wip' ? 'WIP' : sel.id); if (i != null) scrollToRow(i); }
}
function selectHash(h) {
  if (S.byHash.has(h)) select({ type: 'commit', id: h }, { scroll: true });
  else toast('err', 'Commit not loaded', `${short(h)} is beyond the loaded history. Use “Load more”.`);
}

// ---------- sidebar ----------
function section(key, title, count, body, addAct, logo) {
  const open = !S.collapsed[key] || S.sideQuery;
  return `<div class="sec ${open ? 'open' : ''}" data-sec="${key}"><div class="sec-h">${icon('right', 'caret')}${logo && logo !== 'git' ? brand(logo, 'sec-logo') : ''}${esc(title)}<span class="count">${count}</span>${addAct ? `<span class="icon-btn add" data-add="${addAct}" title="New">${icon('plus')}</span>` : ''}</div><div class="sec-body">${body}</div></div>`;
}
function renderSidebar() {
  if (!S.info) return;
  const q = S.sideQuery.toLowerCase();
  const m = (s) => !q || s.toLowerCase().includes(q);
  const local = S.refs.local.filter((b) => m(b.name));
  const localHTML = local.map((b) => `<div class="item ${b.current ? 'current' : ''}" data-kind="local" data-name="${esc(b.name)}" data-oid="${b.oid}" draggable="true" data-dnd-kind="local" data-dnd-name="${esc(b.name)}" title="${esc(b.name)}${b.upstream ? ` → ${esc(b.upstream)}` : ''}">
    ${icon(b.current ? 'check' : 'branch')}<span class="nm">${esc(b.name)}</span>
    <span class="ab">${b.ahead ? `<b class="up">↑${b.ahead}</b>` : ''}${b.behind ? `<b class="dn">↓${b.behind}</b>` : ''}${b.gone ? '<b class="dn">gone</b>' : ''}</span></div>`).join('');

  const groups = {};
  S.refs.remote.filter((r) => m(r.name)).forEach((r) => { const [g] = r.name.split('/'); (groups[g] ||= []).push(r); });
  const remoteHTML = Object.entries(groups).map(([g, rs]) => `<div class="grp" data-remote="${esc(g)}" title="Right-click for fetch, edit URL, rename, remove">${g === 'origin' && S.tab ? brand(S.tab.provider, 'grp-logo') : icon('cloud')}${esc(g)}</div>` + rs.map((r) => `<div class="item" data-kind="remote" data-name="${esc(r.name)}" data-oid="${r.oid}" draggable="true" data-dnd-kind="remote" data-dnd-name="${esc(r.name)}" title="${esc(r.name)}">${icon('branch')}<span class="nm">${esc(r.name.slice(g.length + 1))}</span></div>`).join('')).join('');

  let prHTML;
  if (!S.prs.available) prHTML = `<div class="side-note">${S.prs.error ? esc(S.prs.error) : 'Loading…'}</div>${S.prs.error ? '<div class="side-note"><a href="#" data-open-accounts>Connect a GitHub or GitLab account →</a></div>' : ''}`;
  else if (!S.prs.items.length) prHTML = '<div class="side-note">No open pull requests</div>';
  else prHTML = S.prs.items.filter((p) => m(p.title) || m(String(p.number))).map((p) => `<div class="item pr" data-kind="pr" data-num="${p.number}" title="${esc(p.title)}">
    ${avatar(p.author?.login, p.author?.login, p.author?.avatar || `https://github.com/${encodeURIComponent(p.author?.login || '')}.png?size=40`)}
    <div class="pr-t"><span>${esc(p.title)}</span><small>#${p.number} · ${esc(p.headRefName)}${p.isDraft ? ' · draft' : ''}${p.reviewDecision === 'APPROVED' ? ' · ✓ approved' : p.reviewDecision === 'CHANGES_REQUESTED' ? ' · ✗ changes' : ''}</small></div></div>`).join('');

  const stashHTML = S.stashes.filter((s) => m(s.message)).map((s) => `<div class="item" data-kind="stash" data-ref="${esc(s.ref)}" data-hash="${s.hash}" title="${esc(s.message)}">${icon('stash')}<span class="nm">${esc(s.message.replace(/^(WIP )?[Oo]n [^:]+: /, ''))}</span><span class="ab">${ago(s.time).replace(' ago', '')}</span></div>`).join('') || '<div class="side-note">No stashes</div>';
  const tagHTML = S.refs.tags.filter((t) => m(t.name)).map((t) => `<div class="item" data-kind="tag" data-name="${esc(t.name)}" data-oid="${t.oid}">${icon('tag')}<span class="nm">${esc(t.name)}</span></div>`).join('') || '<div class="side-note">No tags</div>';

  $('#sideScroll').innerHTML =
    section('local', 'Local', S.refs.local.length, localHTML || '<div class="side-note">No branches yet</div>', 'branch') +
    section('remote', 'Remote', S.refs.remote.length, remoteHTML || '<div class="side-note">No remotes</div>', 'remote') +
    section('prs', S.prs.provider === 'gitlab' ? 'Merge Requests' : 'Pull Requests', S.prs.items?.length || 0, prHTML, 'pr', S.tab?.provider) +
    issuesSection(section) +
    section('stashes', 'Stashes', S.stashes.length, stashHTML, 'stash') +
    section('tags', 'Tags', S.refs.tags.length, tagHTML) + extraSections(section);
  renderSidebarSelection();
}
function renderSidebarSelection() {
  $$('#sideScroll .item.sel').forEach((e) => e.classList.remove('sel'));
  if (S.sel?.type === 'pr') $(`#sideScroll .item[data-num="${S.sel.id}"]`)?.classList.add('sel');
  if (S.sel?.type === 'stash') $(`#sideScroll .item[data-hash="${S.sel.id}"]`)?.classList.add('sel');
}

// ---------- detail pane ----------
function renderDetail() {
  if (S.multi?.length >= 2) return renderMultiPanel();
  if (S.status?.state && (!S.sel || S.sel.type === 'wip')) { S.sel = { type: 'wip' }; return renderOpPanel(); }
  const d = $('#detail');
  if (S.sel?.type === 'wip' && !S.status.files.length) S.sel = null;
  if (!S.sel) {
    if (S.status?.files.length) return select({ type: 'wip' });
    const head = S.commits[0];
    if (head) { S.sel = { type: 'commit', id: S.status.oid || head.hash }; markSelection(); return renderCommit(); }
    d.innerHTML = `<div class="d-head"><div class="d-kicker">Empty repository</div><p class="d-body">Create some files, then commit them here.</p></div>`;
    return;
  }
  if (S.sel.type === 'wip') return renderWip();
  if (S.sel.type === 'commit' || S.sel.type === 'stash') return renderCommit();
  if (S.sel.type === 'issue') return renderIssue();
  if (S.sel.type === 'pr') { const pr = S.prs.items.find((p) => p.number === S.sel.id); if (pr) return renderPR(pr); }
}

function fileRow(f, { mode, hash, staged } = {}) {
  const status = f.status || (staged ? f.x : (f.untracked ? '?' : f.y));
  const total = (f.add || 0) + (f.del || 0);
  let bar = '';
  if (f.add != null && total) {
    const n = 5, a = Math.round((f.add / total) * n);
    bar = `<span class="bar" title="+${f.add} −${f.del}">${Array.from({ length: n }, (_, i) => `<i class="${i < a ? 'a' : 'd'}"></i>`).join('')}</span>`;
  }
  const acts = mode === 'wip' ? `<span class="acts">${staged
    ? `<button class="icon-btn no" data-op="unstage" title="Unstage">${icon('minus')}</button>`
    : `<button class="icon-btn no" data-op="discard" title="Discard changes">${icon('trash')}</button><button class="icon-btn ok" data-op="stage" title="Stage">${icon('plus')}</button>`}</span>` : '';
  return `<div class="file" data-path="${esc(f.path)}" data-mode="${mode === 'wip' ? (staged ? 'staged' : 'unstaged') : 'commit'}" data-hash="${hash || ''}" data-st="${esc(status)}" ${f.untracked ? 'data-untracked="1"' : ''} title="${esc(f.orig ? `${f.orig} → ${f.path}` : f.path)}">
    <span class="st ${status === '?' ? 'A' : esc(status)}">${status === '?' ? 'A' : esc(status)}</span><span class="fp">${pathHTML(f.path)}</span>${bar}${acts}</div>`;
}

function renderWip() {
  if (S.status.state) return renderOpPanel();
  const d = $('#detail');
  const st = S.status;
  const staged = st.files.filter((f) => f.x !== ' ' && f.x !== '?' && !f.conflict);
  const unstaged = st.files.filter((f) => f.y !== ' ' || f.conflict);
  const lists = `<div id="idBanner"></div>
    ${st.state ? `<div class="state-banner">${icon('alert')}<span>${esc(st.state[0].toUpperCase() + st.state.slice(1))} in progress</span><button class="btn sm" data-act="abort">Abort</button></div>` : ''}
    <div class="wip-sec"><div class="files-h"><span>Unstaged files · ${unstaged.length}</span>${unstaged.length ? '<button class="btn sm" data-act="stageAll">Stage all</button>' : ''}</div>
      <div class="files">${unstaged.map((f) => fileRow(f, { mode: 'wip' })).join('') || '<div class="wip-empty">Working tree is clean.</div>'}</div></div>
    <div class="wip-sec"><div class="files-h"><span>Staged files · ${staged.length}</span>${staged.length ? '<button class="btn sm" data-act="unstageAll">Unstage all</button>' : ''}</div>
      <div class="files">${staged.map((f) => fileRow(f, { mode: 'wip', staged: true })).join('') || '<div class="wip-empty">Stage files to include them in the commit.</div>'}</div></div>`;

  const head = `<div class="d-kicker">${icon('pencil')} Work in progress <span class="pill violet">${esc(st.branch || 'detached')}</span></div>
        <div class="d-title">${st.files.length} changed file${st.files.length > 1 ? 's' : ''}</div>`;
  if (d.dataset.view === 'wip' && $('#wipLists', d)) {
    $('#wipHead', d).innerHTML = head;
    $('#wipLists', d).innerHTML = lists;
  } else {
    d.dataset.view = 'wip';
    d.innerHTML = `<div class="d-head" id="wipHead">${head}</div>
      <div id="wipLists">${lists}</div>
      <div class="composer">
        <div id="idBar"></div>
        <div class="lbl"><span>Commit summary</span><span class="counter" id="cnt">0/72</span></div>
        <input id="cSummary" placeholder="Describe your change…" spellcheck="true">
        <textarea id="cBody" placeholder="Description (optional)"></textarea>
        <label class="check"><input type="checkbox" id="cAmend"> Amend previous commit</label>
        <button class="btn primary big" id="cGo">${icon('check')}<span id="cGoTxt">Commit</span></button>
      </div>`;
    const sum = $('#cSummary'), body = $('#cBody'), amend = $('#cAmend');
    sum.value = S.draft.summary; body.value = S.draft.body; amend.checked = S.draft.amend;
    sum.oninput = () => { S.draft.summary = sum.value; updateComposer(); const w = $('#rows .row.wip .wip-draft'); if (w) w.innerHTML = wipLabel(); };
    body.oninput = () => { S.draft.body = body.value; };
    amend.onchange = async () => {
      S.draft.amend = amend.checked;
      if (amend.checked && !sum.value) {
        const msg = (await G('lastMessage').catch(() => '')).trim();
        const [first, ...rest] = msg.split('\n');
        sum.value = S.draft.summary = first || ''; body.value = S.draft.body = rest.join('\n').trim();
      }
      updateComposer();
    };
    const submit = () => doCommit();
    $('#cGo').onclick = submit;
    [sum, body].forEach((el) => el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || el === sum)) { e.preventDefault(); submit(); } }));
  }
  updateComposer();
  if (typeof renderIdentityBar === 'function') renderIdentityBar();
}
function updateComposer() {
  const sum = $('#cSummary'); if (!sum) return;
  const n = sum.value.length;
  const c = $('#cnt'); c.textContent = `${n}/72`; c.className = `counter ${n > 72 ? 'bad' : n > 50 ? 'warn' : ''}`;
  const staged = S.status.files.filter((f) => f.x !== ' ' && f.x !== '?' && !f.conflict).length;
  const btn = $('#cGo');
  btn.disabled = !sum.value.trim() || (!staged && !S.draft.amend);
  const as = S.id?.mismatch ? ` as ${S.id.effective?.email?.value || '?'}` : '';
  $('#cGoTxt').textContent = S.draft.amend ? `Amend previous commit${as}` : staged ? `Commit ${staged} file${staged > 1 ? 's' : ''}${as}` : 'Stage files to commit';
}
async function doCommit() {
  const msg = S.draft.summary.trim() + (S.draft.body.trim() ? `\n\n${S.draft.body.trim()}` : '');
  if (!S.draft.summary.trim()) return;
  const before = { oid: S.status.oid, branch: S.status.branch };
  const label = S.draft.amend ? 'amend' : `commit “${S.draft.summary.trim()}”`;
  const ok = await act(S.draft.amend ? 'Amended commit' : 'Committed', () => G('commitCreate', { message: msg, amend: S.draft.amend }), { refresh: false });
  if (ok) {
    S.draft = { summary: '', body: '', amend: false };
    $('#detail').dataset.view = '';
    S.sel = null;
    await reload();
    recordUndo({ kind: 'commit', label }, before);
  }
}

async function renderCommit() {
  const d = $('#detail');
  const { id, type, ref } = S.sel;
  d.dataset.view = 'commit';
  let c;
  try { c = await G('commit', { hash: id }); } catch (e) { d.innerHTML = `<div class="d-head"><p class="d-body">${esc(e.message)}</p></div>`; return; }
  if (S.sel?.id !== id || d.dataset.view !== 'commit') return; // user moved on (other commit, compare, multi-select…)
  const [subject, ...rest] = c.message.split('\n');
  const adds = c.files.reduce((a, f) => a + (f.add || 0), 0), dels = c.files.reduce((a, f) => a + (f.del || 0), 0);
  const isStash = type === 'stash';
  const committedBy = c.committer !== c.author ? `<small>committed by ${esc(c.committer)} · ${ago(c.committerTime)}</small>` : '';
  d.innerHTML = `<div class="d-head">
      <div class="d-kicker">${icon(isStash ? 'stash' : c.parents.length > 1 ? 'merge' : 'commit')} ${isStash ? `Stash · ${esc(ref)}` : c.parents.length > 1 ? 'Merge commit' : 'Commit'}</div>
      <div class="d-title">${esc(subject)}</div>
      ${rest.join('\n').trim() ? `<div class="d-body">${esc(rest.join('\n').trim())}</div>` : ''}
      <div class="who">${avatar(c.author, c.email, c.avatar, 'lg')}<div class="meta"><b>${esc(c.author)}</b><small>${esc(c.email)}</small><small title="${esc(fullDate(c.time))}">${ago(c.time)} · ${esc(fullDate(c.time))}</small>${committedBy}</div></div>
      <div class="sha-line"><span class="pill" data-copy="${c.hash}" title="Copy full SHA">${icon('copy')}${short(c.hash)}</span>
        ${c.parents.map((p) => `<span class="pill" data-goto="${p}" title="Parent">${icon('commit')}${short(p)}</span>`).join('')}</div>
    </div>
    <div class="d-actions">${isStash
      ? `<button class="btn" data-act="stashApply">${icon('pop')}Apply</button><button class="btn" data-act="stashPop">${icon('pop')}Pop</button><button class="btn danger" data-act="stashDrop">${icon('trash')}Drop</button>`
      : `<button class="btn" data-act="checkoutCommit">${icon('commit')}Checkout</button><button class="btn" data-act="branchHere">${icon('branch')}Branch</button><button class="btn" data-act="cherryPick">${icon('sparkle')}Cherry-pick</button><button class="btn" data-act="revert">${icon('undo')}Revert</button>`}</div>
    <div class="files-h"><span>${c.files.length} file${c.files.length !== 1 ? 's' : ''} changed</span><span class="stats"><span class="add-c">+${adds}</span><span class="del-c">−${dels}</span></span></div>
    <div class="files">${c.files.map((f) => fileRow(f, { mode: 'commit', hash: c.hash })).join('')}</div>`;
}

function renderPR(pr) {
  const d = $('#detail');
  d.dataset.view = 'pr';
  const login = pr.author?.login || 'unknown';
  const review = { APPROVED: ['green', 'Approved'], CHANGES_REQUESTED: ['red', 'Changes requested'], REVIEW_REQUIRED: ['amber', 'Review required'] }[pr.reviewDecision];
  d.innerHTML = `<div class="d-head">
      <div class="d-kicker">${icon('pr')} ${S.prs.provider === 'gitlab' ? `Merge request !${pr.number}` : `Pull request #${pr.number}`} <span class="pr-state ${pr.isDraft ? 'draft' : ''}">${pr.isDraft ? 'Draft' : 'Open'}</span>${review ? `<span class="pill ${review[0]}">${review[1]}</span>` : ''}</div>
      <div class="d-title">${esc(pr.title)}</div>
      <div class="pr-branches"><span class="pill violet">${esc(pr.headRefName)}</span>→<span class="pill">${esc(pr.baseRefName)}</span></div>
      ${pr.labels?.length ? `<div class="labels">${pr.labels.map((l) => `<span class="label" style="color:#${esc(l.color)};border-color:#${esc(l.color)}66;background:#${esc(l.color)}1a">${esc(l.name)}</span>`).join('')}</div>` : ''}
      <div class="who">${avatar(login, login, pr.author?.avatar || `https://github.com/${encodeURIComponent(login)}.png?size=92`, 'lg')}<div class="meta"><b>${esc(pr.author?.name || login)}</b><small>@${esc(login)}</small><small>opened ${ago(Date.parse(pr.createdAt) / 1000)} · updated ${ago(Date.parse(pr.updatedAt) / 1000)}</small></div></div>
    </div>
    <div class="stat-grid"><div class="stat"><b class="add-c">${pr.additions == null ? '—' : `+${pr.additions}`}</b><small>Additions</small></div><div class="stat"><b class="del-c">${pr.deletions == null ? '—' : `−${pr.deletions}`}</b><small>Deletions</small></div><div class="stat"><b>${pr.changedFiles ?? '—'}</b><small>Files</small></div></div>
    <div class="d-actions"><button class="btn primary" data-act="prCheckout">${icon('branch')}Checkout</button><button class="btn" data-act="prOpen">${brand(S.prs.provider === 'gitlab' ? 'gitlab' : 'github', 'btn-logo')}Open on ${S.prs.provider === 'gitlab' ? 'GitLab' : 'GitHub'}</button><button class="btn" data-act="prMerge">${icon('merge')}Merge…</button></div>
    <div class="pr-body">${pr.body ? esc(pr.body) : '<i style="color:var(--text-3)">No description provided.</i>'}</div>`;
  const head = S.refs.local.find((b) => b.name === pr.headRefName) || S.refs.remote.find((r) => r.name.endsWith(`/${pr.headRefName}`));
  if (head && S.byHash.has(head.oid)) scrollToRow(S.byHash.get(head.oid));
}

// ---------- diff ----------
let diffCtx = null;
async function openDiff(ctx) {
  diffCtx = ctx;
  $$('#detail .file.sel').forEach((e) => e.classList.remove('sel'));
  $(`#detail .file[data-path="${CSS.escape(ctx.path)}"][data-mode="${ctx.mode}"]`)?.classList.add('sel');
  const v = $('#diffView');
  v.hidden = false;
  $('#diffPath').textContent = ctx.path;
  const st = ctx.st === '?' ? 'A' : ctx.st;
  $('#diffStatus').className = `st ${st}`; $('#diffStatus').textContent = st;
  $('#diffMeta').textContent = ctx.mode === 'commit' ? short(ctx.hash) : ctx.mode === 'compare' ? `${ctx.a} → ${ctx.b}` : ctx.mode;
  $('#diffView').classList.remove('resolver', 'history');
  $('#diffActions').innerHTML = ctx.mode === 'unstaged'
    ? `<button class="btn sm danger" data-dop="discard">${icon('trash')}Discard</button><button class="btn sm primary" data-dop="stage">${icon('plus')}Stage file</button>`
    : ctx.mode === 'staged' ? `<button class="btn sm" data-dop="unstage">${icon('minus')}Unstage file</button>` : '';
  $('#diffBody').innerHTML = '<div class="diff-empty">Loading…</div>';
  try {
    const text = await G('diff', { path: ctx.path, mode: ctx.mode, hash: ctx.hash, untracked: ctx.untracked, a: ctx.a, b: ctx.b, direct: ctx.direct });
    if (diffCtx !== ctx) return;
    $('#lineBar')?.remove();
    $('#diffBody').innerHTML = renderDiffInteractive(text, ctx) ?? renderDiff(text);
  } catch (e) { $('#diffBody').innerHTML = `<div class="diff-empty">${esc(e.message)}</div>`; }
}
function renderDiff(text) {
  if (!text.trim()) return '<div class="diff-empty">No textual changes (mode change or empty file).</div>';
  if (/^Binary files .* differ$/m.test(text) && !text.includes('@@')) return '<div class="diff-empty">Binary file changed.</div>';
  const out = []; let o = 0, n = 0, open = false;
  for (const line of text.split('\n')) {
    const h = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/);
    if (h) {
      if (open) out.push('</div>');
      o = +h[1]; n = +h[2]; open = true;
      out.push(`<div class="hunk"><div class="hunk-h">${esc(line)}</div>`);
      continue;
    }
    if (!open) continue;
    const c = line[0], body = esc(line.slice(1)) || ' ';
    if (c === '+') out.push(`<div class="dl add"><span class="n"></span><span class="n">${n++}</span><span class="c">${body}</span></div>`);
    else if (c === '-') out.push(`<div class="dl del"><span class="n">${o++}</span><span class="n"></span><span class="c">${body}</span></div>`);
    else if (c === ' ') out.push(`<div class="dl"><span class="n">${o++}</span><span class="n">${n++}</span><span class="c">${body}</span></div>`);
    else if (c === '\\') out.push(`<div class="dl"><span class="n"></span><span class="n"></span><span class="c" style="color:var(--text-3)">${esc(line)}</span></div>`);
  }
  if (open) out.push('</div>');
  return out.join('') || '<div class="diff-empty">No textual changes.</div>';
}
function closeDiff() { $('#diffView').hidden = true; $('#diffView').classList.remove('resolver', 'history'); $('#lineBar')?.remove(); RZ.path = null; diffCtx = null; $$('#detail .file.sel').forEach((e) => e.classList.remove('sel')); }

// ---------- operations ----------
async function fileOp(op, path, untracked) {
  if (op === 'discard') {
    if (!(await confirmDanger(`Discard changes to ${path}?`, untracked ? 'This untracked file will be deleted.' : 'Your local modifications will be lost.', 'Discard'))) return;
    await act('Discarded changes', () => G('discard', { paths: [path], untracked }), { quiet: true });
  } else await act(op === 'stage' ? 'Staged' : 'Unstaged', () => G(op, { paths: [path] }), { quiet: true });
  if (diffCtx?.path === path) closeDiff();
}

async function newBranch(from) {
  const v = await modal({ title: 'Create branch', iconName: 'branch', text: from ? `Starting from ${short(from)}` : 'Starting from HEAD', ok: 'Create branch',
    fields: [{ name: 'name', label: 'Branch name', placeholder: 'feature/something-cool' }, { name: 'checkout', label: 'Check out after creating', type: 'checkbox', value: true }] });
  if (!v?.name) return;
  await act('Create branch', async () => { await G('createBranch', { name: v.name, from, checkout: v.checkout }); return { summary: `Created ${v.name}${v.checkout ? ' and switched to it' : ''}` }; }, { button: tbBtn('branch'), hud: { title: `Creating ${v.name}`, icon: 'branch' }, undo: { kind: 'branchCreate', name: v.name, checkout: v.checkout, label: `create branch ${v.name}` } });
}
async function stashChanges() {
  if (!S.status.files.length) return hudInfo('Nothing to stash — working tree is clean', 'stash');
  const v = await modal({ title: 'Stash changes', iconName: 'stash', ok: 'Stash', fields: [{ name: 'message', label: 'Message (optional)', placeholder: 'WIP: half-finished idea', value: S.draft.summary }] });
  if (!v) return;
  const n = S.status.files.length;
  await act('Stash', async () => { await G('stash', { message: v.message }); return { summary: `Stashed ${n} file${n > 1 ? 's' : ''}${v.message ? ` — “${v.message}”` : ''}` }; }, { button: tbBtn('stash'), hud: { title: 'Stashing changes', icon: 'stash' }, undo: { kind: 'stash', message: v.message, label: 'stash' } });
}
// The full form lives in pr.js (connected to the GitHub/GitLab account of the repository).
async function createPR(pre = {}) { return openPrForm(pre); }
async function commitMenu(c) {
  const id = await api.menu([
    { id: 'checkout', label: 'Checkout this commit' },
    { id: 'branch', label: 'Create branch here…' },
    { id: 'tag', label: 'Create tag here…' },
    { type: 'separator' },
    { id: 'cherry', label: 'Cherry-pick commit' },
    { id: 'revert', label: 'Revert commit' },
    { type: 'separator' },
    { id: 'reword', label: 'Edit commit message…', enabled: firstParentChain().includes(c.hash) },
    { id: 'irb', label: 'Interactive rebase from here…', enabled: firstParentChain().includes(c.hash) && c.hash !== S.status.oid },
    { id: 'compareHead', label: 'Compare with HEAD', enabled: c.hash !== S.status.oid },
    { type: 'separator' },
    { label: `Reset ${S.status.branch || 'HEAD'} to this commit`, submenu: [
      { id: 'reset-soft', label: 'Soft — keep all changes staged' },
      { id: 'reset-mixed', label: 'Mixed — keep working copy, reset index' },
      { id: 'reset-hard', label: 'Hard — discard all changes' }] },
    { type: 'separator' },
    { id: 'copy', label: 'Copy commit SHA' },
    { id: 'copymsg', label: 'Copy commit message' },
  ]);
  if (!id) return;
  commitAction(id, c.hash, c);
}
async function commitAction(id, h, c) {
  const s = short(h);
  if (id === 'checkout') {
    if (await api.confirm({ message: `Checkout ${s}?`, detail: 'You will be in detached HEAD state.', ok: 'Checkout' })) act(`Checked out ${s}`, () => G('checkoutCommit', { hash: h }), { undo: { kind: 'checkout', label: `checkout ${s}` } });
  } else if (id === 'branch') newBranch(h);
  else if (id === 'tag') {
    const v = await modal({ title: 'Create tag', iconName: 'tag', text: `On ${s}`, ok: 'Create tag', fields: [{ name: 'name', label: 'Tag name', placeholder: 'v1.0.0' }] });
    if (v?.name) act(`Tagged ${v.name}`, () => G('createTag', { name: v.name, hash: h }));
  } else if (id === 'cherry') act(`Cherry-pick ${s}`, () => G('cherryPick', { hash: h }), { hud: { title: `Cherry-picking ${s}`, icon: 'sparkle' }, undo: { kind: 'head', label: `cherry-pick ${s}` } });
  else if (id === 'revert') act(`Revert ${s}`, () => G('revert', { hash: h }), { hud: { title: `Reverting ${s}`, icon: 'undo' }, undo: { kind: 'head', label: `revert ${s}` } });
  else if (id === 'irb') openInteractiveRebase(h);
  else if (id === 'compareHead') showCompare(h, 'HEAD', { direct: true, title: `${s} → HEAD` });
  else if (id === 'reword') {
    const full = (await G('commit', { hash: h })).message;
    const [subj, ...body] = full.split('\n');
    const v = await modal({ title: 'Edit commit message', iconName: 'pencil', text: h === S.status.oid ? 'Amends the last commit.' : 'Rewrites this commit and the ones after it.', ok: 'Save message',
      fields: [{ name: 'subject', label: 'Summary', value: subj }, { name: 'body', label: 'Description', type: 'textarea', value: body.join('\n').trim() }] });
    if (!v?.subject) return;
    const message = v.subject + (v.body ? `\n\n${v.body}` : '');
    if (h === S.status.oid) {
      act('Edit message', async () => { await G('commitCreate', { message, amend: true }); return { summary: 'Commit message updated' }; }, { hud: { title: 'Updating commit message', icon: 'pencil' }, undo: { kind: 'commit', label: 'message edit' } });
    } else {
      const c0 = S.commits.find((x) => x.hash === h);
      const plan = await G('rebasePlan', { base: c0.parents[0] || null });
      act('Edit message', () => G('rebaseInteractive', { base: c0.parents[0] || null, steps: plan.map((p) => (p.hash === h ? { hash: p.hash, action: 'reword', message } : { hash: p.hash, action: 'pick' })) }),
        { hud: { title: 'Rewriting commit message', icon: 'pencil' }, undo: { kind: 'head', label: 'message edit' } });
    }
  }
  else if (id.startsWith('reset-')) {
    const mode = id.slice(6);
    if (mode === 'hard' && !(await confirmDanger(`Hard reset to ${s}?`, 'All uncommitted changes will be permanently lost.', 'Reset hard'))) return;
    if (mode !== 'hard' && !(await api.confirm({ message: `${mode[0].toUpperCase() + mode.slice(1)} reset to ${s}?`, ok: 'Reset' }))) return;
    act(`Reset (${mode}) to ${s}`, () => G('reset', { hash: h, mode }), { undo: { kind: 'head', mode, label: `reset to ${s}` } });
  } else if (id === 'copy') { api.copy(h); toast('ok', 'SHA copied', h); }
  else if (id === 'copymsg') { api.copy(c?.subject || ''); toast('ok', 'Message copied'); }
}

async function refMenu(kind, name) {
  const cur = S.status.branch;
  let items = [];
  if (kind === 'local') items = [
    { id: 'checkout', label: `Checkout ${name}`, enabled: name !== cur },
    { id: 'merge', label: `Merge ${name} into ${cur}`, enabled: !!cur && name !== cur },
    { id: 'rebase', label: `Rebase ${cur} onto ${name}`, enabled: !!cur && name !== cur },
    { id: 'compare', label: `Compare ${name} with ${cur}`, enabled: !!cur && name !== cur },
    { type: 'separator' },
    { id: 'push', label: `Push ${name}` },
    { id: 'rename', label: 'Rename…' },
    { id: 'delete', label: `Delete ${name}`, enabled: name !== cur },
    { type: 'separator' }, { id: 'copy', label: 'Copy branch name' }];
  else if (kind === 'remote') items = [
    { id: 'checkout', label: `Checkout ${name}` },
    { id: 'merge', label: `Merge ${name} into ${cur}`, enabled: !!cur },
    { id: 'rebase', label: `Rebase ${cur} onto ${name}`, enabled: !!cur },
    { type: 'separator' }, { id: 'deleteRemote', label: `Delete ${name} on remote` },
    { type: 'separator' }, { id: 'copy', label: 'Copy branch name' }];
  else if (kind === 'tag') items = [{ id: 'deleteTag', label: `Delete tag ${name}` }, { id: 'copy', label: 'Copy tag name' }];
  const id = await api.menu(items);
  if (!id) return;
  if (id === 'checkout') checkoutRef(kind, name);
  else if (id === 'merge') act('Merge', () => G('merge', { ref: name }), { hud: { title: `Merging ${name} into ${cur}`, icon: 'merge' }, undo: { kind: 'head', label: `merge of ${name}` } });
  else if (id === 'rebase') { if (await api.confirm({ message: `Rebase ${cur} onto ${name}?`, ok: 'Rebase' })) act('Rebase', () => G('rebase', { ref: name }), { hud: { title: `Rebasing ${cur} onto ${name}`, icon: 'branch' }, undo: { kind: 'head', label: `rebase onto ${name}` } }); }
  else if (id === 'compare') showCompare(cur, name, { title: `${cur} … ${name}` });
  else if (id === 'push') act(`Pushed ${name}`, () => G('pushBranch', { name }));
  else if (id === 'rename') {
    const v = await modal({ title: 'Rename branch', iconName: 'branch', ok: 'Rename', fields: [{ name: 'to', label: 'New name', value: name }] });
    if (v?.to && v.to !== name) act(`Renamed to ${v.to}`, () => G('renameBranch', { name, to: v.to }));
  } else if (id === 'delete') {
    if (!(await confirmDanger(`Delete branch ${name}?`, 'Unmerged commits on this branch may be lost.', 'Delete'))) return;
    const sha = S.refs.local.find((b) => b.name === name)?.oid;
    const undo = { kind: 'branchDelete', name, sha, label: `delete ${name}` };
    const r = await act(`Deleted ${name}`, () => G('deleteBranch', { name }), { quiet: false, undo });
    if (!r && await confirmDanger(`${name} is not fully merged. Force delete?`, 'You can still undo this right after (⌘Z).', 'Force delete')) act(`Deleted ${name}`, () => G('deleteBranch', { name, force: true }), { undo });
  } else if (id === 'deleteRemote') { if (await confirmDanger(`Delete ${name} on the remote?`, 'This affects everyone using this remote.', 'Delete remote branch')) act(`Deleted ${name}`, () => G('deleteRemoteBranch', { name })); }
  else if (id === 'deleteTag') { if (await confirmDanger(`Delete tag ${name}?`, 'Only the local tag is deleted.', 'Delete')) act(`Deleted tag ${name}`, () => G('deleteTag', { name })); }
  else if (id === 'copy') { api.copy(name); toast('ok', 'Copied', name); }
}
const checkoutRef = (kind, name) => act(`Switched to ${kind === 'remote' ? name.split('/').slice(1).join('/') : name}`, () => G('checkout', { ref: name, remote: kind === 'remote' }), { undo: { kind: 'checkout', label: `checkout ${name}` } });

async function stashAction(op, ref) {
  if (op === 'stashDrop' && !(await confirmDanger(`Drop ${ref}?`, 'The stashed changes will be deleted.', 'Drop'))) return;
  const r = await act({ stashApply: 'Applied stash', stashPop: 'Popped stash', stashDrop: 'Dropped stash' }[op], () => G(op, { ref }), { refresh: false });
  if (r && op !== 'stashApply') S.sel = null;
  await reload();
}
async function prAction(op, pr) {
  if (op === 'prCheckout') act(`Checked out PR #${pr.number}`, () => G('prCheckout', { number: pr.number }));
  else if (op === 'prOpen') api.external(pr.url);
  else if (op === 'prMerge') {
    const method = await api.menu([{ id: 'squash', label: 'Squash and merge' }, { id: 'merge', label: 'Create a merge commit' }, { id: 'rebase', label: 'Rebase and merge' }]);
    if (!method || !(await api.confirm({ message: `Merge PR #${pr.number} (${method})?`, detail: pr.title, ok: 'Merge' }))) return;
    if (await act(`Merged PR #${pr.number}`, () => G('prMerge', { number: pr.number, method }))) { S.sel = null; loadPRs(); }
  }
}

const COMMANDS = {
  refresh: () => act('Refreshed', reload, { refresh: false, quiet: true }).then(loadPRs),
  fetch: (b) => act('Fetch', () => G('fetch'), { button: b || tbBtn('fetch'), hud: { title: 'Fetching all remotes', icon: 'fetch' } }).then(loadPRs),
  pull: (b, mode = pullMode()) => (mode === 'fetch' ? COMMANDS.fetch(b) : act('Pull', () => G('pull', { mode }), { button: b || tbBtn('pull'), hud: { title: `Pulling ${S.status?.upstream ? `from ${S.status.upstream}` : ''}`.trim(), icon: 'pull' }, undo: { kind: 'head', label: 'pull' } })),
  push: (b, opts = {}) => act(opts.tags ? 'Push tags' : 'Push', () => G('push', opts), { button: b || tbBtn('push'), hud: { title: opts.tags ? 'Pushing tags' : `${opts.force ? 'Force-pushing' : 'Pushing'} ${S.status?.branch || ''}`.trim(), icon: 'push' } }),
  branch: () => newBranch(S.sel?.type === 'commit' ? S.sel.id : undefined),
  stash: () => stashChanges(),
  pop: (b) => (S.stashes.length
    ? act('Pop stash', async () => { const msg = S.stashes[0].message; await G('stashPop', { ref: S.stashes[0].ref }); S.sel = { type: 'wip' }; return { summary: `Popped “${msg.replace(/^(WIP )?[Oo]n [^:]+: /, '')}”` }; }, { button: b || tbBtn('pop'), hud: { title: 'Popping stash', icon: 'pop' } })
    : hudInfo('No stash to pop', 'pop')),
  open: () => openTab(),
  newTab: () => newTab(),
  closeTab: () => S.tab && closeTab(S.tab),
  nextTab: () => cycleTab(1),
  prevTab: () => cycleTab(-1),
  reveal: () => S.tab && api.reveal(S.tab.path),
  pr: () => createPR(),
  find: () => $('#search').focus(),
  identities: () => openIdentities(),
  issue: () => newIssue(),
  terminal: () => toggleTerminal(),
  toggleSidebar: () => togglePanel('side'),
  toggleDetails: () => togglePanel('detail'),
  undo: () => undoRedo('undo'),
  redo: () => undoRedo('redo'),
  undoKey: () => (document.activeElement?.closest?.('input, textarea') ? document.execCommand('undo') : undoRedo('undo')),
  redoKey: () => (document.activeElement?.closest?.('input, textarea') ? document.execCommand('redo') : undoRedo('redo')),
  remote: () => addRemote(),
  worktree: () => addWorktree(),
  submodule: () => act('Submodules', () => G('submoduleUpdate'), { hud: { title: 'Updating submodules', icon: 'fetch' } }).then(loadExtras),
};

// ---------- events ----------
function bind() {
  hydrateIcons();
  $('#emptyOpen').onclick = () => openRepo();
  $('#recentList').onclick = (e) => { const b = e.target.closest('[data-path]'); if (b) openRepo(b.dataset.path); };
  $$('.toolbar [data-act]').forEach((b) => { b.onclick = () => (S.info ? COMMANDS[b.dataset.act](b) : hudInfo('Open a repository first', 'folder')); });
  $('#loadMore button').onclick = () => { S.limit += 1000; act('Loaded more', reload, { refresh: false, quiet: true }); };

  const rows = $('#rows');
  const rowCommit = (e) => { const r = e.target.closest('.row'); return r ? S.list[+r.dataset.i] : null; };
  rows.onclick = (e) => {
    const c = rowCommit(e); if (!c) return;
    if ((e.metaKey || e.ctrlKey) && !c.wip) return toggleMulti(c.hash);
    if (S.multi.length) clearMulti();
    select(c.wip ? { type: 'wip' } : { type: 'commit', id: c.hash });
  };
  rows.ondblclick = (e) => {
    const c = rowCommit(e); if (!c || c.wip) return;
    const b = S.refs.local.find((x) => x.oid === c.hash && !x.current);
    if (b) checkoutRef('local', b.name);
  };
  rows.oncontextmenu = (e) => { e.preventDefault(); const c = rowCommit(e); if (c && !c.wip) { select({ type: 'commit', id: c.hash }); commitMenu(c); } };

  const side = $('#sideScroll');
  side.onclick = (e) => {
    if (e.target.closest('[data-open-accounts]')) { e.preventDefault(); return openIdentities('accounts'); }
    const add = e.target.closest('[data-add]');
    if (add) { e.stopPropagation(); return COMMANDS[add.dataset.add](); }
    const h = e.target.closest('.sec-h');
    if (h) { const k = h.parentElement.dataset.sec; S.collapsed[k] = !S.collapsed[k]; localStorage.setItem('collapsed', JSON.stringify(S.collapsed)); h.parentElement.classList.toggle('open'); return; }
    const it = e.target.closest('.item'); if (!it) return;
    const k = it.dataset.kind;
    if (k === 'pr') select({ type: 'pr', id: +it.dataset.num });
    else if (k === 'issue') select({ type: 'issue', id: +it.dataset.num });
    else if (k === 'stash') select({ type: 'stash', id: it.dataset.hash, ref: it.dataset.ref });
    else selectHash(it.dataset.oid);
  };
  side.ondblclick = (e) => {
    const it = e.target.closest('.item'); if (!it) return;
    if (it.dataset.kind === 'local' && !it.classList.contains('current')) checkoutRef('local', it.dataset.name);
    if (it.dataset.kind === 'remote') checkoutRef('remote', it.dataset.name);
    if (it.dataset.kind === 'pr') prAction('prCheckout', S.prs.items.find((p) => p.number === +it.dataset.num));
    if (it.dataset.kind === 'worktree') openTab(it.dataset.path);
  };
  side.oncontextmenu = async (e) => {
    const grp = e.target.closest('.grp[data-remote]');
    if (grp) { e.preventDefault(); return remoteMenu(grp.dataset.remote); }
    const it = e.target.closest('.item'); if (!it) return;
    if (it.dataset.kind === 'issue') {
      e.preventDefault();
      const iss = S.issues.items.find((x) => x.number === +it.dataset.num);
      const c = await api.menu([{ id: 'branch', label: `Create branch for #${iss.number}` }, { id: 'open', label: 'Open in browser' }, { id: 'copy', label: 'Copy link' }]);
      if (c === 'branch') act('Create branch', () => G('issueBranch', { number: iss.number, title: iss.title }), { hud: { title: `Creating a branch for #${iss.number}`, icon: 'branch' }, undo: (r) => ({ kind: 'branchCreate', name: r.name, checkout: true, label: `create branch ${r.name}` }) });
      else if (c === 'open') api.external(iss.url);
      else if (c === 'copy') { api.copy(iss.url); toast('ok', 'Link copied', iss.url); }
      return;
    }
    if (it.dataset.kind === 'worktree') {
      e.preventDefault();
      const w = await api.menu([{ id: 'open', label: 'Open in a new tab' }, { id: 'reveal', label: 'Reveal in Finder' }, { type: 'separator' }, { id: 'remove', label: 'Remove worktree' }]);
      if (w === 'open') openTab(it.dataset.path);
      else if (w === 'reveal') api.revealFile(it.dataset.path, '.');
      else if (w === 'remove' && await confirmDanger('Remove this worktree?', `${it.dataset.path} is deleted (its branch is kept).`, 'Remove')) act('Worktree removed', () => G('removeWorktree', { path: it.dataset.path })).then(loadExtras);
      return;
    }
    e.preventDefault();
    const k = it.dataset.kind;
    if (['local', 'remote', 'tag'].includes(k)) refMenu(k, it.dataset.name);
    else if (k === 'stash') {
      const op = await api.menu([{ id: 'stashApply', label: 'Apply stash' }, { id: 'stashPop', label: 'Pop stash' }, { type: 'separator' }, { id: 'stashDrop', label: 'Drop stash' }]);
      if (op) stashAction(op, it.dataset.ref);
    } else if (k === 'pr') {
      const pr = S.prs.items.find((p) => p.number === +it.dataset.num);
      const op = await api.menu([{ id: 'prCheckout', label: 'Checkout PR branch' }, { id: 'prOpen', label: 'Open on GitHub' }, { type: 'separator' }, { id: 'prMerge', label: 'Merge…' }]);
      if (op) prAction(op, pr);
    }
  };
  $('#sideFilter').oninput = (e) => { S.sideQuery = e.target.value; renderSidebar(); };

  const detail = $('#detail');
  detail.onclick = async (e) => {
    const op = e.target.closest('[data-op]');
    const file = e.target.closest('.file');
    if (op && file) { e.stopPropagation(); return fileOp(op.dataset.op, file.dataset.path, !!file.dataset.untracked); }
    if (file && (file.dataset.resolve || file.dataset.cmpA)) return;
    if (file) return openDiff({ path: file.dataset.path, mode: file.dataset.mode, hash: file.dataset.hash, untracked: !!file.dataset.untracked, st: file.dataset.st });
    const cp = e.target.closest('[data-copy]'); if (cp) { api.copy(cp.dataset.copy); return toast('ok', 'SHA copied', cp.dataset.copy); }
    const go = e.target.closest('[data-goto]'); if (go) return selectHash(go.dataset.goto);
    const a = e.target.closest('[data-act]'); if (!a) return;
    const x = a.dataset.act;
    if (x === 'stageAll') act('Staged all', () => G('stageAll'), { quiet: true });
    else if (x === 'unstageAll') act('Unstaged all', () => G('unstageAll'), { quiet: true });
    else if (x === 'abort') { if (await confirmDanger(`Abort ${S.status.state}?`, '', 'Abort')) act('Aborted', () => G('abort')); }
    else if (x.startsWith('stash')) stashAction(x, S.sel.ref);
    else if (x.startsWith('pr')) prAction(x, S.prs.items.find((p) => p.number === S.sel.id));
    else commitAction({ checkoutCommit: 'checkout', branchHere: 'branch', cherryPick: 'cherry', revert: 'revert' }[x], S.sel.id, S.commits.find((c) => c.hash === S.sel.id));
  };
  detail.ondblclick = (e) => {
    const file = e.target.closest('.file[data-mode="unstaged"], .file[data-mode="staged"]');
    if (file && !e.target.closest('[data-op]')) fileOp(file.dataset.mode === 'staged' ? 'unstage' : 'stage', file.dataset.path);
  };

  $('#diffClose').onclick = closeDiff;
  $('#diffActions').onclick = (e) => { const b = e.target.closest('[data-dop]'); if (b && diffCtx) fileOp(b.dataset.dop, diffCtx.path, diffCtx.untracked); };


  document.addEventListener('keydown', (e) => {
    if (e.target.closest?.('input, textarea') || !$('#modalWrap').hidden) return;
    if (e.key === 'Escape') closeDiff();
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && S.list.length) {
      e.preventDefault();
      const cur = S.sel?.type === 'wip' ? S.byHash.get('WIP') : S.byHash.get(S.sel?.id) ?? -1;
      const i = Math.max(0, Math.min(S.list.length - 1, cur + (e.key === 'ArrowDown' ? 1 : -1)));
      const c = S.list[i];
      select(c.wip ? { type: 'wip' } : { type: 'commit', id: c.hash }, { scroll: true });
    }
  });

  // drag a folder onto the window to open it
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; const p = f && api.pathForFile(f); if (p) openRepo(p); });

  api.on('cmd', (c) => (S.info || ['identities', 'open', 'newTab', 'closeTab', 'nextTab', 'prevTab', 'undoKey', 'redoKey', 'terminal', 'toggleSidebar', 'toggleDetails'].includes(c)) && COMMANDS[c]?.());
  api.on('openPath', (p) => openTab(p));
  api.on('focus', () => S.info && reload({ soft: true }).catch(() => {}));

  // Lightweight polling: only re-render when the working tree actually changed.
  setInterval(async () => {
    if (!S.info || document.hidden || S.busy) return;
    try {
      const tab = S.tab;
      const st = await G('status');
      if (tab !== S.tab) return;
      if (sig(st) !== S.statusSig) {
        if (st.oid !== S.status?.oid || st.branch !== S.status?.branch) await reload();
        else { S.status = st; S.statusSig = sig(st); renderTop(); renderGraph(); if (S.sel?.type === 'wip' || !S.sel) renderDetail(); }
      }
    } catch {}
  }, 2500);
  setInterval(() => !document.hidden && loadPRs(), 90_000);
}

bind();
renderEmpty();
