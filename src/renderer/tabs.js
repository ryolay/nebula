// Repository tabs, GitKraken-style toolbar menus, the action HUD and the search box.

// ===================================================================== tabs
const tabState = (t) => ({ sel: S.sel, draft: S.draft, limit: S.limit, query: S.query, scroll: $('#graphScroll').scrollTop, t });

function renderTabs() {
  const el = $('#tabs');
  el.innerHTML = S.tabs.map((t, i) => `<div class="tab ${t === S.tab ? 'active' : ''} ${t.kind === 'new' ? 'new' : ''}" draggable="true" data-i="${i}" title="${t.kind === 'new' ? 'New tab' : `${esc(t.path)}${t.branch ? `\n⎇ ${esc(t.branch)}` : ''}`}${i < 9 ? `\n⌘${i + 1}` : ''}">
      <span class="tab-logo">${t.kind === 'new' ? icon('sparkle') : brand(t.provider)}</span>
      <span class="tab-name">${t.kind === 'new' ? 'New Tab' : esc(t.info.name)}</span>
      ${t.dirty ? '<span class="tab-dirty" title="Uncommitted changes"></span>' : ''}
      <button class="tab-x" data-close="${i}" title="Close tab (⌘W)">${icon('x')}</button>
    </div>`).join('');
}
const saveTabs = () => api.saveTabs({ paths: S.tabs.filter((t) => t.kind !== 'new').map((t) => t.path), active: S.tab?.path || null });
function newTab() {
  const existing = S.tabs.find((t) => t.kind === 'new');
  if (existing) return activateTab(existing);
  const tab = { kind: 'new' };
  S.tabs.push(tab);
  return activateTab(tab);
}

async function activateTab(tab) {
  if (!tab || S.tab === tab) return;
  if (S.tab && S.tab.kind !== 'new') S.tab.ui = tabState();
  S.tab = tab;
  closePopover();
  if (tab.kind === 'new') {
    S.info = null;
    terminalTabChanged();
    $('#repoBtn').classList.add('empty');
    $('#repoName').textContent = 'New tab';
    $('#repoBranch').textContent = 'Open a repository';
    $('#idChip').hidden = true;
    $('#behindBadge').classList.remove('on'); $('#aheadBadge').classList.remove('on');
    renderTabs(); saveTabs();
    return showLaunchpad();
  }
  hideLaunchpad();
  $('#repoBtn').classList.remove('empty');
  S.info = tab.info;
  const ui = tab.ui || {};
  Object.assign(S, {
    multi: [], extras: null,
    sel: ui.sel || null, draft: ui.draft || { summary: '', body: '', amend: false }, limit: ui.limit || 600, query: ui.query || '',
    prs: { available: false, items: [] }, id: null, statusSig: '', matches: [], matchIdx: -1,
  });
  $('#search').value = S.query;
  $('#detail').dataset.view = '';
  closeDiff();
  renderTabs();
  saveTabs();
  S.busy++;
  try { await reload(); } catch (e) { toast('err', `Could not load ${tab.info.name}`, e.message); } finally { S.busy--; }
  if (S.tab !== tab) return;
  $('#graphScroll').scrollTop = ui.scroll || 0;
  loadPRs();
  terminalTabChanged();
}

async function openTab(dir, { activate = true, silent = false, replace } = {}) {
  let info;
  try { info = await api.open(dir); } catch (e) { if (!silent) toast('err', 'Not a git repository', e.message); return null; }
  if (!info) return null; // picker cancelled
  if (replace?.kind !== 'new') replace = S.tab?.kind === 'new' && activate ? S.tab : null; // a "New Tab" becomes the repo tab
  let tab = S.tabs.find((t) => t.path === info.path);
  if (tab && replace) { S.tabs.splice(S.tabs.indexOf(replace), 1); if (S.tab === replace) S.tab = null; }
  else if (!tab) {
    tab = { path: info.path, info, provider: providerOf(info.remoteUrl) };
    if (replace) { S.tabs[S.tabs.indexOf(replace)] = tab; if (S.tab === replace) S.tab = null; } else S.tabs.push(tab);
  }
  if (activate) await activateTab(tab); else renderTabs();
  saveTabs();
  return tab;
}

async function closeTab(tab) {
  const i = S.tabs.indexOf(tab);
  if (i === -1) return;
  if (tab.term?.alive && await api.term.busy(tab.term.id)
    && !(await confirmDanger(`Close ${tab.info.name}?`, 'A program is still running in its terminal and will be stopped.', 'Close tab'))) return;
  terminalTabClosed(tab);
  S.tabs.splice(i, 1);
  if (S.tab === tab) {
    S.tab = null;
    const next = S.tabs[i] || S.tabs[i - 1];
    if (next) await activateTab(next);
    else { S.info = null; await newTab(); } // never zero tabs: the launchpad is always there
  } else renderTabs();
  saveTabs();
}
const cycleTab = (d) => { if (S.tabs.length > 1) activateTab(S.tabs[(S.tabs.indexOf(S.tab) + d + S.tabs.length) % S.tabs.length]); };

async function initTabs() {
  const st = await api.state();
  const paths = st.tabs?.length ? st.tabs : st.last ? [st.last] : [];
  for (const p of paths) await openTab(p, { activate: false, silent: true });
  if (st.cli) { if (await openTab(st.cli)) return; }
  const first = S.tabs.find((t) => t.path === st.active) || S.tabs[0];
  if (first) await activateTab(first);
  else await newTab();
}

// background tabs: keep their "uncommitted changes" dot fresh
setInterval(async () => {
  if (document.hidden) return;
  for (const t of S.tabs) {
    if (t === S.tab || t.kind === 'new') continue;
    try { const st = await api.git('status', {}, t.path); t.dirty = st.files.length > 0; t.branch = st.branch; } catch {}
  }
  renderTabs();
}, 12000);

function bindTabs() {
  const el = $('#tabs');
  el.addEventListener('click', (e) => {
    const x = e.target.closest('[data-close]');
    if (x) { e.stopPropagation(); return closeTab(S.tabs[+x.dataset.close]); }
    const t = e.target.closest('.tab');
    if (t) activateTab(S.tabs[+t.dataset.i]);
  });
  el.addEventListener('auxclick', (e) => { const t = e.target.closest('.tab'); if (t && e.button === 1) closeTab(S.tabs[+t.dataset.i]); });
  let dragFrom = null;
  el.addEventListener('dragstart', (e) => { const t = e.target.closest('.tab'); if (!t) return; dragFrom = +t.dataset.i; t.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
  el.addEventListener('dragend', () => { dragFrom = null; $$('.tab').forEach((t) => t.classList.remove('dragging', 'drop-l', 'drop-r')); });
  el.addEventListener('dragover', (e) => {
    const t = e.target.closest('.tab'); if (dragFrom == null || !t) return;
    e.preventDefault(); e.stopPropagation();
    const r = t.getBoundingClientRect(), left = e.clientX < r.left + r.width / 2;
    $$('.tab').forEach((x) => x.classList.remove('drop-l', 'drop-r'));
    t.classList.add(left ? 'drop-l' : 'drop-r');
  });
  el.addEventListener('drop', (e) => {
    const t = e.target.closest('.tab'); if (dragFrom == null || !t) return;
    e.preventDefault(); e.stopPropagation();
    const r = t.getBoundingClientRect();
    let to = +t.dataset.i + (e.clientX < r.left + r.width / 2 ? 0 : 1);
    const [moved] = S.tabs.splice(dragFrom, 1);
    if (to > dragFrom) to--;
    S.tabs.splice(to, 0, moved);
    renderTabs(); saveTabs();
  });
  $('#tabNew').onclick = () => newTab();
  document.addEventListener('keydown', (e) => {
    if (modKey(e) && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
      const t = e.key === '9' ? S.tabs.at(-1) : S.tabs[+e.key - 1];
      if (t) { e.preventDefault(); activateTab(t); }
    }
  });
}

// ===================================================================== popovers (pull / push / branch)
const PULL_MODES = {
  fetch: { label: 'Fetch All', desc: 'Download from all remotes — your files stay untouched', icon: 'fetch' },
  ff: { label: 'Pull (fast-forward if possible)', desc: 'Merges if your branch and the remote diverged', icon: 'pull' },
  'ff-only': { label: 'Pull (fast-forward only)', desc: 'Never creates a merge commit', icon: 'pull' },
  rebase: { label: 'Pull (rebase)', desc: 'Replays your local commits on top of the remote', icon: 'merge' },
};
const pullMode = () => { try { return PULL_MODES[localStorage.getItem('pullMode')] ? localStorage.getItem('pullMode') : 'ff'; } catch { return 'ff'; } };
const tbBtn = (name) => $(`.toolbar [data-act="${name}"]`);
let popClose = null;

function showPopover(anchor, html, onPick, { width = 330, focus, keepOpen = false } = {}) {
  closePopover();
  const pop = $('#popover');
  pop.innerHTML = html;
  pop.style.width = `${width}px`;
  pop.hidden = false;
  const r = anchor.getBoundingClientRect();
  const left = Math.max(8, Math.min(r.left, innerWidth - width - 8));
  pop.style.left = `${left}px`;
  pop.style.top = `${r.bottom + 8}px`;
  pop.style.setProperty('--arrow', `${Math.max(14, Math.min(width - 14, r.left + r.width / 2 - left))}px`);
  anchor.classList.add('open');
  const onDown = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) closePopover(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closePopover(); } };
  const onClick = (e) => { const it = e.target.closest('[data-pick]'); if (it && !it.disabled) { const id = it.dataset.pick; if (!id.startsWith('default:') && !keepOpen) closePopover(); onPick(id, e); } };
  setTimeout(() => document.addEventListener('mousedown', onDown, true));
  document.addEventListener('keydown', onKey, true);
  pop.addEventListener('click', onClick);
  popClose = () => { document.removeEventListener('mousedown', onDown, true); document.removeEventListener('keydown', onKey, true); pop.removeEventListener('click', onClick); anchor.classList.remove('open'); };
  if (focus) setTimeout(() => pop.querySelector(focus)?.focus(), 20);
  return pop;
}
/** Type-to-filter for list popovers; Enter picks the first visible item. */
function bindPopoverFilter(pop, inputSel, itemSel) {
  const f = pop.querySelector(inputSel);
  f.oninput = () => { const q = f.value.toLowerCase(); pop.querySelectorAll(itemSel).forEach((b) => { b.hidden = !b.dataset.name.includes(q); }); };
  f.onkeydown = (e) => { if (e.key === 'Enter') pop.querySelector(`${itemSel}:not([hidden])`)?.click(); };
}
function closePopover() { popClose?.(); popClose = null; const p = $('#popover'); if (p) p.hidden = true; }

const menuItem = (id, { label, desc, icon: ic, radio, checked, danger, kbd, disabled }) => `
  <button class="pop-i ${danger ? 'danger' : ''}" data-pick="${id}" ${disabled ? 'disabled' : ''}>
    ${radio ? `<span class="pop-radio ${checked ? 'on' : ''}" data-pick="default:${id}" title="${checked ? 'Default for the Pull button' : 'Make this the Pull button default'}"></span>` : `<span class="pop-ic">${icon(ic)}</span>`}
    <span class="pop-t"><b>${esc(label)}</b>${desc ? `<small>${esc(desc)}</small>` : ''}</span>${kbd ? `<kbd>${kbd}</kbd>` : ''}
  </button>`;

function pullMenu(anchor) {
  const def = pullMode();
  const up = S.status?.upstream;
  const html = `<div class="pop-h">${icon('pull')}Pull ${up ? `<code>${esc(up)}</code>` : '<em>no upstream</em>'}</div>
    ${Object.entries(PULL_MODES).map(([id, m]) => menuItem(id, { ...m, radio: true, checked: id === def })).join('')}
    ${S.extras?.lfs?.used && S.extras.lfs.installed ? `<div class="pop-sep"></div>${menuItem('lfs', { label: 'Pull LFS files', desc: 'git lfs pull', icon: 'stash' })}` : ''}
    <div class="pop-foot">The ● option is what the Pull button does.</div>`;
  showPopover(anchor, html, (id) => {
    if (id.startsWith('default:')) {
      try { localStorage.setItem('pullMode', id.slice(8)); } catch {}
      $$('#popover .pop-radio').forEach((r) => r.classList.toggle('on', r.dataset.pick === id));
      tbBtn('pull').title = `${PULL_MODES[id.slice(8)].label} (⌘⇧L)`;
      return;
    }
    if (id === 'lfs') return act('LFS', () => G('lfsPull'), { hud: { title: 'Downloading LFS files', icon: 'stash' } });
    COMMANDS.pull(tbBtn('pull'), id);
  });
}

function pushMenu(anchor) {
  const st = S.status || {};
  const target = st.upstream || (st.branch ? `origin/${st.branch} (new)` : 'origin');
  const html = `<div class="pop-h">${icon('push')}Push <code>${esc(st.branch || 'HEAD')}</code> → <code>${esc(target)}</code></div>
    ${menuItem('push', { label: 'Push', desc: st.ahead ? `${st.ahead} commit${st.ahead > 1 ? 's' : ''} to send` : st.upstream ? 'Nothing new to send' : 'Publish this branch', icon: 'push', kbd: '⌘⇧P' })}
    ${menuItem('pr', { label: 'Push & create pull request', desc: 'Publish, then open a PR for this branch', icon: 'pr' })}
    ${menuItem('tags', { label: 'Push tags', desc: 'Send all local tags', icon: 'tag' })}
    <div class="pop-sep"></div>
    ${menuItem('force', { label: 'Force push (with lease)', desc: 'Overwrite the remote only if nobody else pushed', icon: 'alert', danger: true, disabled: !st.upstream })}`;
  showPopover(anchor, html, async (id) => {
    if (id === 'push') COMMANDS.push();
    else if (id === 'tags') COMMANDS.push(undefined, { tags: true });
    else if (id === 'pr') createPR();
    else if (id === 'force') {
      if (await confirmDanger(`Force push ${st.branch} to ${st.upstream}?`, 'Remote commits that are not in your branch will be replaced. --force-with-lease refuses if someone pushed since your last fetch.', 'Force push')) COMMANDS.push(undefined, { force: true });
    }
  });
}

function branchMenu(anchor) {
  const local = S.refs?.local || [];
  const remote = (S.refs?.remote || []).filter((r) => !local.some((l) => r.name.split('/').slice(1).join('/') === l.name));
  const row = (kind, b) => `<button class="pop-i br ${b.current ? 'cur' : ''}" data-pick="${kind}:${esc(b.name)}" data-name="${esc(b.name.toLowerCase())}">
      <span class="pop-ic">${icon(b.current ? 'check' : kind === 'remote' ? 'cloud' : 'branch')}</span><span class="pop-t"><b>${esc(b.name)}</b></span>
      ${b.ahead ? `<span class="ab up">↑${b.ahead}</span>` : ''}${b.behind ? `<span class="ab dn">↓${b.behind}</span>` : ''}</button>`;
  const html = `<div class="pop-search">${icon('search')}<input id="brFilter" placeholder="Switch branch…" spellcheck="false" autocomplete="off"></div>
    <div class="pop-list">${local.map((b) => row('local', b)).join('')}
      ${remote.length ? `<div class="pop-sub">Remote</div>${remote.map((b) => row('remote', b)).join('')}` : ''}</div>
    <div class="pop-sep"></div>${menuItem('new', { label: 'New branch…', icon: 'plus', kbd: '⌘B' })}`;
  const pop = showPopover(anchor, html, (id) => {
    if (id === 'new') return newBranch();
    const [kind, ...n] = id.split(':');
    const name = n.join(':');
    if (kind === 'local' && name === S.status?.branch) return;
    act(`Switch to ${name}`, async () => { await G('checkout', { ref: name, remote: kind === 'remote' }); return { summary: `Switched to ${kind === 'remote' ? name.split('/').slice(1).join('/') : name}` }; },
      { button: $('#repoBtn'), hud: { title: `Checking out ${name}`, icon: 'branch' }, undo: { kind: 'checkout', label: `checkout ${name}` } });
  }, { width: 320, focus: '#brFilter' });
  bindPopoverFilter(pop, '#brFilter', '.pop-i.br');
}

// ===================================================================== HUD
const HUD = { cur: null, timer: null, seq: 0 };
function hudShow(state, { iconName, title, sub, pct }) {
  const h = $('#hud');
  clearTimeout(HUD.timer);
  h.hidden = false;
  h.className = `hud ${state}`;
  void h.offsetWidth; // restart CSS animations
  h.classList.add('in');
  $('#hudIc').innerHTML = state === 'ok' ? '<svg class="hud-check" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>'
    : state === 'err' ? icon('x') : `${icon(iconName || 'sparkle')}${state === 'run' ? '<span class="hud-ring"></span>' : ''}`;
  $('#hudTitle').textContent = title;
  $('#hudSub').textContent = sub || '';
  const bar = $('#hudBar');
  bar.parentElement.classList.toggle('indet', state === 'run' && pct == null);
  bar.style.width = state === 'run' ? `${pct ?? 0}%` : '100%';
}
function hudStart({ title, icon: ic }, button) {
  const h = { id: ++HUD.seq, t0: performance.now(), title, icon: ic, button };
  HUD.cur = h;
  hudShow('run', { iconName: ic, title: `${title}…`, sub: 'Starting' });
  return h;
}
function hudProgress(p) {
  const h = HUD.cur;
  if (!h || (p.repo !== S.tab?.path && p.repo !== 'clone') || $('#hud').classList.contains('ok')) return;
  $('#hudSub').textContent = `${p.phase} · ${p.pct}%`;
  $('#hudBar').parentElement.classList.remove('indet');
  $('#hudBar').style.width = `${p.pct}%`;
}
const elapsed = (h) => { const ms = performance.now() - h.t0; return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`; };
function hudDone(h, summary) {
  if (HUD.cur !== h) return;
  const wait = Math.max(0, 450 - (performance.now() - h.t0)); // never flash: the loader is always seen
  setTimeout(() => {
    if (HUD.cur !== h) return;
    hudShow('ok', { title: summary, sub: `Done in ${elapsed(h)}` });
    HUD.timer = setTimeout(hideHud, 2600);
  }, wait);
}
function hudFail(h, title, message) {
  if (HUD.cur !== h) return;
  hudShow('err', { title, sub: (message || '').split('\n').find((l) => l.trim()) || '' });
  HUD.timer = setTimeout(hideHud, 5200);
}
function hudInfo(title, ic = 'sparkle') {
  HUD.cur = null;
  hudShow('info', { iconName: ic, title });
  HUD.timer = setTimeout(hideHud, 2200);
}
function hideHud() { const h = $('#hud'); h.classList.add('out'); setTimeout(() => { if (h.classList.contains('out')) { h.hidden = true; h.classList.remove('out'); } }, 260); }

// ===================================================================== search
function renderSearchCount() {
  const box = $('#searchBox'), n = S.matches.length;
  box.classList.toggle('has-q', !!S.query);
  box.classList.toggle('none', !!S.query && !n);
  $('#searchCount').textContent = !S.query ? '' : n ? `${S.matchIdx >= 0 ? S.matchIdx + 1 : 0}/${n}` : 'No results';
  $$('#rows .row.cur-hit').forEach((r) => r.classList.remove('cur-hit'));
  if (S.matchIdx >= 0) $(`#rows .row[data-i="${S.matches[S.matchIdx]}"]`)?.classList.add('cur-hit');
}
function gotoMatch(d, { selectIt = true } = {}) {
  const n = S.matches.length;
  if (!n) return;
  S.matchIdx = S.matchIdx < 0 ? (d > 0 ? 0 : n - 1) : (S.matchIdx + d + n) % n;
  const i = S.matches[S.matchIdx];
  if (selectIt) select({ type: 'commit', id: S.list[i].hash }, { scroll: false });
  scrollToRow(i, { center: true });
  renderSearchCount();
}
function bindSearch() {
  const s = $('#search');
  s.addEventListener('input', () => {
    S.query = s.value.trim();
    S.matchIdx = -1;
    applySearch();
    if (S.matches.length) gotoMatch(1, { selectIt: false }); // show the first hit immediately
  });
  s.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { s.value = ''; S.query = ''; S.matchIdx = -1; applySearch(); s.blur(); }
    if (e.key === 'Enter') { e.preventDefault(); gotoMatch(e.shiftKey ? -1 : 1); }
  });
  $('#searchNext').onclick = () => gotoMatch(1);
  $('#searchPrev').onclick = () => gotoMatch(-1);
}

// ===================================================================== wiring
function bindToolbar() {
  $$('.tb-caret[data-menu]').forEach((c) => {
    c.onclick = (e) => {
      e.stopPropagation();
      if (!S.info) return hudInfo('Open a repository first', 'folder');
      if (c.classList.contains('open')) return closePopover();
      (c.dataset.menu === 'pull' ? pullMenu : pushMenu)(c.closest('.tb-split'));
    };
  });
  $('#repoBtn').onclick = () => {
    if (!S.info) return openTab();
    if ($('#repoBtn').classList.contains('open')) return closePopover();
    branchMenu($('#repoBtn'));
  };
  api.on('git:progress', hudProgress);
}

// ---------- appearance: accent colour from View › Appearance (or the system accent) ----------
const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const luminance = (rgb) => { const [r, g, b] = rgb.map((v) => v / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const toHex = (rgb) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
/** Any accent (incl. the system one) gets a fill that keeps button text at WCAG AA (4.5:1). */
function applyAccent({ accent } = {}) {
  if (!/^#[0-9a-f]{6}$/i.test(accent || '')) return;
  const base = rgbOf(accent);
  const WHITE = [255, 255, 255], DARK = [17, 19, 24];
  let fill = base, on = WHITE;
  if (contrast(base, DARK) >= 7 && contrast(base, WHITE) < 4.5) on = DARK; // light accents: dark text
  else for (let k = 0; k <= 0.6 && contrast(fill, WHITE) < 4.5; k += 0.02) fill = base.map((v) => v * (1 - k));
  const root = document.documentElement.style;
  root.setProperty('--accent', accent);
  root.setProperty('--accent-fill', toHex(fill));
  root.setProperty('--on-accent', toHex(on));
}
api.appearance().then(applyAccent).catch(() => {});
api.on('appearance', applyAccent);

hydrateIcons();
bindTabs();
bindToolbar();
bindSearch();
// start once every script (terminal, power tools…) is loaded — order-independent
addEventListener('DOMContentLoaded', initTabs);
