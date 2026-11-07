// "New pull request" — connected to the repo's GitHub/GitLab account: exact base ← compare branches,
// live comparison (commits, files, mergeability), reviewers, assignees, labels, milestone, draft.

const PR = { meta: null, base: null, head: null, title: '', body: '', titleTouched: false, bodyTouched: false, reviewers: [], assignees: [], labels: [], milestone: '', draft: false, cmp: null, tab: 'write', cmpSeq: 0 };
const isGitLab = () => PR.meta?.provider === 'gitlab';
const word = () => (isGitLab() ? 'merge request' : 'pull request');
const avatarFor = (login) => PR.meta?.users.find((u) => u.login === login)?.avatar || (PR.meta?.provider === 'github' ? `https://github.com/${encodeURIComponent(login)}.png?size=64` : '');

async function openPrForm(pre = {}) {
  if (!S.info) return;
  if (S.status?.state) return hudInfo('Finish the operation in progress first', 'alert');
  Object.assign(PR, { meta: null, cmp: null, reviewers: [], assignees: [], labels: [], milestone: '', draft: false, titleTouched: false, bodyTouched: false, tab: 'write' });
  PR.head = pre.head || S.status.branch;
  $('#prWrap').hidden = false;
  $('#pr').innerHTML = '<div class="pr-loading"><span class="spinner"></span>Loading repository details…</div>';
  try { PR.meta = await G('prMeta'); } catch (e) {
    $('#pr').innerHTML = `<div class="pr-loading bad">${esc(e.message)}<div class="row-btns"><button class="btn" data-pr-close>Close</button><button class="btn" data-pr-accounts>Connect an account</button></div></div>`;
    return;
  }
  PR.base = pre.base && pre.base !== PR.head ? pre.base : PR.meta.defaultBranch;
  if (PR.base === PR.head) PR.base = PR.meta.remoteBranches.find((b) => b !== PR.head) || PR.base;
  renderPr();
  await refreshCompare();
  setTimeout(() => $('#prTitle')?.focus(), 30);
}
const closePr = () => { $('#prWrap').hidden = true; closePopover(); };

function defaultTitle() {
  const c = PR.cmp?.commits || [];
  if (c.length === 1) return c[0].subject;
  const name = (PR.head || '').replace(/^(\d+)-/, '').split('/').pop().replace(/[-_]+/g, ' ').trim();
  return name ? name[0].toUpperCase() + name.slice(1) : '';
}
function defaultBody() {
  const parts = [];
  if (PR.meta.template) parts.push(PR.meta.template.trim());
  const issue = (PR.head || '').match(/^(\d+)-/);
  if (issue) parts.push(`Closes #${issue[1]}`);
  return parts.join('\n\n');
}

async function refreshCompare() {
  const seq = ++PR.cmpSeq;
  PR.cmp = null;
  renderCompareLine();
  try {
    const c = await G('prCompare', { base: PR.base, head: PR.head });
    if (seq !== PR.cmpSeq) return;
    PR.cmp = c;
  } catch (e) { if (seq === PR.cmpSeq) PR.cmp = { error: e.message }; }
  if (!PR.titleTouched) { PR.title = defaultTitle(); const t = $('#prTitle'); if (t) t.value = PR.title; }
  if (!PR.bodyTouched) { PR.body = defaultBody(); const b = $('#prBody'); if (b && PR.tab === 'write') b.value = PR.body; }
  renderCompareLine();
  renderCommits();
  updateCreate();
}

function branchButton(role) {
  const name = role === 'base' ? PR.base : PR.head;
  return `<button class="pr-branch" data-pr-branch="${role}" title="${role === 'base' ? 'Branch to merge into' : 'Branch with your changes'}">
    <small>${role === 'base' ? 'base' : 'compare'}</small><b>${esc(name || 'choose…')}</b>${icon('chevron')}</button>`;
}

function renderPr() {
  const m = PR.meta;
  $('#pr').innerHTML = `
    <header class="sheet-h">
      <h2>${brand(m.provider === 'gitlab' ? 'gitlab' : 'github')}New ${word()}</h2>
      <span class="pr-repo">${esc(m.repo)}${m.account ? ` · as <b>${esc(m.account)}</b>` : ''}</span>
      <button class="icon-btn" data-pr-close title="Close (Esc)">${icon('x')}</button>
    </header>
    <div class="pr-branches">
      ${branchButton('base')}<span class="pr-arrow">${icon('right')}</span>${branchButton('head')}
      <div class="pr-check" id="prCheck"></div>
    </div>
    <div class="pr-main">
      <div class="pr-edit">
        <label class="pr-label" for="prTitle">Title</label>
        <input class="field pr-title" id="prTitle" value="${esc(PR.title)}" placeholder="Short summary of the change" spellcheck="true">
        <div class="pr-tabs seg"><button class="${PR.tab === 'write' ? 'on' : ''}" data-pr-tab="write">Write</button><button class="${PR.tab === 'preview' ? 'on' : ''}" data-pr-tab="preview">Preview</button></div>
        ${PR.tab === 'write'
          ? `<textarea class="field pr-body" id="prBody" placeholder="What does this change and why? Markdown supported.">${esc(PR.body)}</textarea>`
          : `<div class="md pr-preview">${md(PR.body)}</div>`}
        <details class="pr-commits" id="prCommits"></details>
      </div>
      <aside class="pr-side">
        ${sideBlock('reviewers', 'Reviewers', PR.reviewers.length ? PR.reviewers.map(personChip).join('') : '<span class="pr-none">No reviewers</span>')}
        ${sideBlock('assignees', 'Assignees', PR.assignees.length ? PR.assignees.map(personChip).join('') : `<span class="pr-none">No one${m.me ? ` · <a href="#" data-pr-self>assign yourself</a>` : ''}</span>`)}
        ${sideBlock('labels', 'Labels', PR.labels.length ? PR.labels.map(labelChip).join('') : '<span class="pr-none">None yet</span>')}
        ${m.milestones.length ? sideBlock('milestone', 'Milestone', PR.milestone ? `<span class="pr-chip">${icon('flag')}${esc(PR.milestone)}</span>` : '<span class="pr-none">No milestone</span>') : ''}
      </aside>
    </div>
    <footer class="pr-foot">
      <label class="check"><input type="checkbox" id="prDraft" ${PR.draft ? 'checked' : ''}> Create as draft <small>— not ready for review yet</small></label>
      <span class="grow"></span>
      <button class="btn" data-pr-close>Cancel</button>
      <button class="btn primary" id="prCreate" disabled>${icon('pr')}<span id="prCreateTxt">Create ${word()}</span></button>
    </footer>`;
  renderCompareLine();
  renderCommits();
  updateCreate();
}
const sideBlock = (key, label, content) => `<section class="pr-block"><button class="pr-block-h" data-pr-pick="${key}"><span>${label}</span>${icon('pencil')}</button><div class="pr-block-b">${content}</div></section>`;
const personChip = (login) => (login.includes('/')
  ? `<span class="pr-person team">${icon('users')}${esc(PR.meta.teams?.find((t) => t.slug === login)?.name || login)}</span>`
  : `<span class="pr-person">${avatar(login, login, avatarFor(login))}${esc(login)}</span>`);
const labelChip = (name) => { const l = PR.meta.labels.find((x) => x.name === name); return `<span class="label" style="color:#${esc(l?.color || '8b8fb5')};border-color:#${esc(l?.color || '8b8fb5')}66;background:#${esc(l?.color || '8b8fb5')}1a">${esc(name)}</span>`; };

function renderCompareLine() {
  const el = $('#prCheck');
  if (!el) return;
  const c = PR.cmp;
  if (PR.base === PR.head) { el.innerHTML = `<span class="pr-st bad">${icon('alert')}Choose two different branches</span>`; return; }
  if (!c) { el.innerHTML = '<span class="pr-st"><span class="spinner"></span>Comparing…</span>'; return; }
  if (c.error) { el.innerHTML = `<span class="pr-st bad">${icon('alert')}${esc(c.error)}</span>`; return; }
  if (!c.commits.length) { el.innerHTML = `<span class="pr-st">${icon('check')}${esc(PR.head)} has nothing new compared to ${esc(PR.base)}</span>`; return; }
  const merge = c.mergeable === 'clean' ? `<span class="pr-st ok">${icon('check')}Able to merge</span>`
    : c.mergeable === 'conflicts' ? `<span class="pr-st warn" title="${esc(c.conflicts.join('\n'))}">${icon('alert')}Conflicts in ${c.conflicts.length} file${c.conflicts.length > 1 ? 's' : ''} — you can still open it</span>` : '';
  const publish = !c.published ? `<span class="pr-st">${icon('push')}${esc(PR.head)} will be published to origin</span>`
    : c.unpushed > 0 ? `<span class="pr-st">${icon('push')}${c.unpushed} local commit${c.unpushed > 1 ? 's' : ''} will be pushed first</span>` : '';
  el.innerHTML = `${merge}<span class="pr-st muted">${c.commits.length} commit${c.commits.length > 1 ? 's' : ''} · ${c.files} file${c.files === 1 ? '' : 's'} <span class="add-c">+${c.additions}</span> <span class="del-c">−${c.deletions}</span></span>${publish}`;
}
function renderCommits() {
  const el = $('#prCommits');
  if (!el) return;
  const list = PR.cmp?.commits || [];
  el.hidden = !list.length;
  el.innerHTML = `<summary>${icon('commit')}${list.length} commit${list.length === 1 ? '' : 's'} in this ${word()}</summary>
    ${list.map((c) => `<div class="pr-cm">${avatar(c.author, c.author, c.avatar)}<span>${esc(c.subject)}</span><code>${short(c.hash)}</code></div>`).join('')}`;
}
function updateCreate() {
  const b = $('#prCreate');
  if (!b) return;
  const ok = PR.title.trim() && PR.base && PR.head && PR.base !== PR.head && PR.cmp && !PR.cmp.error && PR.cmp.commits.length;
  b.disabled = !ok;
  $('#prCreateTxt').textContent = PR.draft ? `Create draft ${word()}` : `Create ${word()}`;
}

function branchPicker(role, anchor) {
  const m = PR.meta;
  const names = [...new Set(role === 'base' ? m.remoteBranches : [...m.localBranches, ...m.remoteBranches])].sort((a, b) => (a === m.defaultBranch ? -1 : b === m.defaultBranch ? 1 : a.localeCompare(b)));
  const cur = role === 'base' ? PR.base : PR.head;
  const html = `<div class="pop-search">${icon('search')}<input id="prBrFilter" placeholder="Filter branches…" spellcheck="false" autocomplete="off"></div>
    <div class="pop-list">${names.map((n) => `<button class="pop-i br ${n === cur ? 'cur' : ''}" data-pick="${esc(n)}" data-name="${esc(n.toLowerCase())}">
      <span class="pop-ic">${icon(n === cur ? 'check' : 'branch')}</span><span class="pop-t"><b>${esc(n)}</b>${n === m.defaultBranch ? '<small>default branch</small>' : ''}${role === 'head' && !m.remoteBranches.includes(n) ? '<small>local only — will be published</small>' : ''}</span></button>`).join('')}</div>`;
  const pop = showPopover(anchor, html, (name) => {
    if (role === 'base') PR.base = name; else PR.head = name;
    renderPr();
    refreshCompare();
  }, { width: 320, focus: '#prBrFilter' });
  bindPopoverFilter(pop, '#prBrFilter', '.pop-i.br');
}

function listPicker(kind, anchor) {
  const m = PR.meta;
  const people = kind === 'reviewers' || kind === 'assignees';
  const items = kind === 'labels' ? m.labels.map((l) => ({ id: l.name, html: `<span class="dot" style="background:#${esc(l.color)}"></span><span class="pop-t"><b>${esc(l.name)}</b>${l.description ? `<small>${esc(l.description)}</small>` : ''}</span>` }))
    : kind === 'milestone' ? m.milestones.map((x) => ({ id: x.title, html: `<span class="pop-ic">${icon('flag')}</span><span class="pop-t"><b>${esc(x.title)}</b></span>` }))
    : [
      ...(kind === 'reviewers' ? (m.teams || []).map((t) => ({ id: t.slug, team: true, html: `<span class="team-ic">${icon('users')}</span><span class="pop-t"><b>${esc(t.name)}</b><small>${esc(t.slug)}${t.description ? ` — ${esc(t.description)}` : ''}</small></span>` })) : []),
      ...m.users.filter((u) => kind !== 'reviewers' || u.login !== m.me).map((u) => ({ id: u.login, html: `${avatar(u.login, u.login, u.avatar || avatarFor(u.login))}<span class="pop-t"><b>${esc(u.login)}</b>${u.name ? `<small>${esc(u.name)}</small>` : ''}${kind === 'assignees' && u.login === m.me ? '<small>you</small>' : ''}</span>` })),
    ];
  const render = () => `<div class="pop-search">${icon('search')}<input id="prListFilter" placeholder="${kind === 'reviewers' && m.teams?.length ? 'Search teams and people…' : people ? 'Search people…' : 'Filter…'}" spellcheck="false" autocomplete="off"></div>
    <div class="pop-list">${items.map((it, i) => `${it.team && i === 0 ? '<div class="pop-sub">Teams</div>' : ''}${!it.team && i > 0 && items[i - 1].team ? '<div class="pop-sub">People</div>' : ''}<button class="pop-i multi ${(kind === 'milestone' ? [PR.milestone] : PR[kind]).includes(it.id) ? 'on' : ''}" data-pick="${esc(it.id)}" data-name="${esc(it.id.toLowerCase())}">
      <span class="tick">${icon('check')}</span>${it.html}</button>`).join('') || `<div class="pop-sub">${people ? 'No one with access to this repository' : 'Nothing to choose from'}</div>`}</div>
    <div class="pop-foot">${kind === 'reviewers' ? 'People you ask to review this change.' : kind === 'assignees' ? 'People working on this change.' : kind === 'labels' ? 'Labels defined in this repository.' : 'Milestones open in this repository.'}</div>`;
  const pop = showPopover(anchor, render(), (id) => {
    if (kind === 'milestone') { PR.milestone = PR.milestone === id ? '' : id; closePopover(); renderPr(); return; }
    const arr = PR[kind];
    const i = arr.indexOf(id);
    if (i >= 0) arr.splice(i, 1); else arr.push(id);
    pop.querySelector(`.pop-i[data-pick="${CSS.escape(id)}"]`)?.classList.toggle('on', i < 0);
    renderSide();
  }, { width: 300, focus: '#prListFilter', keepOpen: kind !== 'milestone' });
  bindPopoverFilter(pop, '#prListFilter', '.pop-i.multi');
}
function renderSide() {
  // re-render the side panel only (keeps the title/body caret where it is)
  const side = $('.pr-side');
  if (!side) return;
  const tmp = document.createElement('div');
  const m = PR.meta;
  tmp.innerHTML = `${sideBlock('reviewers', 'Reviewers', PR.reviewers.length ? PR.reviewers.map(personChip).join('') : '<span class="pr-none">No reviewers</span>')}
    ${sideBlock('assignees', 'Assignees', PR.assignees.length ? PR.assignees.map(personChip).join('') : `<span class="pr-none">No one${m.me ? ' · <a href="#" data-pr-self>assign yourself</a>' : ''}</span>`)}
    ${sideBlock('labels', 'Labels', PR.labels.length ? PR.labels.map(labelChip).join('') : '<span class="pr-none">None yet</span>')}
    ${m.milestones.length ? sideBlock('milestone', 'Milestone', PR.milestone ? `<span class="pr-chip">${icon('flag')}${esc(PR.milestone)}</span>` : '<span class="pr-none">No milestone</span>') : ''}`;
  side.innerHTML = tmp.innerHTML;
}

async function submitPr() {
  const payload = { title: PR.title.trim(), body: PR.body, base: PR.base, head: PR.head, draft: PR.draft, reviewers: PR.reviewers, assignees: PR.assignees, labels: PR.labels, milestone: PR.milestone || undefined };
  const r = await act(`Create ${word()}`, () => G('prCreate', payload), { hud: { title: `Opening ${word()} ${PR.head} → ${PR.base}`, icon: 'pr' } });
  if (!r) return;
  closePr();
  await loadPRs();
  if (r.number) select({ type: 'pr', id: r.number });
}

function bindPr() {
  const wrap = $('#prWrap');
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap) return closePr();
    const t = e.target.closest('button, a, [data-pr-self]');
    if (!t) return;
    const d = t.dataset;
    if ('prClose' in d) return closePr();
    if ('prAccounts' in d) { closePr(); return openIdentities('accounts'); }
    if (d.prBranch) return branchPicker(d.prBranch, t);
    if (d.prPick) return listPicker(d.prPick, t);
    if ('prSelf' in d) { e.preventDefault(); if (PR.meta.me && !PR.assignees.includes(PR.meta.me)) PR.assignees.push(PR.meta.me); return renderSide(); }
    if (d.prTab) { PR.tab = d.prTab; return renderPr(); }
    if (t.id === 'prCreate') return submitPr();
  });
  wrap.addEventListener('input', (e) => {
    if (e.target.id === 'prTitle') { PR.title = e.target.value; PR.titleTouched = true; updateCreate(); }
    if (e.target.id === 'prBody') { PR.body = e.target.value; PR.bodyTouched = true; }
  });
  wrap.addEventListener('change', (e) => { if (e.target.id === 'prDraft') { PR.draft = e.target.checked; updateCreate(); } });
  document.addEventListener('keydown', (e) => {
    if ($('#prWrap').hidden) return;
    if (e.key === 'Escape' && $('#popover').hidden) { e.stopPropagation(); closePr(); }
    if (e.key === 'Enter' && modKey(e) && !$('#prCreate')?.disabled) { e.preventDefault(); submitPr(); }
  }, true);
}
bindPr();
