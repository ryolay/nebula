// GitHub / GitLab issues: sidebar list, detail with comments, create, comment, close/reopen, assign, branch from issue.

S.issues = { available: false, items: [] };
S.issueState = 'open';

async function loadIssues() {
  if (!S.info) return;
  const tab = S.tab;
  const r = await G('issues', { state: S.issueState }).catch((e) => ({ available: false, error: e.message, items: [] }));
  if (tab !== S.tab) return;
  S.issues = r;
  renderSidebar();
  if (S.sel?.type === 'issue' && $('#detail').dataset.view !== 'issue') renderDetail();
}

const avatarUrl = (u) => u?.avatar || (u?.login ? `https://github.com/${encodeURIComponent(u.login)}.png?size=64` : '');
const hostName = () => (S.issues.provider === 'gitlab' ? 'GitLab' : 'GitHub');

function issuesSection(section) {
  const I = S.issues;
  // without a GitHub/GitLab remote the Pull Requests section already says so — don't repeat it
  if (!I.available && /No GitHub or GitLab remote/.test(I.error || '')) return '';
  const q = (S.sideQuery || '').toLowerCase();
  let body;
  if (!I.available) body = `<div class="side-note">${I.error ? esc(I.error) : 'Loading…'}</div>`;
  else {
    const items = I.items.filter((i) => !q || i.title.toLowerCase().includes(q) || String(i.number).includes(q));
    body = items.map((i) => `<div class="item issue ${S.sel?.type === 'issue' && S.sel.id === i.number ? 'sel' : ''}" data-kind="issue" data-num="${i.number}" title="${esc(i.title)}">
        <span class="issue-ic ${i.state === 'OPEN' ? 'open' : 'closed'}">${icon(i.state === 'OPEN' ? 'issue' : 'check')}</span>
        <div class="pr-t"><span>${esc(i.title)}</span><small>#${i.number}${i.labels?.length ? ` · ${i.labels.slice(0, 2).map((l) => esc(l.name)).join(', ')}` : ''}${i.commentsCount ? ` · ${icon('message')}${i.commentsCount}` : ''}</small></div>
        ${i.assignees?.length ? avatar(i.assignees[0].login, i.assignees[0].login, avatarUrl(i.assignees[0])) : ''}</div>`).join('')
      || `<div class="side-note">${S.issueState === 'open' ? 'No open issues' : 'No closed issues'}</div>`;
    body += `<div class="side-note"><a href="#" data-issue-state="${S.issueState === 'open' ? 'closed' : 'open'}">${S.issueState === 'open' ? 'Show closed issues' : 'Show open issues'}</a></div>`;
  }
  return section('issues', S.issueState === 'open' ? 'Issues' : 'Closed issues', I.items?.length || 0, body, 'issue', S.tab?.provider);
}

// ---------- tiny, safe markdown (everything is escaped first) ----------
function md(src) {
  if (!src?.trim()) return '<p class="md-empty">No description provided.</p>';
  const blocks = [];
  let text = String(src).replace(/\r\n/g, '\n').replace(/```[^\n]*\n([\s\S]*?)```/g, (_, code) => { blocks.push(code); return `\uE000${blocks.length - 1}\uE000`; });
  text = esc(text);
  const inline = (s) => s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" data-ext="$2">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" data-ext="$2">$2</a>')
    .replace(/(^|[\s(])#(\d+)\b/g, '$1<a href="#" data-issue-ref="$2">#$2</a>')
    .replace(/(^|[\s(])@([A-Za-z0-9-]+)/g, '$1<span class="md-mention">@$2</span>');
  const out = [];
  let list = null;
  for (const line of text.split('\n')) {
    const code = line.match(/^\uE000(\d+)\uE000$/);
    const li = line.match(/^\s*[-*] (\[( |x)\] )?(.*)$/);
    const ol = line.match(/^\s*\d+\. (.*)$/);
    if (list && !li && !ol) { out.push(`</${list}>`); list = null; }
    if (code) out.push(`<pre><code>${esc(blocks[+code[1]])}</code></pre>`);
    else if (/^#{1,6} /.test(line)) { const n = line.match(/^#+/)[0].length; out.push(`<h${Math.min(n + 2, 6)}>${inline(line.slice(n + 1))}</h${Math.min(n + 2, 6)}>`); }
    else if (li) { if (list !== 'ul') { if (list) out.push(`</${list}>`); out.push('<ul>'); list = 'ul'; } out.push(`<li>${li[1] ? `<span class="md-task ${li[2] === 'x' ? 'done' : ''}">${li[2] === 'x' ? icon('check') : ''}</span>` : ''}${inline(li[3])}</li>`); }
    else if (ol) { if (list !== 'ol') { if (list) out.push(`</${list}>`); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(ol[1])}</li>`); }
    else if (/^&gt; ?/.test(line)) out.push(`<blockquote>${inline(line.replace(/^&gt; ?/, ''))}</blockquote>`);
    else if (!line.trim()) out.push('<br>');
    else out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push(`</${list}>`);
  return out.join('').replace(/(<br>)+/g, '<br>');
}

async function renderIssue() {
  const d = $('#detail');
  const n = S.sel.id;
  d.dataset.view = 'issue';
  d.innerHTML = `<div class="d-head"><div class="d-kicker">${icon('issue')} Issue #${n}</div><p class="d-body">Loading…</p></div>`;
  let i;
  try { i = await G('issueView', { number: n }); } catch (e) { d.innerHTML = `<div class="d-head"><p class="d-body">${esc(e.message)}</p></div>`; return; }
  if (S.sel?.type !== 'issue' || S.sel.id !== n || d.dataset.view !== 'issue') return;
  const open = i.state === 'OPEN';
  const draft = S.tab.issueDrafts?.[n] || '';
  d.innerHTML = `<div class="d-head">
      <div class="d-kicker">${icon('issue')} Issue #${i.number} <span class="issue-state ${open ? 'open' : 'closed'}">${icon(open ? 'issue' : 'check')}${open ? 'Open' : 'Closed'}</span></div>
      <div class="d-title">${esc(i.title)}</div>
      ${i.labels?.length ? `<div class="labels">${i.labels.map((l) => `<span class="label" style="color:#${esc(l.color)};border-color:#${esc(l.color)}66;background:#${esc(l.color)}1a">${esc(l.name)}</span>`).join('')}</div>` : ''}
      <div class="who">${avatar(i.author?.login, i.author?.login, avatarUrl(i.author), 'lg')}<div class="meta"><b>${esc(i.author?.name || i.author?.login || '')}</b><small>@${esc(i.author?.login || '')} · opened ${ago(Date.parse(i.createdAt) / 1000)}</small>
        ${i.assignees?.length ? `<small class="assignees">${icon('user')}${i.assignees.map((a) => `${avatar(a.login, a.login, avatarUrl(a))}${esc(a.login)}`).join(' ')}</small>` : '<small>No one assigned</small>'}</div></div>
    </div>
    <div class="d-actions">
      <button class="btn" data-issue-act="branch">${icon('branch')}Create branch</button>
      <button class="btn" data-issue-act="assign">${icon('user')}Assign to me</button>
      <button class="btn" data-issue-act="open">${brand(S.issues.provider === 'gitlab' ? 'gitlab' : 'github', 'btn-logo')}Open on ${hostName()}</button>
    </div>
    <div class="md issue-body">${md(i.body)}</div>
    <div class="files-h"><span>${icon('message')}${i.comments?.length || 0} comment${i.comments?.length === 1 ? '' : 's'}</span></div>
    <div class="thread">${(i.comments || []).map((c) => `<div class="cmt">${avatar(c.author?.login, c.author?.login, avatarUrl(c.author))}
        <div class="cmt-b"><div class="cmt-h"><b>${esc(c.author?.login || '')}</b><small title="${esc(fullDate(Date.parse(c.createdAt) / 1000))}">${ago(Date.parse(c.createdAt) / 1000)}</small></div><div class="md">${md(c.body)}</div></div></div>`).join('')}</div>
    <div class="composer issue-composer">
      <textarea class="field" id="issueReply" placeholder="Leave a comment… (Markdown, ⌘↵ to send)">${esc(draft)}</textarea>
      <div class="row-btns">
        <button class="btn ${open ? 'danger' : ''}" data-issue-act="${open ? 'close' : 'reopen'}">${icon(open ? 'check' : 'issue')}${open ? (draft.trim() ? 'Close with comment' : 'Close issue') : 'Reopen issue'}</button>
        <button class="btn primary" data-issue-act="comment" ${draft.trim() ? '' : 'disabled'}>${icon('message')}Comment</button>
      </div>
    </div>`;
  d._issue = i;
}

async function issueAction(a) {
  const i = $('#detail')._issue;
  if (!i) return;
  const reply = $('#issueReply');
  const body = reply?.value.trim() || '';
  if (a === 'open') return api.external(i.url);
  if (a === 'branch') {
    if (S.status.state) return hudInfo('Finish or abort the operation in progress first', 'alert');
    return act('Create branch', () => G('issueBranch', { number: i.number, title: i.title }),
      { hud: { title: `Creating a branch for #${i.number}`, icon: 'branch' }, undo: (r) => ({ kind: 'branchCreate', name: r.name, checkout: true, label: `create branch ${r.name}` }) });
  }
  if (a === 'assign') return act('Assign', async () => { await G('issueAssignMe', { number: i.number }); return { summary: `Assigned #${i.number} to you` }; }, { hud: { title: 'Assigning', icon: 'user' }, refresh: false }).then(refreshIssue);
  if (a === 'comment' && body) {
    const ok = await act('Comment', async () => { await G('issueComment', { number: i.number, body }); return { summary: `Commented on #${i.number}` }; }, { hud: { title: 'Posting comment', icon: 'message' }, refresh: false });
    if (ok) { delete S.tab.issueDrafts?.[i.number]; refreshIssue(); }
    return;
  }
  if (a === 'close' || a === 'reopen') {
    const ok = await act(a === 'close' ? 'Close issue' : 'Reopen issue', async () => {
      if (body) await G('issueComment', { number: i.number, body });
      await G('issueSetState', { number: i.number, open: a === 'reopen' });
      return { summary: `${a === 'close' ? 'Closed' : 'Reopened'} #${i.number}` };
    }, { hud: { title: a === 'close' ? `Closing #${i.number}` : `Reopening #${i.number}`, icon: a === 'close' ? 'check' : 'issue' }, refresh: false });
    if (ok) { delete S.tab.issueDrafts?.[i.number]; refreshIssue(); }
  }
}
async function refreshIssue() { await loadIssues(); if (S.sel?.type === 'issue') renderIssue(); }

async function newIssue() {
  if (!S.info) return;
  const v = await modal({ title: `New ${hostName()} issue`, iconName: 'issue', ok: 'Create issue',
    fields: [{ name: 'title', label: 'Title', placeholder: 'Login redirects to a blank page' }, { name: 'body', label: 'Description (Markdown)', type: 'textarea', placeholder: 'Steps to reproduce, expected vs actual…' }] });
  if (!v?.title) return;
  const r = await act('Create issue', async () => { const x = await G('issueCreate', v); return { ...x, summary: `Created issue${x.number ? ` #${x.number}` : ''}` }; }, { hud: { title: 'Creating issue', icon: 'issue' }, refresh: false });
  if (r) { await loadIssues(); if (r.number) select({ type: 'issue', id: r.number }); }
}

function bindIssues() {
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-issue-act], [data-issue-state], [data-ext], [data-issue-ref]');
    if (!t) return;
    e.preventDefault();
    if (t.dataset.issueAct) return issueAction(t.dataset.issueAct);
    if (t.dataset.issueState) { S.issueState = t.dataset.issueState; S.collapsed.issues = false; return loadIssues(); }
    if (t.dataset.ext) return api.external(t.dataset.ext);
    if (t.dataset.issueRef) return select({ type: 'issue', id: +t.dataset.issueRef });
  });
  document.addEventListener('input', (e) => {
    if (e.target.id !== 'issueReply') return;
    const i = $('#detail')._issue;
    (S.tab.issueDrafts ||= {})[i.number] = e.target.value;
    const has = !!e.target.value.trim();
    $('[data-issue-act="comment"]').disabled = !has;
    const close = $('[data-issue-act="close"]');
    if (close) close.lastChild.textContent = has ? 'Close with comment' : 'Close issue';
  });
  document.addEventListener('keydown', (e) => { if (e.target.id === 'issueReply' && e.key === 'Enter' && modKey(e)) { e.preventDefault(); $('[data-issue-act="comment"]:not([disabled])')?.click(); } });
}
bindIssues();
