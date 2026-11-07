// One-click SSH per hosting account: a dedicated ed25519 key + a Host alias in
// ~/.ssh/config (github.com-<login>) so several accounts on the same host never
// fight over which key ssh offers.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const sshDir = () => process.env.NEBULA_SSH_DIR || path.join(os.homedir(), '.ssh');
const configPath = () => path.join(sshDir(), 'config');
const HOST_RE = /^[a-z0-9.-]+(:\d+)?$/i;
const LOGIN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function check(acc) {
  if (!HOST_RE.test(acc.host || '') || !LOGIN_RE.test(acc.login || '')) throw new Error('Invalid account host/login');
  return { host: acc.host.replace(/:\d+$/, '').toLowerCase(), login: acc.login };
}
const alias = (acc) => { const { host, login } = check(acc); return `${host}-${login.toLowerCase()}`; };
const keyFile = (acc) => { const { host, login } = check(acc); return path.join(sshDir(), `nebula_${host}_${login.toLowerCase()}`); };
const tilde = (p) => (p.startsWith(`${os.homedir()}/`) ? `~${p.slice(os.homedir().length)}` : p);
const markers = (acc) => { const { host, login } = check(acc); return [`# >>> nebula: ${host}/${login}`, `# <<< nebula: ${host}/${login}`]; };

function exec(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 20000, ...opts }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, out: `${stdout}${stderr}` }));
  });
}

/** Host aliases Nebula manages: [{ alias, host, login, identityFile }] */
function aliases() {
  let txt = '';
  try { txt = fs.readFileSync(configPath(), 'utf8'); } catch { return []; }
  const res = [];
  const re = /# >>> nebula: ([^/\s]+)\/(\S+)\n([\s\S]*?)# <<< nebula: \1\/\2/g;
  let m;
  while ((m = re.exec(txt))) {
    const body = m[3];
    res.push({ host: m[1], login: m[2], alias: body.match(/^Host\s+(\S+)/m)?.[1], identityFile: body.match(/IdentityFile\s+(\S+)/)?.[1] });
  }
  return res;
}

function status(acc) {
  const kf = keyFile(acc);
  const inConfig = aliases().some((a) => a.alias === alias(acc));
  return { alias: alias(acc), keyFile: tilde(kf), keyExists: fs.existsSync(kf) && fs.existsSync(`${kf}.pub`), inConfig, ready: inConfig && fs.existsSync(kf) };
}

/** What one click will do, shown to the user before anything is written. */
function plan(acc, providerName) {
  const st = status(acc);
  return {
    ...st,
    configFile: tilde(configPath()),
    configBlock: block(acc),
    steps: [
      st.keyExists ? `Reuse the key ${st.keyFile}` : `Create the key ${st.keyFile} (ed25519)`,
      st.inConfig ? `Keep the Host ${st.alias} entry in ${tilde(configPath())}` : `Add Host ${st.alias} to ${tilde(configPath())}`,
      `Add the public key to your ${providerName} account ${acc.login}`,
      `Test the connection`,
    ],
  };
}

function block(acc) {
  const { host } = check(acc);
  const [open, close] = markers(acc);
  return `${open}\nHost ${alias(acc)}\n  HostName ${host}\n  User git\n  IdentityFile ${tilde(keyFile(acc))}\n  IdentitiesOnly yes\n  AddKeysToAgent yes\n${close}\n`;
}

async function generate(acc, comment) {
  const kf = keyFile(acc);
  fs.mkdirSync(sshDir(), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(kf)) {
    const r = await exec('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', comment.replace(/[\n\r]/g, ' '), '-f', kf]);
    if (r.code !== 0) throw new Error(`ssh-keygen failed: ${r.out.trim()}`);
  }
  return fs.readFileSync(`${kf}.pub`, 'utf8').trim();
}

function writeConfig(acc) {
  fs.mkdirSync(sshDir(), { recursive: true, mode: 0o700 }); // fresh Mac: ~/.ssh may not exist yet
  const file = configPath();
  let txt = '';
  try { txt = fs.readFileSync(file, 'utf8'); } catch {}
  const [open, close] = markers(acc);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${esc(open)}\\n[\\s\\S]*?${esc(close)}\\n?`);
  if (txt && !re.test(txt) && !fs.existsSync(`${file}.nebula-backup`)) fs.copyFileSync(file, `${file}.nebula-backup`);
  const next = re.test(txt) ? txt.replace(re, block(acc)) : `${txt}${txt && !txt.endsWith('\n') ? '\n' : ''}${txt ? '\n' : ''}${block(acc)}`;
  fs.writeFileSync(file, next, { mode: 0o600 });
}

/** ssh -T: GitHub answers "Hi <login>!", GitLab "Welcome to GitLab, @<login>!" (both exit non-zero by design). */
async function verify(acc) {
  const kh = process.env.NEBULA_SSH_DIR ? ['-o', `UserKnownHostsFile=${path.join(sshDir(), 'known_hosts')}`] : []; // tests never touch ~/.ssh
  const r = await exec('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10', ...kh, '-F', configPath(), `git@${alias(acc)}`]);
  const who = r.out.match(/Hi ([\w.-]+)!/)?.[1] || r.out.match(/Welcome to GitLab, @([\w.-]+)!/)?.[1] || null;
  return { ok: !!who && who.toLowerCase() === acc.login.toLowerCase(), as: who, output: r.out.trim().split('\n').slice(-2).join('\n') };
}

const remoteUrl = (acc, repoPath) => `git@${alias(acc)}:${repoPath}.git`;

module.exports = { sshDir, configPath, aliases, alias, keyFile, status, plan, block, generate, writeConfig, verify, remoteUrl };
