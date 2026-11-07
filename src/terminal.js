// Integrated terminal: real PTYs (node-pty) running the user's login shell inside a repository.
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

let pty;
try { pty = require('node-pty'); } catch (e) { pty = null; console.error('node-pty unavailable:', e.message); }

const sessions = new Map(); // id → { proc, repo, sender }
let seq = 0;

/** The user's shell and its arguments: a login shell on macOS/Linux, PowerShell (or cmd) on Windows. */
function userShell() {
  if (process.platform === 'win32') {
    const sys = process.env.SystemRoot || 'C:\\Windows';
    const pwsh = [process.env.NEBULA_SHELL, path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'), path.join(sys, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')]
      .find((s) => s && fs.existsSync(s));
    return { file: pwsh || process.env.ComSpec || 'cmd.exe', args: pwsh ? ['-NoLogo'] : [] };
  }
  const candidates = [process.env.SHELL, (() => { try { return os.userInfo().shell; } catch { return null; } })(), '/bin/zsh', '/bin/bash', '/bin/sh'];
  return { file: candidates.find((s) => s && fs.existsSync(s)), args: ['-l'] };
}

/** Start a shell in `cwd`. Output and exit are pushed to `sender` (a webContents). */
function create({ cwd, cols = 100, rows = 24, sender }) {
  if (!pty) throw new Error('The terminal component (node-pty) is not available in this build');
  if (!cwd || !fs.existsSync(cwd)) throw new Error('Folder not found');
  const shell = userShell();
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Nebula', LANG: process.env.LANG || 'en_US.UTF-8' };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const k of Object.keys(env)) if (k.startsWith('NEBULA_')) delete env[k]; // never leak test/dev switches into user shells
  const proc = pty.spawn(shell.file, shell.args, { name: 'xterm-256color', cols: Math.max(20, cols | 0), rows: Math.max(5, rows | 0), cwd, env });
  const id = ++seq;
  sessions.set(id, { proc, repo: cwd, sender });
  proc.onData((data) => { if (!sender.isDestroyed()) sender.send('term:data', { id, data }); });
  proc.onExit(({ exitCode }) => {
    sessions.delete(id);
    if (!sender.isDestroyed()) sender.send('term:exit', { id, code: exitCode });
  });
  return { id, shell: path.basename(shell.file).replace(/\.exe$/i, ''), cwd };
}

const get = (id) => sessions.get(id) || null;
function write(id, data) { const s = get(id); if (s && typeof data === 'string' && data.length <= 1_000_000) s.proc.write(data); }
function resize(id, cols, rows) { const s = get(id); if (s && cols > 0 && rows > 0) { try { s.proc.resize(Math.min(cols | 0, 1000), Math.min(rows | 0, 500)); } catch {} } }
function kill(id) { const s = get(id); if (s) { try { s.proc.kill(); } catch {} sessions.delete(id); } }
function killAll() { for (const id of [...sessions.keys()]) kill(id); }
/** Is there a program other than the shell running (e.g. vim, a dev server)? */
function busy(id) { const s = get(id); if (!s) return false; try { return s.proc.process && !/^-?(zsh|bash|fish|sh)$/.test(path.basename(s.proc.process)); } catch { return false; } }

module.exports = { create, write, resize, kill, killAll, busy, available: () => !!pty };
