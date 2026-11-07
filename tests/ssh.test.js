const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const H = require('./helpers'); // sets NEBULA_SSH_DIR to a throwaway folder + fake gh/ssh
const git = require('../src/git');
const ssh = require('../src/ssh');
const { Accounts } = require('../src/accounts');

const secrets = { encrypt: (s) => `enc:${Buffer.from(s).toString('base64')}`, decrypt: (s) => Buffer.from(s.slice(4), 'base64').toString() };
const cfg = () => path.join(H.SSH_DIR, 'config');
test.beforeEach(() => { fs.rmSync(H.SSH_DIR, { recursive: true, force: true }); H.resetGh(); git.setAuthResolver(null); });

test('never touches the real ~/.ssh during tests', () => {
  assert.equal(ssh.sshDir(), H.SSH_DIR);
  assert.ok(!ssh.sshDir().startsWith(path.join(require('node:os').homedir(), '.ssh')));
});

test('alias / key names; hostile host or login rejected (no ssh config injection)', () => {
  assert.equal(ssh.alias({ host: 'github.com', login: 'OctoCat' }), 'github.com-octocat');
  assert.match(ssh.keyFile({ host: 'gitlab.com', login: 'gl-user' }), /nebula_gitlab\.com_gl-user$/);
  assert.throws(() => ssh.alias({ host: 'github.com\nHost *', login: 'x' }), /Invalid/);
  assert.throws(() => ssh.alias({ host: 'github.com', login: 'x\n  ProxyCommand evil' }), /Invalid/);
  assert.throws(() => ssh.alias({ host: 'github.com', login: '-oProxyCommand=x' }), /Invalid/);
});

test('generate: ed25519 key, private key 0600, reused (not overwritten) on second call', async () => {
  const acc = { host: 'github.com', login: 'work' };
  const pub = await ssh.generate(acc, 'work@github.com (Nebula)');
  assert.match(pub, /^ssh-ed25519 \S+ work@github\.com \(Nebula\)$/);
  const kf = ssh.keyFile(acc);
  assert.equal(fs.statSync(kf).mode & 0o777, 0o600);
  assert.equal(fs.statSync(H.SSH_DIR).mode & 0o777, 0o700);
  assert.equal(await ssh.generate(acc, 'other comment'), pub, 'existing key is reused');
});

test('writeConfig: managed blocks per account, idempotent, keeps user content, backs it up, ssh honours it', () => {
  fs.mkdirSync(H.SSH_DIR, { recursive: true });
  fs.writeFileSync(cfg(), 'Host myserver\n  HostName 10.0.0.1\n  User me\n');
  const work = { host: 'github.com', login: 'work' }, perso = { host: 'github.com', login: 'perso' };
  ssh.writeConfig(work);
  ssh.writeConfig(perso);
  ssh.writeConfig(work); // re-run: replaced in place, not duplicated
  const txt = fs.readFileSync(cfg(), 'utf8');
  assert.match(txt, /^Host myserver\n {2}HostName 10\.0\.0\.1/, 'user content preserved at the top');
  assert.equal(txt.match(/Host github\.com-work\n/g).length, 1);
  assert.equal(fs.readFileSync(`${cfg()}.nebula-backup`, 'utf8'), 'Host myserver\n  HostName 10.0.0.1\n  User me\n');
  assert.equal(fs.statSync(cfg()).mode & 0o777, 0o644, "an existing config keeps the user's permissions");
  assert.deepEqual(ssh.aliases().map((a) => [a.alias, a.host, a.login]), [['github.com-work', 'github.com', 'work'], ['github.com-perso', 'github.com', 'perso']]);
  // the real OpenSSH resolves the alias to github.com with *only* that account's key
  const g = execFileSync('/usr/bin/ssh', ['-G', '-F', cfg(), 'github.com-work'], { encoding: 'utf8' });
  assert.match(g, /^hostname github\.com$/m);
  assert.match(g, /^user git$/m);
  assert.match(g, /^identitiesonly yes$/m);
  assert.match(g, new RegExp(`^identityfile ${ssh.keyFile(work).replace(/[.]/g, '\\.')}$`, 'm'));
});

test('writeConfig on a fresh machine creates ~/.ssh (0700) and config (0600)', () => {
  assert.equal(fs.existsSync(H.SSH_DIR), false);
  ssh.writeConfig({ host: 'github.com', login: 'work' });
  assert.equal(fs.statSync(H.SSH_DIR).mode & 0o777, 0o700);
  assert.equal(fs.statSync(cfg()).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(`${cfg()}.nebula-backup`), false, 'nothing to back up');
});

test('verify: recognises GitHub greeting for the right login only', async () => {
  const acc = { host: 'github.com', login: 'work' };
  ssh.writeConfig(acc);
  assert.equal((await ssh.verify(acc)).ok, false);
  H.setSshUsers({ 'github.com-work': 'someone-else' });
  const wrong = await ssh.verify(acc);
  assert.equal(wrong.ok, false, 'key belongs to another account');
  assert.equal(wrong.as, 'someone-else');
  H.setSshUsers({ 'github.com-work': 'work' });
  assert.deepEqual((({ ok, as }) => ({ ok, as }))(await ssh.verify(acc)), { ok: true, as: 'work' });
});

test('setupSSH (GitHub, non-active account): asks for the admin:public_key permission once, uploads, verifies, restores active account', async () => {
  H.setGhAccounts([
    { host: 'github.com', login: 'perso', token: 'tok-perso', active: true },
    { host: 'github.com', login: 'work', token: 'tok-work', active: false },
  ]);
  H.setSshUsers({ 'github.com-work': 'work' });
  const acc = new Accounts(H.tmpDir('userdata'), secrets);
  const steps = [];
  let code;
  const r = await acc.setupSSH('github:github.com/work', {
    onStep: (s) => steps.push(`${s.i}:${s.state}`),
    onCode: (c) => { code = c; fs.writeFileSync(H.GH_APPROVE, 'ok'); },
    title: 'Nebula — test',
  });
  assert.equal(r.verified, true);
  assert.equal(r.alias, 'github.com-work');
  assert.deepEqual(code, { code: 'WXYZ-9876', url: 'https://github.com/login/device' });
  assert.deepEqual(steps, ['0:run', '0:done', '1:run', '1:done', '2:run', '2:code', '2:done', '3:run', '3:done']);
  const st = H.ghAccounts();
  const work = st.find((a) => a.login === 'work');
  assert.ok(work.scopes.includes('admin:public_key'), 'scope granted to the work account');
  assert.equal(work.keys.length, 1);
  assert.equal(work.keys[0], fs.readFileSync(`${ssh.keyFile({ host: 'github.com', login: 'work' })}.pub`, 'utf8').trim());
  assert.equal(st.find((a) => a.login === 'perso').keys, undefined, 'nothing uploaded to the other account');
  assert.deepEqual(st.filter((a) => a.active).map((a) => a.login), ['perso'], 'active gh account restored');
  const uploads = H.ghLog().filter((l) => l.argv[0] === 'api');
  assert.ok(uploads.every((u) => u.token === 'tok-work'));
  assert.equal((await acc.list()).find((a) => a.login === 'work').ssh.ready, true);

  // second run: key already uploaded → idempotent, no new permission prompt
  H.resetGh();
  H.setGhAccounts(st);
  H.setSshUsers({ 'github.com-work': 'work' });
  let asked = false;
  await acc.setupSSH('github:github.com/work', { onCode: () => { asked = true; } });
  assert.equal(asked, false);
  assert.equal(H.ghAccounts().find((a) => a.login === 'work').keys.length, 1);
});

test('setupSSH fails clearly when the server rejects the key', async () => {
  H.setGhAccounts([{ host: 'github.com', login: 'work', token: 'tok-work', active: true, scopes: ['repo', 'admin:public_key'] }]);
  const acc = new Accounts(H.tmpDir('userdata'), secrets);
  const steps = [];
  await assert.rejects(acc.setupSSH('github:github.com/work', { onStep: (s) => steps.push(`${s.i}:${s.state}`) }), /SSH test failed: .*Permission denied/);
  assert.equal(steps.at(-1), '3:fail');
});

test('setupSSH (GitLab): uploads through the API with the account token', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, method: req.method, token: req.headers['private-token'], body: body && JSON.parse(body) });
      res.writeHead(req.url === '/api/v4/user' ? 200 : 201, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url === '/api/v4/user' ? { username: 'gl-user', name: 'C' } : { id: 1 }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const acc = new Accounts(H.tmpDir('userdata'), secrets);
    const a = await acc.gitlabAdd({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: 'glpat-x' });
    H.setSshUsers({ '127.0.0.1-gl-user': 'gl-user' });
    const r = await acc.setupSSH(a.id, {});
    assert.equal(r.alias, '127.0.0.1-gl-user', 'port is not part of the ssh alias');
    const post = seen.find((s) => s.url === '/api/v4/user/keys');
    assert.equal(post.token, 'glpat-x');
    assert.match(post.body.key, /^ssh-ed25519 /);
  } finally { server.close(); }
});

test('resolve(): an SSH alias remote selects its account; PRs go to the real host with --repo', async () => {
  H.setGhAccounts([
    { host: 'github.com', login: 'perso', token: 'tok-perso', active: true },
    { host: 'github.com', login: 'work', token: 'tok-work', active: false },
  ]);
  ssh.writeConfig({ host: 'github.com', login: 'work' });
  const acc = new Accounts(H.tmpDir('userdata'), secrets);
  const d = H.initRepo('alias-repo');
  H.sh(d, ['remote', 'add', 'origin', 'git@github.com-work:company/api.git']);
  const r = await acc.resolve(d);
  assert.equal(r.remote.host, 'github.com');
  assert.equal(r.remote.sshAlias, 'github.com-work');
  assert.equal(r.account.login, 'work');
  assert.equal(r.token, 'tok-work');
  await git.open(d);
  git.setAuthResolver((repo) => acc.resolve(repo));
  await git.prs();
  const call = H.ghLog().find((l) => l.argv[0] === 'pr');
  assert.deepEqual(call.argv.slice(-2), ['--repo', 'github.com/company/api']);
  assert.equal(call.token, 'tok-work');
});
