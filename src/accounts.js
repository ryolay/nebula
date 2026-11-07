// Hosting accounts. GitHub accounts live in gh (multi-account aware, tokens in the
// macOS keychain); GitLab accounts are personal access tokens encrypted with the
// OS keychain via the secret store passed in by main.js (Electron safeStorage).
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { run, ENV } = require('./git');
const gitlab = require('./gitlab');
const { originOf } = require('./identity');
const { gitAt } = require('./git');
const ssh = require('./ssh');

const ghRun = (args, opts = {}) => run('gh', args, { cwd: process.cwd(), ...opts });

class Accounts {
  constructor(dir, secrets) {
    this.file = path.join(dir, 'accounts.json');
    this.secrets = secrets;
  }
  read() { try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return { gitlab: [] }; } }
  write(d) { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(d, null, 2), { mode: 0o600 }); }

  async github() {
    try {
      const out = await ghRun(['auth', 'status', '--json', 'hosts']);
      const hosts = JSON.parse(out).hosts || {};
      return Object.entries(hosts).flatMap(([host, list]) => list.map((a) => ({
        id: `github:${host}/${a.login}`, kind: 'github', host, login: a.login, active: !!a.active,
        ok: a.state === 'success', scopes: a.scopes || '', avatar: host === 'github.com' ? `https://github.com/${a.login}.png?size=80` : null,
        ssh: ssh.status({ host, login: a.login }),
      })));
    } catch (e) {
      if (/no accounts|not logged/i.test(e.message)) return [];
      if (/ENOENT|not found/i.test(e.message)) return [];
      throw e;
    }
  }
  gitlabList() {
    return this.read().gitlab.map(({ token, ...a }) => ({ ...a, id: `gitlab:${a.host}/${a.login}`, kind: 'gitlab', ok: true, ssh: ssh.status(a) }));
  }
  async list() { return [...(await this.github()), ...this.gitlabList()]; }

  async token(id) {
    const [kind, rest] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];
    const host = rest.slice(0, rest.lastIndexOf('/')), login = rest.slice(rest.lastIndexOf('/') + 1);
    if (kind === 'github') return (await ghRun(['auth', 'token', '--hostname', host, '--user', login])).trim();
    const a = this.read().gitlab.find((x) => x.host === host && x.login === login);
    if (!a) throw new Error(`Unknown GitLab account ${login}@${host}`);
    return this.secrets.decrypt(a.token);
  }

  /** Runs a gh device-flow command (login / refresh), surfacing the one-time code via onCode. */
  ghDevice(args, onCode) {
    let child, cancelled = false;
    const promise = new Promise((resolve, reject) => {
      child = spawn('gh', args, {
        env: { ...process.env, PATH: ENV.PATH, BROWSER: 'true', GH_PROMPT_DISABLED: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let buf = '', sent = false;
      const onData = (d) => {
        buf += d;
        const code = buf.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/)?.[1];
        const url = buf.match(/(https:\/\/\S+\/login\/device)/)?.[1];
        if (code && url && !sent) { sent = true; onCode?.({ code, url }); }
      };
      child.stdout.on('data', onData); child.stderr.on('data', onData);
      child.on('error', reject);
      child.on('exit', (c, sig) => (c === 0 ? resolve(buf) : reject(new Error(sig || cancelled ? 'Sign-in cancelled' : buf.trim().split('\n').pop() || `gh exited ${c}`))));
    });
    return { promise, cancel: () => { cancelled = true; child?.kill('SIGTERM'); } };
  }

  /**
   * GitHub web/device login without a terminal. Restores the previously active
   * account afterwards so the user's global gh state is unchanged.
   */
  githubLogin(host = 'github.com', onCode) {
    if (!/^[a-z0-9.-]+$/i.test(host)) throw new Error('Invalid host');
    let dev;
    const promise = (async () => {
      const before = await this.github();
      const prevActive = before.find((a) => a.host === host && a.active)?.login;
      dev = this.ghDevice(['auth', 'login', '--hostname', host, '--web', '--git-protocol', 'https', '--skip-ssh-key'], onCode);
      await dev.promise;
      const after = await this.github();
      const added = after.find((a) => a.host === host && !before.some((b) => b.id === a.id)) || after.find((a) => a.host === host && a.active);
      if (prevActive && added && added.login !== prevActive) await ghRun(['auth', 'switch', '--hostname', host, '--user', prevActive]).catch(() => {});
      return added;
    })();
    return { promise, cancel: () => dev?.cancel() };
  }

  /** Adds scopes to a (possibly non-active) gh account; gh has no --user here, so switch → refresh → switch back. */
  async githubAddScopes(acc, scopes, onCode, track) {
    const before = await this.github();
    const prevActive = before.find((a) => a.host === acc.host && a.active)?.login;
    if (prevActive !== acc.login) await ghRun(['auth', 'switch', '--hostname', acc.host, '--user', acc.login]);
    try {
      const dev = this.ghDevice(['auth', 'refresh', '--hostname', acc.host, '--scopes', scopes.join(',')], onCode);
      track?.(dev);
      await dev.promise;
    } finally {
      if (prevActive && prevActive !== acc.login) await ghRun(['auth', 'switch', '--hostname', acc.host, '--user', prevActive]).catch(() => {});
    }
  }

  /** Upload a public key to the account (idempotent: "already in use" counts as success). */
  async uploadKey(acc, pub, title, onCode, track) {
    if (acc.kind === 'gitlab') {
      const a = this.read().gitlab.find((x) => `gitlab:${x.host}/${x.login}` === acc.id);
      try { await gitlab.api(a.baseUrl, this.secrets.decrypt(a.token), 'POST', '/user/keys', { title, key: pub }); }
      catch (e) { if (!/already been taken|has already/i.test(e.message)) throw e; }
      return;
    }
    const add = async () => run('gh', ['api', '-X', 'POST', 'user/keys', '-f', `title=${title}`, '-f', `key=${pub}`],
      { cwd: process.cwd(), env: { GH_HOST: acc.host, GH_TOKEN: await this.token(acc.id) } });
    try { await add(); }
    catch (e) {
      if (/already in use|already exists/i.test(e.message)) return;
      if (!/admin:public_key|write:public_key|HTTP 404|HTTP 403|Resource not accessible/i.test(e.message)) throw e;
      await this.githubAddScopes(acc, ['admin:public_key'], onCode, track); // one-time permission, then retry
      try { await add(); } catch (e2) { if (!/already in use|already exists/i.test(e2.message)) throw e2; }
    }
  }

  /** The one-click flow: key → ~/.ssh/config alias → upload → verify. Reports progress per step. */
  async setupSSH(id, { onStep, onCode, track, title }) {
    const acc = (await this.list()).find((a) => a.id === id);
    if (!acc) throw new Error('Unknown account');
    const step = (i, state, detail) => onStep?.({ i, state, detail });
    step(0, 'run');
    const pub = await ssh.generate(acc, `${acc.login}@${acc.host} (Nebula)`);
    step(0, 'done'); step(1, 'run');
    ssh.writeConfig(acc);
    step(1, 'done'); step(2, 'run');
    await this.uploadKey(acc, pub, title || `Nebula — ${require('node:os').hostname().replace(/\.local$/, '')}`, (c) => { step(2, 'code'); onCode?.(c); }, track);
    step(2, 'done'); step(3, 'run');
    let v = await ssh.verify(acc);
    for (let i = 0; !v.ok && i < 3; i++) { await new Promise((r) => setTimeout(r, 1500)); v = await ssh.verify(acc); } // key propagation
    step(3, v.ok ? 'done' : 'fail', v.ok ? `Authenticated as ${v.as}` : v.output);
    if (!v.ok) throw new Error(`SSH test failed: ${v.output || 'no answer'}`);
    return { ...ssh.status(acc), verified: true };
  }

  /** Repositories the account can access, most recently updated first (for the clone picker). */
  async remoteRepos(acc) {
    if (acc.kind === 'gitlab') {
      const a = this.read().gitlab.find((x) => `gitlab:${x.host}/${x.login}` === acc.id);
      const list = await gitlab.api(a.baseUrl, this.secrets.decrypt(a.token), 'GET', '/projects?membership=true&simple=true&order_by=last_activity_at&per_page=100');
      return list.map((p) => ({ fullName: p.path_with_namespace, name: p.path, description: p.description || '', private: p.visibility !== 'public', updatedAt: p.last_activity_at, https: p.http_url_to_repo, ssh: p.ssh_url_to_repo }));
    }
    const out = await run('gh', ['api', 'user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member'],
      { cwd: process.cwd(), env: { GH_HOST: acc.host, GH_TOKEN: await this.token(acc.id) } });
    return JSON.parse(out).map((r) => ({ fullName: r.full_name, name: r.name, description: r.description || '', private: r.private, updatedAt: r.pushed_at || r.updated_at, https: r.clone_url, ssh: r.ssh_url, language: r.language, fork: r.fork }));
  }
  githubLogout(host, login) { return ghRun(['auth', 'logout', '--hostname', host, '--user', login]); }
  githubSwitch(host, login) { return ghRun(['auth', 'switch', '--hostname', host, '--user', login]); }

  async gitlabAdd({ baseUrl = 'https://gitlab.com', token }) {
    if (!token?.trim()) throw new Error('A personal access token is required');
    const url = new URL(baseUrl.trim());
    if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('GitLab URL must use https');
    const base = url.origin;
    const me = await gitlab.whoami(base, token.trim());
    const d = this.read();
    const rec = { host: url.host.toLowerCase(), baseUrl: base, login: me.username, name: me.name, avatar: me.avatar_url, token: this.secrets.encrypt(token.trim()) };
    d.gitlab = [...d.gitlab.filter((a) => !(a.host === rec.host && a.login === rec.login)), rec];
    this.write(d);
    return { ...rec, token: undefined, id: `gitlab:${rec.host}/${rec.login}`, kind: 'gitlab' };
  }
  gitlabRemove(id) {
    const d = this.read();
    d.gitlab = d.gitlab.filter((a) => `gitlab:${a.host}/${a.login}` !== id);
    this.write(d);
  }

  /** Which account (and token) should network/PR operations in `repo` use? */
  async resolve(repo) {
    const remote = await originOf(repo).catch(() => null);
    if (!remote) return null;
    let pinned = (await gitAt(repo, ['config', '--local', '--get', 'nebula.account'], { ok: [0, 1] })).trim() || null;
    const al = ssh.aliases().find((a) => a.alias === remote.host);
    if (al) { // the SSH alias *is* the account choice
      remote.sshAlias = remote.host;
      remote.host = al.host;
      const kind = (await this.list().catch(() => [])).find((a) => a.host === al.host && a.login.toLowerCase() === al.login.toLowerCase())?.kind || 'github';
      pinned = pinned || `${kind}:${al.host}/${al.login}`;
    }
    const all = await this.list().catch(() => []);
    const onHost = all.filter((a) => a.host === remote.host);
    let account = pinned ? all.find((a) => a.id === pinned && a.host === remote.host) : null;
    if (!account) account = onHost.find((a) => a.kind === 'github' && a.active) || onHost[0] || null;
    const provider = account?.kind || (remote.host === 'github.com' ? 'github' : /gitlab/.test(remote.host) ? 'gitlab' : null);
    let token = null;
    if (account) token = await this.token(account.id).catch(() => null);
    return { remote, provider, account, token, pinned, pinnedMissing: !!pinned && account?.id !== pinned, candidates: onHost };
  }
}

module.exports = { Accounts };
