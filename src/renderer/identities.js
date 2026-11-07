// Accounts & identities UI: top-bar chip, "committing as" bar + mismatch banner, and the manager sheet.

// identity/account calls also name the active tab's repository
const I = (name, args) => api.id(name, args, S.tab?.path);
const ID = { tab: 'repo', editing: null, login: null, ssh: null };
const SSH_STEPS = ['Create key', 'Add to ~/.ssh/config', 'Upload public key', 'Test connection'];
const profileById = (id) => S.id?.profiles?.find((p) => p.id === id) || null;
const accountById = (id) => S.id?.accounts?.find((a) => a.id === id) || null;
const dot = (p, cls = '') => `<span class="id-dot ${cls}" style="--c:${p?.color || '#6b6f94'}">${esc(initials(p?.label || p?.name || '?'))}</span>`;
const PROVIDER = { github: 'GitHub', gitlab: 'GitLab' };
// "inside ~/x" → "This repo is inside ~/x"; "remote matches a/*" → "This repo's remote matches a/*"
const shortPath = (p) => { if (!p || p.length <= 34) return p; const parts = p.replace(/\/+$/, '').split('/'); return `…/${parts.slice(-2).join('/')}`; };
const why = (r) => (r.startsWith('remote ') ? `This repo’s remote ${r.slice(7)}` : `This repo is inside ${shortPath(r.replace(/^inside /, ''))}`);

async function loadIdentity() {
  if (!S.info) return;
  try { S.id = await I('state'); } catch (e) { S.id = null; console.warn(e); return; }
  renderIdChip();
  renderIdentityBar();
  if (!$('#sheetWrap').hidden) renderSheet();
}

function currentIdentity() {
  const eff = S.id?.effective;
  if (!eff) return null;
  const profile = profileById(S.id.currentProfileId);
  const scope = eff.email?.scope;
  const source = !eff.email ? 'not set' : scope === 'local' ? 'this repo' : eff.email.included ? eff.email.file.split('/').pop() : scope === 'global' ? 'global default' : scope;
  return { profile, name: eff.name?.value || '', email: eff.email?.value || '', source, scope };
}

// ---------- top bar chip ----------
function renderIdChip() {
  const chip = $('#idChip');
  const cur = currentIdentity();
  if (!cur) { chip.hidden = true; return; }
  chip.hidden = false;
  chip.classList.toggle('warn', !!S.id.mismatch || !cur.email);
  chip.innerHTML = `${cur.profile ? dot(cur.profile) : `<span class="id-dot" style="--c:#6b6f94">${icon('user')}</span>`}
    <span class="id-text"><b>${esc(cur.profile?.label || cur.name || 'No identity')}</b><small>${esc(cur.email || 'user.email not set')}</small></span>
    ${S.id.mismatch || !cur.email ? `<span class="id-warn">${icon('alert')}</span>` : ''}`;
  chip.title = `Committing as ${cur.name} <${cur.email}> — from ${cur.source}`;
}

// ---------- composer bar + mismatch banner ----------
function renderIdentityBar() {
  const bar = $('#idBar'), banner = $('#idBanner');
  if (!bar || !S.id?.effective) return;
  const cur = currentIdentity();
  bar.innerHTML = `<button class="as-btn ${S.id.mismatch || !cur.email ? 'warn' : ''}" id="asBtn" title="${esc(`${cur.name} <${cur.email}> — ${cur.source}`)}
Click to change the identity for this repository">
      ${cur.profile ? dot(cur.profile) : `<span class="id-dot" style="--c:#6b6f94">${icon('user')}</span>`}
      <span class="as-who"><span class="as-l">Committing as${cur.profile ? ` · ${esc(cur.profile.label)}` : ''}</span><b>${esc(cur.email || 'no email configured')}</b><small>${esc(cur.name || '')}</small></span>
      <span class="as-src" title="${esc(S.id.effective.email?.file || '')}">${esc(cur.source)}</span>${icon('chevron')}
    </button>`;
  const sug = S.id.suggestion && profileById(S.id.suggestion.profileId);
  if (banner) {
    banner.innerHTML = S.id.mismatch && sug ? `<div class="id-banner">${icon('alert')}
        <div><b>Wrong identity for this repo?</b><span>${esc(why(S.id.suggestion.reason))}, which uses ${dot(sug, 'xs')} <b>${esc(sug.label)}</b> · ${esc(sug.email)}.<br>You would commit as <b>${esc(cur.email || 'nobody')}</b>.</span>
        <button class="btn sm primary" data-use-profile="${sug.id}">${icon('check')}Use ${esc(sug.label)}</button></div></div>`
      : !cur.email ? `<div class="id-banner">${icon('alert')}<div><b>No commit identity</b><span>git doesn't know who you are in this repository yet.</span></div><button class="btn sm primary" data-open-sheet="identities">Set up</button></div>` : '';
  }
  const go = $('#cGo');
  if (go) go.classList.toggle('warn', !!S.id.mismatch);
}

async function useProfile(id) {
  const p = profileById(id);
  const r = await act(`Now committing as ${p.label}`, () => I('useInRepo', { id }), { refresh: false, quiet: true });
  if (r) toast('ok', `Now committing as ${p.label}`, r.mode === 'inherited' ? `Removed this repo's override — it follows ${r.file} again.` : `${p.email} · saved in this repo's .git/config`);
  await loadIdentity();
}

async function identityMenu() {
  const cur = currentIdentity();
  const items = (S.id.profiles || []).map((p) => ({ id: `use:${p.id}`, label: `${p.id === cur?.profile?.id ? '✓ ' : '    '}${p.label} — ${p.email}` }));
  const choice = await api.menu([
    ...items,
    ...(items.length ? [{ type: 'separator' }] : []),
    { id: 'clear', label: 'Use the default identity for this repo', enabled: cur?.scope === 'local' },
    { id: 'new', label: 'New identity…' },
    { id: 'manage', label: 'Accounts & Identities…' },
  ]);
  if (!choice) return;
  if (choice.startsWith('use:')) useProfile(choice.slice(4));
  else if (choice === 'clear') { await act('Reset to default identity', () => I('clearRepo'), { refresh: false }); loadIdentity(); }
  else if (choice === 'new') { ID.editing = 'new'; openIdentities('identities'); }
  else openIdentities();
}

// ---------- the sheet ----------
function openIdentities(tab) {
  if (tab) ID.tab = tab;
  if (!S.info && ID.tab === 'repo') ID.tab = 'identities';
  $('#sheetWrap').hidden = false;
  renderSheet();
  I('state').then((st) => { S.id = st; renderSheet(); renderIdChip(); }).catch(() => {});
}
function closeSheet() { $('#sheetWrap').hidden = true; ID.editing = null; if (ID.login) I('githubCancel'); }

function renderSheet() {
  const s = $('#sheet');
  const tabs = [['repo', 'This repository', 'folder'], ['identities', 'Identities', 'user'], ['accounts', 'Accounts', 'cloud']];
  s.innerHTML = `<header class="sheet-h"><h2>${icon('sparkle')}Accounts &amp; Identities</h2>
      <nav class="seg">${tabs.map(([k, l, ic]) => `<button class="${ID.tab === k ? 'on' : ''}" data-tab="${k}" ${k === 'repo' && !S.info ? 'disabled' : ''}>${icon(ic)}${l}</button>`).join('')}</nav>
      <button class="icon-btn" data-close title="Close (Esc)">${icon('x')}</button></header>
    <div class="sheet-b">${!S.id ? '<div class="diff-empty">Loading…</div>' : ID.tab === 'repo' ? repoTab() : ID.tab === 'identities' ? identitiesTab() : accountsTab()}</div>`;
}

function repoTab() {
  const st = S.id, cur = currentIdentity(), r = st.remote, rt = st.routing;
  const sug = st.suggestion && profileById(st.suggestion.profileId);
  const accOnHost = (st.accounts || []).filter((a) => r && a.host === r.host);
  const sourceExplain = !cur?.email ? 'Not configured anywhere.'
    : cur.scope === 'local' ? 'Set in this repository (.git/config).'
    : cur.source !== 'global default' ? `Inherited from ${st.effective.email.file} through an includeIf folder rule.` : 'Inherited from your global ~/.gitconfig.';
  return `
  <section class="card">
    <div class="card-h"><span>${icon('user')}Commit identity</span>${cur?.scope === 'local' ? '<button class="btn sm" data-clear-repo>Use default</button>' : ''}</div>
    <div class="who big">${cur?.profile ? dot(cur.profile, 'lg') : avatar(cur?.name || '?', cur?.email, null, 'lg')}
      <div class="meta"><b>${esc(cur?.name || 'Unknown')}</b><small>${esc(cur?.email || 'no email')}</small><small class="src">${esc(sourceExplain)}</small></div></div>
    ${st.mismatch && sug ? `<div class="id-banner inline">${icon('alert')}<div><span>${esc(why(st.suggestion.reason))} → expected ${dot(sug, 'xs')} <b>${esc(sug.label)}</b> · ${esc(sug.email)}</span></div><button class="btn sm primary" data-use-profile="${sug.id}">Use ${esc(sug.label)}</button></div>` : ''}
    <div class="pick">${(st.profiles || []).map((p) => `<button class="pick-i ${p.id === cur?.profile?.id ? 'on' : ''}" data-use-profile="${p.id}">${dot(p)}<span class="pt"><b>${esc(p.label)}</b><small>${esc(p.email)}</small></span>${p.id === cur?.profile?.id ? icon('check') : ''}</button>`).join('')}
      <button class="pick-i add" data-new-profile>${icon('plus')}<span class="pt"><b>New identity</b><small>name + email</small></span></button></div>
    <p class="hint">Choosing an identity here writes <code>user.name</code> / <code>user.email</code> to this repository's <code>.git/config</code> — the terminal and your editor will use it too.</p>
  </section>
  <section class="card">
    <div class="card-h"><span>${icon('cloud')}Hosting account</span>${rt?.provider ? `<span class="pill prov-pill">${brand(rt.provider)}${PROVIDER[rt.provider]}</span>` : ''}</div>
    ${!r ? '<p class="hint">This repository has no remote.</p>' : `
      <div class="remote-line">${brand(rt?.provider || providerOf(r.url || ''))}<code>${esc(r.host)}/${esc(r.path)}</code><span class="pill">${r.sshAlias ? `SSH · ${esc(r.sshAlias)}` : r.protocol.toUpperCase()}</span>${transportAction(st, r)}</div>
      ${accOnHost.length ? `<div class="pick">
          <button class="pick-i ${!rt?.pinned ? 'on' : ''}" data-repo-account="">${icon('sparkle')}<span class="pt"><b>Automatic</b><small>${rt?.provider === 'github' ? 'the active gh account' : 'first account for this host'}</small></span>${!rt?.pinned ? icon('check') : ''}</button>
          ${accOnHost.map((a) => `<button class="pick-i ${rt?.pinned && rt.accountId === a.id ? 'on' : ''}" data-repo-account="${esc(a.id)}"><span class="av-wrap">${avatar(a.login, a.login, a.avatar)}<span class="av-badge">${brand(a.kind)}</span></span><span class="pt"><b>${esc(a.login)}</b><small>${esc(a.host)}${a.active ? ' · active in gh' : ''}</small></span>${rt?.pinned && rt.accountId === a.id ? icon('check') : ''}</button>`).join('')}
        </div>
        <p class="hint">Nebula uses this account for ${rt?.provider === 'gitlab' ? 'merge requests' : 'pull requests'}${r.protocol === 'https' ? ', fetch, pull and push' : ''} in this repo only — your global <code>gh</code> account is never switched.${r.protocol === 'ssh' ? ' This remote uses SSH, so git itself authenticates with your SSH key.' : ''}</p>`
      : `<p class="hint">No ${esc(r.host)} account connected.</p><button class="btn primary" data-goto-accounts>${icon('plus')}Connect an account</button>`}
      ${rt?.pinnedMissing ? `<div class="id-banner inline">${icon('alert')}<div><span>The account pinned for this repo is no longer signed in.</span></div></div>` : ''}`}
  </section>`;
}

function transportAction(st, r) {
  const acc = accountById(st.routing?.accountId);
  if (!acc) return '';
  if (r.sshAlias) return '<button class="btn sm" data-https-remote>Use HTTPS</button>';
  if (r.protocol === 'https') return acc.ssh?.ready
    ? `<button class="btn sm" data-ssh-remote="${esc(acc.id)}" title="git@${esc(acc.ssh.alias)}:${esc(r.path)}.git">${icon('laptop')}Use SSH as ${esc(acc.login)}</button>`
    : `<button class="btn sm" data-ssh-setup-repo="${esc(acc.id)}">${icon('sparkle')}Set up SSH</button>`;
  return '';
}

function identitiesTab() {
  const st = S.id;
  if (ID.editing) return editForm(ID.editing === 'new' ? null : profileById(ID.editing));
  const cur = currentIdentity();
  return `<div class="id-grid">${(st.profiles || []).map((p) => {
    const acc = accountById(p.account);
    return `<article class="id-card" style="--c:${p.color}">
      <div class="id-card-h">${dot(p, 'lg')}<div><b>${esc(p.label)}</b><small>${esc(p.name)}</small><small class="mono">${esc(p.email)}</small></div>
        <span class="grow"></span><button class="icon-btn" data-edit-profile="${p.id}" title="Edit">${icon('pencil')}</button><button class="icon-btn" data-delete-profile="${p.id}" title="Delete">${icon('trash')}</button></div>
      <div class="chips">
        ${st.globalEmail && st.globalEmail.toLowerCase() === p.email.toLowerCase() ? '<span class="chip star">Global default</span>' : ''}
        ${cur?.profile?.id === p.id ? '<span class="chip on">used in this repo</span>' : ''}
        ${acc ? `<span class="chip">${icon('cloud')}${esc(acc.login)}@${esc(acc.host)}</span>` : ''}
        ${p.folders.map((f) => `<span class="chip" title="Every repo in ${esc(f)}">${icon('folder')}${esc(shortPath(f))}</span>`).join('')}
        ${p.remotes.map((r) => `<span class="chip">${icon('branch')}${esc(r)}</span>`).join('')}
        ${p.signingKey ? `<span class="chip">${icon('check')}signed</span>` : ''}
        ${p.importedFrom ? `<span class="chip dim" title="Imported from ${esc(p.importedFrom)}">${esc(p.importedFrom.split('/').pop())}</span>` : ''}
      </div>
      <div class="id-actions">
        ${S.info ? `<button class="btn sm" data-use-profile="${p.id}">Use in this repo</button>` : ''}
        <button class="btn sm" data-folder-rule="${p.id}" title="Every repo inside a folder uses this identity (git includeIf)">${icon('folder')}Folder rule…</button>
        ${st.globalEmail?.toLowerCase() === p.email.toLowerCase() ? '' : `<button class="btn sm" data-set-global="${p.id}" title="git config --global">Make default</button>`}
      </div></article>`;
  }).join('')}
    <button class="id-card add" data-new-profile>${icon('plus')}<b>New identity</b><small>Work, personal, open-source…</small></button></div>
    <p class="hint">Identities were imported from your git config, including <code>includeIf</code> files. Rules decide which identity a repo <i>should</i> use; Nebula warns you before you commit with the wrong one.</p>`;
}

function editForm(p) {
  const v = p || { label: '', name: currentIdentity()?.name || '', email: '', signingKey: '', color: '#8b5cf6', account: null, remotes: [], folders: [] };
  const colors = ['#8b5cf6', '#22d3ee', '#f472b6', '#a3e635', '#fbbf24', '#fb7185', '#2dd4bf', '#60a5fa'];
  return `<form class="id-form" id="idForm">
    <h3>${p ? `Edit ${esc(p.label)}` : 'New identity'}</h3>
    <div class="two"><label>Label<input class="field" name="label" value="${esc(v.label)}" placeholder="Work" required></label>
      <label>Colour<div class="swatches">${colors.map((c) => `<label class="sw" style="--c:${c}"><input type="radio" name="color" value="${c}" ${v.color === c ? 'checked' : ''}><i></i></label>`).join('')}</div></label></div>
    <div class="two"><label>Name<input class="field" name="name" value="${esc(v.name)}" placeholder="Ada Lovelace" required></label>
      <label>Email<input class="field" name="email" type="email" value="${esc(v.email)}" placeholder="ada@company.com" required></label></div>
    <label>Hosting account <small>used for PRs &amp; pushes in repos with this identity</small>
      <select class="field" name="account"><option value="">None</option>${(S.id.accounts || []).map((a) => `<option value="${esc(a.id)}" ${v.account === a.id ? 'selected' : ''}>${esc(PROVIDER[a.kind])} · ${esc(a.login)}@${esc(a.host)}</option>`).join('')}</select></label>
    <label>Remote rules <small>one per line, e.g. <code>github.com/acme/*</code> or <code>gitlab.com/team/**</code></small>
      <textarea class="field" name="remotes" placeholder="github.com/my-company/*">${esc(v.remotes.join('\n'))}</textarea></label>
    <label>Signing key <small>optional — GPG key id or SSH public key path</small><input class="field" name="signingKey" value="${esc(v.signingKey)}" placeholder="~/.ssh/id_ed25519.pub"></label>
    <div class="row-btns"><button type="button" class="btn" data-cancel-edit>Cancel</button><button class="btn primary">${p ? 'Save' : 'Create identity'}</button></div>
    <input type="hidden" name="profileId" value="${esc(p?.id || '')}">
  </form>`;
}

function sshProgress(a) {
  const st = ID.ssh;
  return `<div class="ssh-run"><ol>${SSH_STEPS.map((label, i) => {
    const state = st.steps[i] || 'todo';
    const mark = state === 'done' ? icon('check') : state === 'fail' ? icon('x') : state === 'todo' ? '' : '<span class="spinner"></span>';
    return `<li class="${state}"><span class="mk">${mark}</span>${esc(label === 'Upload public key' ? `Upload to ${PROVIDER[a.kind]}` : label)}</li>`;
  }).join('')}</ol>
    ${st.code ? `<div class="device sm"><p>${PROVIDER[a.kind]} needs a one-time permission to add SSH keys. Enter this code:</p><div class="code">${esc(st.code)}</div>
      <div class="row-btns left"><button class="btn primary sm" data-copy-code>${icon('copy')}Copy &amp; open GitHub</button><button class="btn sm" data-cancel-login>Cancel</button></div></div>` : ''}
    ${st.detail ? `<p class="hint ${st.failed ? 'bad' : ''}">${esc(st.detail)}</p>` : ''}</div>`;
}

function accountsTab() {
  const accs = S.id.accounts || [];
  const gh = accs.filter((a) => a.kind === 'github'), gl = accs.filter((a) => a.kind === 'gitlab');
  const sshBadge = (a) => (ID.ssh?.id === a.id ? '' : a.ssh?.ready
    ? `<span class="pill green" title="${esc(a.ssh.keyFile)} · Host ${esc(a.ssh.alias)}">${icon('check')}SSH</span>`
    : `<button class="btn sm" data-ssh-setup="${esc(a.id)}" title="Generate a key, configure ~/.ssh/config and upload it — one click">${icon('sparkle')}Set up SSH</button>`);
  const row = (a) => `<div class="acc-wrap"><div class="acc"><span class="av-wrap">${avatar(a.login, a.login, a.avatar)}<span class="av-badge">${brand(a.kind)}</span></span><div class="meta"><b>${esc(a.login)}</b><small>${esc(a.host)}${a.ssh?.ready ? ` · ssh ${esc(a.ssh.alias)}` : ''}</small></div>
      ${sshBadge(a)}
      ${a.active ? '<span class="pill green">active in gh</span>' : a.kind === 'github' ? `<button class="btn sm" data-gh-switch="${esc(a.host)}|${esc(a.login)}" title="Make this the active account for the gh CLI">Make active</button>` : ''}
      ${a.ok === false ? '<span class="pill red">token invalid</span>' : ''}
      <button class="icon-btn" ${a.kind === 'github' ? `data-gh-logout="${esc(a.host)}|${esc(a.login)}"` : `data-gl-remove="${esc(a.id)}"`} title="Sign out">${icon('trash')}</button></div>
      ${ID.ssh?.id === a.id ? sshProgress(a) : ''}</div>`;
  const login = ID.login;
  return `
  <section class="card">
    <div class="card-h"><span class="prov">${brand('github')}GitHub</span><small>via the GitHub CLI · tokens stay in the macOS keychain</small></div>
    ${gh.map(row).join('') || '<p class="hint">No GitHub account yet.</p>'}
    ${login ? `<div class="device">
        ${login.code ? `<p>Enter this code on GitHub:</p><div class="code">${esc(login.code)}</div>
          <div class="row-btns left"><button class="btn primary" data-copy-code>${icon('copy')}Copy &amp; open GitHub</button><button class="btn" data-cancel-login>Cancel</button></div>
          <p class="hint"><span class="spinner"></span> Waiting for you to authorize in the browser…</p>`
        : `<p class="hint"><span class="spinner"></span> Starting GitHub sign-in…</p><div class="row-btns left"><button class="btn" data-cancel-login>Cancel</button></div>`}</div>`
      : `<div class="row-btns left"><button class="btn primary" data-gh-login="github.com">${icon('plus')}Add GitHub account</button>
          <button class="btn" data-gh-login-enterprise>GitHub Enterprise…</button></div>`}
  </section>
  <section class="card">
    <div class="card-h"><span class="prov">${brand('gitlab')}GitLab</span><small>gitlab.com or self-managed · personal access token, encrypted with the keychain</small></div>
    ${gl.map(row).join('') || '<p class="hint">No GitLab account yet.</p>'}
    <form class="gl-form" id="glForm">
      <input class="field" name="baseUrl" value="https://gitlab.com" spellcheck="false">
      <input class="field" name="token" type="password" placeholder="glpat-…" autocomplete="off">
      <button class="btn">${icon('plus')}Add</button>
    </form>
    <p class="hint">Create a token with the <code>api</code> and <code>read_user</code> scopes: <a href="#" data-gl-token-link>open GitLab token page</a>.</p>
  </section>`;
}

async function setupSSH(id) {
  ID.ssh = { id, steps: [], code: null, detail: '' };
  renderSheet();
  try {
    const r = await I('setupSSH', { id });
    if (!r) { ID.ssh = null; return renderSheet(); } // cancelled in the confirmation dialog
    toast('ok', 'SSH is ready', `Host ${r.alias} → ${r.keyFile}`);
    ID.ssh = null;
  } catch (e) {
    ID.ssh = { ...ID.ssh, failed: true, code: null, detail: e.message };
    toast('err', 'SSH setup failed', e.message);
  }
  await loadIdentity();
  renderSheet();
}


// ---------- sheet actions, keyed by the data-* attribute on the clicked control ----------
const refreshAll = async () => { await loadIdentity(); loadPRs(); };
const view = (tab, editing = null) => { if (tab) ID.tab = tab; ID.editing = editing; renderSheet(); };
async function githubLoginFlow(host) {
  if (!host) {
    const v = await modal({ title: 'GitHub Enterprise', iconName: 'cloud', ok: 'Continue', fields: [{ name: 'host', label: 'Hostname', placeholder: 'github.mycompany.com' }] });
    if (!v?.host) return;
    host = v.host.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  }
  ID.login = { host };
  renderSheet();
  try {
    const acc = await I('githubLogin', { host });
    toast('ok', 'GitHub account connected', acc ? `${acc.login} @ ${acc.host}` : '');
  } catch (err) { if (!/cancel/i.test(err.message)) toast('err', 'GitHub sign-in failed', err.message); }
  ID.login = null;
  await refreshAll();
  renderSheet();
}
async function chooseRepoAccount(id) {
  const acc = accountById(id);
  if (id && S.id.remote?.sshAlias) { // an SSH-alias remote: switching account means switching alias
    if (acc?.ssh?.ready) { await act(`Now using ${acc.login} over SSH`, () => I('useSSHRemote', { id: acc.id }), { refresh: false }); return refreshAll(); }
    ID.tab = 'accounts';
    return setupSSH(acc.id);
  }
  await act('Account updated for this repo', () => I('setRepoAccount', { id: id || null }), { refresh: false, quiet: true });
  return refreshAll();
}
async function addFolderRule(id) {
  const folder = await I('pickFolder');
  if (!folder) return;
  const ok = await act('Folder rule added', () => I('folderApply', { id, folder }), { refresh: false, quiet: true });
  if (ok) { toast('ok', 'Folder rule added', `Every repo in ${folder} now uses this identity.`); await loadIdentity(); }
}
const splitAccount = (v) => { const [host, login] = v.split('|'); return { host, login }; };
const SHEET_ACTIONS = {
  close: () => closeSheet(),
  tab: (tab) => view(tab),
  useProfile: async (id) => { await useProfile(id); renderSheet(); },
  newProfile: () => view('identities', 'new'),
  editProfile: (id) => view(null, id),
  cancelEdit: () => view(null),
  deleteProfile: async (id) => { if (await I('deleteProfile', { id })) { await loadIdentity(); renderSheet(); } },
  setGlobal: async (id) => { if (await act('Global identity updated', () => I('setGlobal', { id }), { refresh: false, quiet: true })) await loadIdentity(); },
  folderRule: (id) => addFolderRule(id),
  clearRepo: async () => { await act('Using the default identity', () => I('clearRepo'), { refresh: false }); await loadIdentity(); },
  repoAccount: (id) => chooseRepoAccount(id),
  gotoAccounts: () => view('accounts'),
  ghLogin: (host) => githubLoginFlow(host),
  ghLoginEnterprise: () => githubLoginFlow(null),
  copyCode: () => { const c = ID.login?.code ? ID.login : ID.ssh; if (c?.code) { api.copy(c.code); api.external(c.url); } },
  cancelLogin: async () => { await I('githubCancel'); ID.login = null; if (ID.ssh) ID.ssh.code = null; renderSheet(); },
  sshSetup: (id) => setupSSH(id),
  sshSetupRepo: (id) => { ID.tab = 'accounts'; return setupSSH(id); },
  sshRemote: async (id) => { await act('Remote switched to SSH', () => I('useSSHRemote', { id }), { refresh: false }); await refreshAll(); },
  httpsRemote: async () => { await act('Remote switched to HTTPS', () => I('useHTTPSRemote'), { refresh: false }); await refreshAll(); },
  ghSwitch: async (v) => { const a = splitAccount(v); await act(`${a.login} is now active in gh`, () => I('githubSwitch', a), { refresh: false }); await refreshAll(); },
  ghLogout: async (v) => { if (await I('githubLogout', splitAccount(v))) await refreshAll(); },
  glRemove: async (id) => { if (await I('gitlabRemove', { id })) await refreshAll(); },
  glTokenLink: (_v, _d, e) => {
    e.preventDefault();
    const base = $('#glForm [name="baseUrl"]').value.replace(/\/+$/, '');
    api.external(`${base}/-/user_settings/personal_access_tokens?name=Nebula&scopes=api,read_user`);
  },
};

// ---------- events ----------
function bindIdentities() {
  $('#idChip').onclick = () => openIdentities('repo');
  document.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-use-profile],[data-open-sheet],#asBtn');
    if (!t || t.closest('#sheet')) return;
    if (t.id === 'asBtn') return identityMenu();
    if (t.dataset.useProfile) return useProfile(t.dataset.useProfile);
    if (t.dataset.openSheet) { ID.editing = 'new'; openIdentities(t.dataset.openSheet); }
  });
  $('#sheetWrap').onclick = (e) => { if (e.target.id === 'sheetWrap') closeSheet(); };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#sheetWrap').hidden && $('#modalWrap').hidden) { e.stopPropagation(); closeSheet(); } }, true);
  api.on('acc:code', (info) => {
    if (ID.login) Object.assign(ID.login, info);
    else if (ID.ssh) Object.assign(ID.ssh, info);
    renderSheet();
  });
  api.on('acc:ssh', ({ id, i, state, detail }) => {
    if (ID.ssh?.id !== id) return;
    ID.ssh.steps[i] = state;
    if (state === 'done' && i === 2) ID.ssh.code = null;
    if (detail) ID.ssh.detail = detail;
    renderSheet();
  });

  const sheet = $('#sheet');
  sheet.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const formId = f.getAttribute('id'); // never f.id: a field named "id" would shadow it
    if (formId === 'idForm') {
      const v = Object.fromEntries(new FormData(f));
      v.id = v.profileId;
      const profile = { ...(v.id ? profileById(v.id) : {}), label: v.label, name: v.name, email: v.email, color: v.color, account: v.account || null, signingKey: v.signingKey, remotes: v.remotes.split('\n').map((x) => x.trim()).filter(Boolean) };
      if (!v.id) delete profile.id;
      const saved = await act(v.id ? 'Identity saved' : 'Identity created', () => I('saveProfile', { profile }), { refresh: false });
      if (saved) { ID.editing = null; await loadIdentity(); renderSheet(); }
    } else if (formId === 'glForm') {
      const v = Object.fromEntries(new FormData(f));
      const a = await act('GitLab account connected', () => I('gitlabAdd', v), { refresh: false });
      if (a) { await loadIdentity(); renderSheet(); loadPRs(); }
    }
  });
  sheet.addEventListener('click', async (e) => {
    const t = e.target.closest('button, a, [data-tab]');
    if (!t) return;
    // first data-* attribute that has a handler wins (one attribute per control)
    const key = Object.keys(SHEET_ACTIONS).find((k) => k in t.dataset);
    if (key) await SHEET_ACTIONS[key](t.dataset[key], t.dataset, e);
  });
}
bindIdentities();
