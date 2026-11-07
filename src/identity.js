// Commit identities. Git's own config stays the source of truth (so the terminal,
// editors and Nebula always agree); Nebula only adds named profiles + rules on top.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { gitAt } = require('./git');

const PALETTE = ['#8b5cf6', '#22d3ee', '#f472b6', '#a3e635', '#fbbf24', '#fb7185', '#2dd4bf', '#60a5fa'];
const FREEMAIL = /^(gmail|googlemail|outlook|hotmail|live|icloud|me|mac|yahoo|proton|protonmail|pm|gmx|hey|fastmail|aol)\./i;
const home = () => os.homedir();
// Git config and OpenSSH accept forward slashes everywhere, including on Windows.
const slash = (p) => (process.platform === 'win32' && p ? p.replace(/\\/g, '/') : p);
const expand = (p) => (p ? p.replace(/^~(?=$|[\\/])/, home()) : p);
const tilde = (p) => { const s = slash(p); const h = slash(home()); return s && s.startsWith(`${h}/`) ? `~${s.slice(h.length)}` : s; };
const globalConfigPath = () => process.env.GIT_CONFIG_GLOBAL || path.join(home(), '.gitconfig');

// ---------- remotes ----------
function parseRemote(url) {
  if (!url) return null;
  const u = url.trim();
  let m = u.match(/^(https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::(\d+))?\/(.+?)(?:\.git)?\/?$/i);
  let protocol, scheme, host;
  if (m) {
    scheme = m[1].toLowerCase();
    protocol = /^https?$/.test(scheme) ? 'https' : 'ssh';
    host = m[2].toLowerCase() + (protocol === 'https' && m[3] ? `:${m[3]}` : ''); // http(s) port is part of the identity
    m = [null, host, m[4]];
  } else {
    m = u.match(/^(?:[^@\s]+@)?([^:/\s]+):(?!\/)(.+?)(?:\.git)?\/?$/);
    if (!m || u.startsWith('/') || /^[a-z]:\\/i.test(u)) return null;
    protocol = 'ssh'; scheme = 'ssh'; m[1] = m[1].toLowerCase();
  }
  if (!m) return null;
  const p = m[2].replace(/^\/+/, '');
  const parts = p.split('/');
  return { host: m[1], path: p, owner: parts.slice(0, -1).join('/'), name: parts.at(-1), protocol, scheme, url: u };
}
async function originOf(repo) {
  const remotes = (await gitAt(repo, ['remote']).catch(() => '')).split('\n').filter(Boolean);
  if (!remotes.length) return null;
  const name = remotes.includes('origin') ? 'origin' : remotes[0];
  // raw config value: `remote get-url` would expand url.*.insteadOf aliases
  return parseRemote((await gitAt(repo, ['config', '--get', `remote.${name}.url`])).trim());
}

// ---------- what git will actually use ----------
async function effective(repo) {
  const get = async (key) => {
    const out = (await gitAt(repo, ['config', '--show-origin', '--show-scope', '--get', key], { ok: [0, 1] })).replace(/\n$/, '');
    if (!out) return null;
    const [scope, origin, ...v] = out.split('\t');
    const file = origin.replace(/^file:/, '');
    return { scope, file: tilde(file), value: v.join('\t'), included: scope === 'global' && path.resolve(expand(file)) !== path.resolve(globalConfigPath()) };
  };
  const [name, email, signingKey, gpgsign, pinned] = await Promise.all(['user.name', 'user.email', 'user.signingkey', 'commit.gpgsign', 'nebula.identity'].map(get));
  return { name, email, signingKey, sign: gpgsign?.value === 'true', profileId: pinned?.value || null };
}

// ---------- discover identities already configured in git ----------
async function discover() {
  const cwd = home();
  const g = async (args) => (await gitAt(cwd, args, { ok: [0, 1] })).trim();
  const found = [];
  const gName = await g(['config', '--global', '--get', 'user.name']);
  const gEmail = await g(['config', '--global', '--get', 'user.email']);
  if (gEmail) found.push({ source: 'global', file: tilde(globalConfigPath()), name: gName, email: gEmail, folders: [] });
  const inc = await g(['config', '--global', '--get-regexp', '^includeif\\.']);
  for (const line of inc.split('\n').filter(Boolean)) {
    const sp = line.indexOf(' ');
    const key = line.slice(0, sp), val = line.slice(sp + 1);
    const cond = key.replace(/^includeif\./i, '').replace(/\.path$/i, '');
    const folder = cond.match(/^gitdir(?:\/i)?:(.*)$/i)?.[1];
    let file = expand(val);
    if (!path.isAbsolute(file)) file = path.join(path.dirname(globalConfigPath()), file);
    if (!fs.existsSync(file)) continue;
    const r = async (k) => (await gitAt(cwd, ['config', '--file', file, '--get', k], { ok: [0, 1] })).trim();
    const email = await r('user.email');
    if (!email) continue;
    const prev = found.find((f) => f.email.toLowerCase() === email.toLowerCase() && f.source === 'include');
    if (prev) { if (folder) prev.folders.push(folder); continue; }
    found.push({ source: 'include', file: tilde(file), condition: cond, name: (await r('user.name')) || gName, email, signingKey: await r('user.signingkey'), folders: folder ? [folder] : [] });
  }
  return found;
}

// ---------- profile store ----------
class Profiles {
  constructor(dir) { this.file = path.join(dir, 'identities.json'); }
  read() { try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return { profiles: [], imported: false }; } }
  write(data) { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(data, null, 2)); }
  async list() {
    const data = this.read();
    if (!data.imported) {
      for (const f of await discover()) {
        if (data.profiles.some((p) => p.email.toLowerCase() === f.email.toLowerCase())) continue;
        data.profiles.push(normalize({
          label: labelFor(f.email), name: f.name, email: f.email, signingKey: f.signingKey || '',
          folders: f.folders, remotes: [], account: null, importedFrom: f.file,
        }, data.profiles.length));
      }
      data.imported = true;
      this.write(data);
    }
    return data.profiles;
  }
  async save(p) {
    validate(p);
    await this.list();
    const all = this.read();
    const i = all.profiles.findIndex((x) => x.id === p.id);
    const merged = normalize({ ...(i >= 0 ? all.profiles[i] : {}), ...p }, all.profiles.length);
    if (i >= 0) all.profiles[i] = merged; else all.profiles.push(merged);
    this.write(all);
    return merged;
  }
  async remove(id) {
    const all = this.read();
    all.profiles = all.profiles.filter((p) => p.id !== id);
    this.write(all);
  }
  async get(id) { return (await this.list()).find((p) => p.id === id) || null; }
}
function labelFor(email) {
  const domain = (email.split('@')[1] || '').toLowerCase();
  if (!domain || FREEMAIL.test(domain) || domain.endsWith('users.noreply.github.com')) return 'Personal';
  const base = domain.split('.').slice(-2, -1)[0] || domain;
  return base.replace(/^try(?=[a-z]{3,})/, '').replace(/^./, (c) => c.toUpperCase());
}
function normalize(p, idx = 0) {
  return {
    id: p.id || crypto.randomUUID(),
    label: (p.label || labelFor(p.email || '')).trim(),
    name: (p.name || '').trim(),
    email: (p.email || '').trim(),
    signingKey: (p.signingKey || '').trim(),
    color: p.color || PALETTE[idx % PALETTE.length],
    account: p.account || null,
    folders: [...new Set((p.folders || []).map((f) => f.trim()).filter(Boolean))],
    remotes: [...new Set((p.remotes || []).map((r) => r.trim().toLowerCase()).filter(Boolean))],
    importedFrom: p.importedFrom || null,
  };
}
function validate(p) {
  if (!p.name?.trim()) throw new Error('Name is required');
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(p.email?.trim() || '')) throw new Error('A valid email is required');
  if (/[\n<>]/.test(p.name)) throw new Error('Name contains invalid characters');
}

// ---------- rules: which profile *should* this repo use? ----------
const glob = (pattern) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\uE000').replace(/\*/g, '[^/]*').replace(/\uE000/g, '.*')}(/.*)?$`, 'i');
function matchRemote(pattern, remote) {
  if (!remote) return false;
  const pat = pattern.replace(/^https?:\/\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  return glob(pat).test(`${remote.host}/${remote.path}`);
}
function matchFolder(folder, repoPath) {
  const norm = (p) => path.resolve(p).replace(/\\/g, '/').toLowerCase();
  const f = norm(expand(folder)).replace(/\/+$/, '');
  const r = norm(repoPath);
  return r === f || r.startsWith(`${f}/`);
}
function suggest(profiles, repoPath, remote) {
  for (const p of profiles) for (const r of p.remotes) if (matchRemote(r, remote)) return { profile: p, reason: `remote matches ${r}` };
  for (const p of profiles) for (const f of p.folders) if (matchFolder(f, repoPath)) return { profile: p, reason: `inside ${tilde(path.resolve(expand(f)))}` };
  return null;
}

// ---------- applying an identity ----------
async function applyToRepo(repo, p) {
  validate(p);
  await gitAt(repo, ['config', '--local', 'user.name', p.name]);
  await gitAt(repo, ['config', '--local', 'user.email', p.email]);
  if (p.signingKey) await gitAt(repo, ['config', '--local', 'user.signingkey', p.signingKey]);
  else await gitAt(repo, ['config', '--local', '--unset', 'user.signingkey'], { ok: [0, 5] });
  await gitAt(repo, ['config', '--local', 'nebula.identity', p.id]);
  if (p.account) await gitAt(repo, ['config', '--local', 'nebula.account', p.account]);
}
async function clearRepo(repo) {
  for (const k of ['user.name', 'user.email', 'user.signingkey', 'nebula.identity']) await gitAt(repo, ['config', '--local', '--unset', k], { ok: [0, 5] });
}
async function setGlobal(p) {
  validate(p);
  const cwd = home();
  await gitAt(cwd, ['config', '--global', 'user.name', p.name]);
  await gitAt(cwd, ['config', '--global', 'user.email', p.email]);
}
/** Plan (and optionally apply) an includeIf rule so every repo under `folder` uses `p`. */
async function folderRule(p, folder, { apply = false } = {}) {
  validate(p);
  const abs = path.resolve(expand(folder));
  const slug = p.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'identity';
  const includeFile = path.join(path.dirname(globalConfigPath()), `.gitconfig-nebula-${slug}`);
  const key = `includeIf.gitdir/i:${tilde(abs)}/.path`;
  const plan = {
    includeFile: tilde(includeFile),
    includeContent: `[user]\n\tname = ${p.name}\n\temail = ${p.email}\n${p.signingKey ? `\tsigningkey = ${p.signingKey}\n` : ''}`,
    globalFile: tilde(globalConfigPath()),
    globalLine: `[includeIf "gitdir/i:${tilde(abs)}/"]\n\tpath = ${tilde(includeFile)}`,
  };
  if (!apply) return plan;
  const cwd = home();
  await gitAt(cwd, ['config', '--file', includeFile, 'user.name', p.name]);
  await gitAt(cwd, ['config', '--file', includeFile, 'user.email', p.email]);
  if (p.signingKey) await gitAt(cwd, ['config', '--file', includeFile, 'user.signingkey', p.signingKey]);
  await gitAt(cwd, ['config', '--global', '--replace-all', key, tilde(includeFile)]);
  return plan;
}

module.exports = { parseRemote, originOf, effective, discover, Profiles, suggest, matchRemote, matchFolder, applyToRepo, clearRepo, setGlobal, folderRule, labelFor, tilde };
