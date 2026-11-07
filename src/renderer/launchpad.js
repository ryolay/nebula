// "New tab" launchpad: recent repositories, open a folder, clone (URL or from a connected
// GitHub/GitLab account), or start a new repository.

const LP = { panel: 'clone', source: 'url', repos: {}, loading: {}, query: '', recent: [], cloneParent: '', home: '', accounts: [], form: { url: '', name: '' }, init: { name: '', readme: true } };
const tildeP = (p) => (LP.home && p?.startsWith(`${LP.home}/`) ? `~${p.slice(LP.home.length)}` : p);
const nameFromUrl = (u) => (u.trim().replace(/\/+$/, '').replace(/\.git$/, '').split(/[/:]/).pop() || '').replace(/[^A-Za-z0-9._-]/g, '-');

async function showLaunchpad() {
  $('#launchpad').hidden = false;
  document.body.classList.add('lp-on');
  renderLaunchpad();
  try {
    const [r, accs] = await Promise.all([api.recent(), api.accounts().catch(() => [])]);
    Object.assign(LP, { recent: r.recent, cloneParent: LP.cloneParent || r.cloneParent, home: r.home, accounts: accs });
  } catch (e) { console.warn(e); }
  if (S.tab?.kind === 'new') renderLaunchpad();
  setTimeout(() => $('#lpSearch')?.focus(), 30);
}
function hideLaunchpad() { $('#launchpad').hidden = true; document.body.classList.remove('lp-on'); }

function renderLaunchpad() {
  const q = LP.query.toLowerCase();
  const recent = LP.recent.filter((r) => !q || r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q));
  $('#launchpad').innerHTML = `<div class="lp">
    <div class="lp-hero">
      <div><h1>Open a repository</h1><p>Pick up where you left off, clone from GitHub or GitLab, or start something new.</p></div>
    </div>
    <div class="lp-grid">
      <section class="lp-card lp-recent">
        <div class="lp-card-h"><span>${icon('clock')}Recent</span><small>${LP.recent.length}</small></div>
        <div class="lp-search">${icon('search')}<input id="lpSearch" placeholder="Filter recent repositories…" value="${esc(LP.query)}" spellcheck="false" autocomplete="off"><kbd>↵</kbd></div>
        <div class="lp-list" id="lpRecent">${recent.map((r, i) => `
          <div class="lp-repo ${r.missing || r.notRepo ? 'gone' : ''} ${i === 0 && q ? 'first' : ''}" data-open="${esc(r.path)}" title="${esc(r.path)}">
            <span class="lp-logo">${brand(providerOf(r.remoteUrl || ''))}</span>
            <span class="lp-t"><b>${esc(r.name)}</b><small>${esc(tildeP(r.path))}</small></span>
            ${r.missing ? '<span class="pill red">missing</span>' : r.notRepo ? '<span class="pill amber">not a repo</span>' : r.branch ? `<span class="pill">${icon('branch')}${esc(r.branch)}</span>` : ''}
            ${r.mtime ? `<span class="lp-when">${ago(r.mtime / 1000)}</span>` : ''}
            <button class="icon-btn lp-forget" data-forget="${esc(r.path)}" title="Remove from recent">${icon('x')}</button>
          </div>`).join('') || `<div class="lp-empty">${q ? 'No match.' : 'Repositories you open show up here.'}</div>`}</div>
      </section>
      <section class="lp-side">
        <div class="lp-actions">
          <button class="lp-act" data-lp="open"><span class="lp-act-ic">${icon('folder')}</span><b>Open folder</b><small>Browse or drop a folder</small></button>
          <button class="lp-act ${LP.panel === 'clone' ? 'on' : ''}" data-lp="clone"><span class="lp-act-ic">${icon('pull')}</span><b>Clone</b><small>URL, GitHub or GitLab</small></button>
          <button class="lp-act ${LP.panel === 'init' ? 'on' : ''}" data-lp="init"><span class="lp-act-ic">${icon('sparkle')}</span><b>New repository</b><small>git init a folder</small></button>
        </div>
        <section class="lp-card lp-panel">${LP.panel === 'init' ? initPanel() : clonePanel()}</section>
      </section>
    </div>
    <div class="lp-drop">${icon('folder')}Drop a folder to open it</div>
  </div>`;
}

function clonePanel() {
  const sources = [['url', `${icon('external')}URL`], ...LP.accounts.map((a) => [a.id, `${brand(a.kind)}${esc(a.login)}`])];
  const acc = LP.accounts.find((a) => a.id === LP.source);
  return `<div class="lp-card-h"><span>${icon('pull')}Clone a repository</span></div>
    <nav class="lp-src">${sources.map(([id, label]) => `<button class="${LP.source === id ? 'on' : ''}" data-src="${esc(id)}">${label}</button>`).join('')}
      ${LP.accounts.length ? '' : '<button data-goto-accounts title="Connect GitHub or GitLab to browse your repositories">' + icon('plus') + 'Connect an account</button>'}</nav>
    ${acc ? accountRepos(acc) : `
      <label class="lp-field">Repository URL<input class="field" id="lpUrl" placeholder="https://github.com/owner/repo.git  ·  git@gitlab.com:group/project.git" value="${esc(LP.form.url)}" spellcheck="false" autocomplete="off"></label>`}
    <div class="lp-dest">
      <label class="lp-field grow">Clone into
        <span class="lp-path"><button class="btn sm" data-pick-parent>${icon('folder')}${esc(tildeP(LP.cloneParent) || 'Choose…')}</button><span>/</span><input class="field" id="lpName" placeholder="folder-name" value="${esc(LP.form.name)}" spellcheck="false" autocomplete="off"></span></label>
      <button class="btn primary" id="lpClone" ${LP.form.url && LP.form.name ? '' : 'disabled'}>${icon('pull')}Clone</button>
    </div>
    ${LP.form.via ? `<p class="hint">${esc(LP.form.via)}</p>` : '<p class="hint">Private repositories are cloned with the matching connected account — no password prompt.</p>'}`;
}

function accountRepos(acc) {
  const list = LP.repos[acc.id];
  if (!list) {
    if (!LP.loading[acc.id]) loadRepos(acc);
    return `<div class="lp-repos"><div class="lp-empty"><span class="spinner"></span> Loading ${esc(acc.login)}'s repositories…</div></div>`;
  }
  if (list.error) return `<div class="lp-repos"><div class="lp-empty bad">${esc(list.error)}</div></div>`;
  const q = (LP.repoQuery || '').toLowerCase();
  const rows = list.filter((r) => !q || r.fullName.toLowerCase().includes(q) || r.description.toLowerCase().includes(q));
  return `<div class="lp-search sm">${icon('search')}<input id="lpRepoSearch" placeholder="Search ${list.length} repositories…" value="${esc(LP.repoQuery || '')}" spellcheck="false" autocomplete="off"></div>
    <div class="lp-repos">${rows.slice(0, 200).map((r) => `
      <div class="lp-rrow ${LP.form.url === pickUrl(acc, r) ? 'on' : ''}" data-rr="${esc(r.fullName)}">
        <span class="lp-t"><b>${r.private ? icon('lock') : ''}${esc(r.fullName)}${r.fork ? ' <em>fork</em>' : ''}</b><small>${esc(r.description || 'No description')}</small></span>
        <span class="lp-when">${r.language ? `${esc(r.language)} · ` : ''}${ago(Date.parse(r.updatedAt) / 1000)}</span>
        <button class="btn sm lp-quick" data-quick="${esc(r.fullName)}">Clone</button>
      </div>`).join('') || '<div class="lp-empty">No repository matches.</div>'}</div>`;
}
// SSH alias when the account has one-click SSH set up, otherwise HTTPS with the account token
const pickUrl = (acc, r) => (acc.ssh?.ready ? `git@${acc.ssh.alias}:${r.fullName}.git` : r.https);
const viaText = (acc) => (acc.ssh?.ready ? `Will clone over SSH as ${acc.login} (Host ${acc.ssh.alias}).` : `Will clone over HTTPS with ${acc.login}'s token.`);

async function loadRepos(acc) {
  LP.loading[acc.id] = true;
  try { LP.repos[acc.id] = await api.accountRepos(acc.id); } catch (e) { LP.repos[acc.id] = { error: e.message }; }
  LP.loading[acc.id] = false;
  if (S.tab?.kind === 'new' && LP.source === acc.id) renderLaunchpad();
}

function initPanel() {
  return `<div class="lp-card-h"><span>${icon('sparkle')}New repository</span></div>
    <div class="lp-dest">
      <label class="lp-field grow">Create in
        <span class="lp-path"><button class="btn sm" data-pick-parent>${icon('folder')}${esc(tildeP(LP.cloneParent) || 'Choose…')}</button><span>/</span><input class="field" id="lpInitName" placeholder="my-new-project" value="${esc(LP.init.name)}" spellcheck="false" autocomplete="off"></span></label>
    </div>
    <label class="check"><input type="checkbox" id="lpReadme" ${LP.init.readme ? 'checked' : ''}> Add a README and an initial commit</label>
    <div class="row-btns left"><button class="btn primary" id="lpInit" ${LP.init.name ? '' : 'disabled'}>${icon('sparkle')}Create repository</button></div>
    <p class="hint">Runs <code>git init -b main</code>. You can publish it to GitHub or GitLab later from the Push menu.</p>`;
}

async function doClone(url, name, accountId) {
  const r = await act('Clone', async () => {
    const info = await api.clone({ url, parent: LP.cloneParent, name, accountId });
    return { info, summary: `Cloned ${name}` };
  }, { refresh: false, hud: { title: `Cloning ${name}`, icon: 'pull' } });
  if (r?.info) { LP.recent = []; await openTab(r.info.path, { replace: S.tab }); }
}

function bindLaunchpad() {
  const lp = $('#launchpad');
  let depth = 0; // show the drop target while a folder hovers the window
  document.addEventListener('dragenter', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { depth++; document.body.classList.add('dragging-folder'); } });
  document.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; document.body.classList.remove('dragging-folder'); } });
  document.addEventListener('drop', () => { depth = 0; document.body.classList.remove('dragging-folder'); }, true);
  lp.addEventListener('input', (e) => {
    const id = e.target.id;
    if (id === 'lpSearch') { LP.query = e.target.value; const pos = e.target.selectionStart; renderLaunchpad(); const s = $('#lpSearch'); s.focus(); s.setSelectionRange(pos, pos); }
    if (id === 'lpRepoSearch') { LP.repoQuery = e.target.value; const pos = e.target.selectionStart; renderLaunchpad(); const s = $('#lpRepoSearch'); s.focus(); s.setSelectionRange(pos, pos); }
    if (id === 'lpUrl') {
      const auto = !LP.form.name || LP.form.name === nameFromUrl(LP.form.url);
      LP.form.url = e.target.value; LP.form.via = '';
      if (auto) { LP.form.name = nameFromUrl(LP.form.url); $('#lpName').value = LP.form.name; }
      $('#lpClone').disabled = !(LP.form.url && LP.form.name);
    }
    if (id === 'lpName') { LP.form.name = e.target.value; $('#lpClone').disabled = !(LP.form.url && LP.form.name); }
    if (id === 'lpInitName') { LP.init.name = e.target.value; $('#lpInit').disabled = !LP.init.name; }
    if (id === 'lpReadme') LP.init.readme = e.target.checked;
  });
  lp.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (e.target.id === 'lpSearch') $('#lpRecent .lp-repo:not(.gone)')?.click();
    if (e.target.id === 'lpUrl' || e.target.id === 'lpName') $('#lpClone')?.click();
    if (e.target.id === 'lpInitName') $('#lpInit')?.click();
  });
  lp.addEventListener('click', async (e) => {
    const t = e.target.closest('button, [data-open], [data-rr]');
    if (!t) return;
    const d = t.dataset;
    if (d.forget) { e.stopPropagation(); await api.forgetRecent(d.forget); LP.recent = LP.recent.filter((r) => r.path !== d.forget); return renderLaunchpad(); }
    if (d.open) { if (t.classList.contains('gone')) return hudInfo('That folder is no longer a git repository', 'alert'); return openTab(d.open, { replace: S.tab }); }
    if (d.lp === 'open') return openTab(undefined, { replace: S.tab });
    if (d.lp) { LP.panel = d.lp; return renderLaunchpad(); }
    if (d.src) { LP.source = d.src; LP.form = { url: '', name: '' }; return renderLaunchpad(); }
    if ('gotoAccounts' in d) return openIdentities('accounts');
    if ('pickParent' in d) { const p = await api.pickFolder({ title: 'Choose where to put the repository' }); if (p) { LP.cloneParent = p; renderLaunchpad(); } return; }
    if (d.quick) {
      e.stopPropagation();
      const acc = LP.accounts.find((a) => a.id === LP.source);
      const r = LP.repos[acc.id].find((x) => x.fullName === d.quick);
      return doClone(pickUrl(acc, r), r.name, acc.id);
    }
    if (d.rr) {
      const acc = LP.accounts.find((a) => a.id === LP.source);
      const r = LP.repos[acc.id].find((x) => x.fullName === d.rr);
      LP.form = { url: pickUrl(acc, r), name: r.name, via: viaText(acc) };
      return renderLaunchpad();
    }
    if (t.id === 'lpClone') return doClone(LP.form.url.trim(), LP.form.name.trim(), LP.accounts.find((a) => a.id === LP.source)?.id);
    if (t.id === 'lpInit') {
      const r = await act('Create repository', async () => ({ info: await api.init({ parent: LP.cloneParent, name: LP.init.name.trim(), readme: LP.init.readme }), summary: `Created ${LP.init.name.trim()}` }),
        { refresh: false, hud: { title: `Creating ${LP.init.name}`, icon: 'sparkle' } });
      if (r?.info) { LP.init = { name: '', readme: true }; await openTab(r.info.path, { replace: S.tab }); }
    }
  });
}
bindLaunchpad();
