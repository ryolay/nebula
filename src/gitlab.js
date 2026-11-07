// Minimal GitLab REST client (gitlab.com or self-managed). Merge requests are
// mapped onto the same shape as `gh pr list --json …` so the UI stays generic.
async function api(baseUrl, token, method, pathname, body) {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/v4${pathname}`, {
    method,
    headers: { ...(token ? { 'PRIVATE-TOKEN': token } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = json?.message ? (typeof json.message === 'string' ? json.message : JSON.stringify(json.message)) : json?.error || res.statusText;
    throw new Error(`GitLab ${res.status}: ${msg}`);
  }
  return json;
}
const call = (a, method, p, body) => api(a.account?.baseUrl || `https://${a.remote.host}`, a.token, method, p, body);
const project = (a) => `/projects/${encodeURIComponent(a.remote.path)}`;

const whoami = (baseUrl, token) => api(baseUrl, token, 'GET', '/user');

function toPR(mr) {
  return {
    number: mr.iid,
    title: mr.title,
    author: { login: mr.author?.username, name: mr.author?.name, avatar: mr.author?.avatar_url },
    headRefName: mr.source_branch,
    baseRefName: mr.target_branch,
    isDraft: !!(mr.draft ?? mr.work_in_progress),
    url: mr.web_url,
    createdAt: mr.created_at,
    updatedAt: mr.updated_at,
    reviewDecision: mr.detailed_merge_status === 'not_approved' ? 'REVIEW_REQUIRED' : null,
    additions: null,
    deletions: null,
    changedFiles: mr.changes_count != null ? parseInt(mr.changes_count, 10) || mr.changes_count : null,
    labels: (mr.labels || []).map((l) => (typeof l === 'string' ? { name: l, color: '8b8fb5' } : { name: l.name, color: (l.color || '#8b8fb5').replace('#', '') })),
    body: mr.description || '',
    state: 'OPEN',
  };
}

async function listMRs(a) {
  const mrs = await call(a, 'GET', `${project(a)}/merge_requests?state=opened&per_page=50&order_by=updated_at`);
  return mrs.map(toPR);
}

async function createMR(a, { source, target, title, body, draft }) {
  const base = target || (await call(a, 'GET', project(a))).default_branch;
  return call(a, 'POST', `${project(a)}/merge_requests`, {
    source_branch: source, target_branch: base, title: draft ? `Draft: ${title}` : title, description: body || '', remove_source_branch: false,
  });
}

async function mergeMR(a, iid, method) {
  if (method === 'rebase') await call(a, 'PUT', `${project(a)}/merge_requests/${iid}/rebase`);
  return call(a, 'PUT', `${project(a)}/merge_requests/${iid}/merge`, { squash: method === 'squash' });
}

// ---------- issues (mapped onto the gh issue JSON shape) ----------
const toIssue = (i) => ({
  number: i.iid, title: i.title, body: i.description || '', state: i.state === 'opened' ? 'OPEN' : 'CLOSED', url: i.web_url,
  author: { login: i.author?.username, name: i.author?.name, avatar: i.author?.avatar_url },
  labels: (i.labels || []).map((l) => (typeof l === 'string' ? { name: l, color: '8b8fb5' } : { name: l.name, color: (l.color || '#8b8fb5').replace('#', '') })),
  assignees: (i.assignees || []).map((a) => ({ login: a.username, name: a.name, avatar: a.avatar_url })),
  commentsCount: i.user_notes_count || 0, createdAt: i.created_at, updatedAt: i.updated_at,
});
async function listIssues(a, { state = 'opened' } = {}) {
  return (await call(a, 'GET', `${project(a)}/issues?state=${state}&per_page=100&order_by=updated_at`)).map(toIssue);
}
async function viewIssue(a, iid) {
  const [i, notes] = await Promise.all([call(a, 'GET', `${project(a)}/issues/${iid}`), call(a, 'GET', `${project(a)}/issues/${iid}/notes?sort=asc&per_page=100`)]);
  return { ...toIssue(i), comments: notes.filter((n) => !n.system).map((n) => ({ author: { login: n.author?.username, avatar: n.author?.avatar_url }, body: n.body, createdAt: n.created_at })) };
}
const createIssue = async (a, { title, body }) => toIssue(await call(a, 'POST', `${project(a)}/issues`, { title, description: body || '' }));
const commentIssue = (a, iid, body) => call(a, 'POST', `${project(a)}/issues/${iid}/notes`, { body });
const setIssueState = (a, iid, open) => call(a, 'PUT', `${project(a)}/issues/${iid}`, { state_event: open ? 'reopen' : 'close' });
async function assignMe(a, iid) {
  const me = await call(a, 'GET', '/user');
  const i = await call(a, 'GET', `${project(a)}/issues/${iid}`);
  return call(a, 'PUT', `${project(a)}/issues/${iid}`, { assignee_ids: [...new Set([...(i.assignees || []).map((x) => x.id), me.id])] });
}

// ---------- data for the "new merge request" form ----------
async function mrMeta(a) {
  const [p, members, labels, milestones, me] = await Promise.all([
    call(a, 'GET', project(a)),
    call(a, 'GET', `${project(a)}/members/all?per_page=100`).catch(() => []),
    call(a, 'GET', `${project(a)}/labels?per_page=100`).catch(() => []),
    call(a, 'GET', `${project(a)}/milestones?state=active&per_page=100`).catch(() => []),
    call(a, 'GET', '/user').catch(() => null),
  ]);
  return {
    defaultBranch: p.default_branch, me: me?.username || null, teams: [], // GitLab reviewers are people only
    users: members.filter((u) => u.state !== 'blocked').map((u) => ({ login: u.username, name: u.name, avatar: u.avatar_url, id: u.id })),
    labels: labels.map((l) => ({ name: l.name, color: (l.color || '#8b8fb5').replace('#', ''), description: l.description || '' })),
    milestones: milestones.map((m) => ({ title: m.title, id: m.id })),
    template: null,
  };
}
async function createMRFull(a, { source, target, title, body, draft, reviewers = [], assignees = [], labels = [], milestone }) {
  const meta = await mrMeta(a);
  const ids = (logins) => logins.map((l) => meta.users.find((u) => u.login === l)?.id).filter(Boolean);
  return call(a, 'POST', `${project(a)}/merge_requests`, {
    source_branch: source, target_branch: target || meta.defaultBranch, title: draft ? `Draft: ${title}` : title, description: body || '',
    reviewer_ids: ids(reviewers), assignee_ids: ids(assignees), labels: labels.join(','),
    ...(milestone ? { milestone_id: meta.milestones.find((m) => m.title === milestone)?.id } : {}), remove_source_branch: false,
  });
}

module.exports = { api, whoami, listMRs, createMR, mergeMR, toPR, mrMeta, createMRFull, listIssues, viewIssue, createIssue, commentIssue, setIssueState, assignMe, toIssue };
