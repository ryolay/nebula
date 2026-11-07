const { app, BrowserWindow, ipcMain, dialog, Menu, clipboard, shell, nativeTheme, safeStorage, systemPreferences } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const git = require('./git');
const identity = require('./identity');
const { Accounts } = require('./accounts');
const ssh = require('./ssh');
const term = require('./terminal');

let win;
// Test-only: auto-answer native dialogs. Requires BOTH test variables, so it can't trigger by accident.
const TEST_CONFIRM = process.env.NEBULA_SNAPSHOT && process.env.NEBULA_TEST_CONFIRM;
// Tests set NEBULA_NO_EXTERNAL so nothing ever opens the user's real browser.
const openExternal = (url) => (process.env.NEBULA_NO_EXTERNAL ? Promise.resolve() : shell.openExternal(url));
if (process.env.NEBULA_USER_DATA) app.setPath('userData', process.env.NEBULA_USER_DATA); // tests: isolated state
// Tests on a virtual display (Linux CI) have no GPU: software rendering keeps screenshots working.
if (process.env.NEBULA_SNAPSHOT && process.platform === 'linux') app.disableHardwareAcceleration();
const statePath = () => path.join(app.getPath('userData'), 'state.json');
const loadState = () => { try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')); } catch { return { recent: [] }; } };
const saveState = (s) => { try { fs.mkdirSync(path.dirname(statePath()), { recursive: true }); fs.writeFileSync(statePath(), JSON.stringify(s)); } catch {} };

// ---------- appearance ----------
const ACCENTS = [['system', 'macOS accent colour'], ['#6c7cff', 'Indigo'], ['#2f81f7', 'Blue'], ['#14a39a', 'Teal'], ['#8957e5', 'Purple'], ['#db4b8a', 'Pink'], ['#7d8590', 'Graphite']];
const appearance = () => ({ theme: 'system', accent: 'system', ...(loadState().appearance || {}) });
function resolvedAccent() {
  const a = appearance().accent;
  if (a !== 'system') return a;
  try { const c = systemPreferences.getAccentColor(); if (/^[0-9a-f]{6,8}$/i.test(c)) return `#${c.slice(0, 6)}`; } catch {}
  return '#6c7cff';
}
function applyAppearance() {
  nativeTheme.themeSource = appearance().theme;
  win?.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#17181d' : '#eceef2');
  win?.webContents.send('appearance', { accent: resolvedAccent(), theme: appearance().theme });
}
function setAppearance(patchObj) {
  const s = loadState();
  s.appearance = { ...appearance(), ...patchObj };
  saveState(s);
  applyAppearance();
  buildMenu();
}

const IS_MAC = process.platform === 'darwin';
const FILE_MANAGER = IS_MAC ? 'Finder' : process.platform === 'win32' ? 'Explorer' : 'File Manager';
const chromeColors = () => (nativeTheme.shouldUseDarkColors ? { color: '#17181d', symbolColor: '#c9ccd6' } : { color: '#eceef2', symbolColor: '#3a3d47' });
// The repository tab strip doubles as the title bar: traffic lights on macOS,
// native window controls drawn over the right edge on Windows and Linux.
const titleBar = () => (IS_MAC
  ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 18 } }
  : { titleBarStyle: 'hidden', titleBarOverlay: { ...chromeColors(), height: 40 }, autoHideMenuBar: true });

function createWindow() {
  nativeTheme.themeSource = appearance().theme;
  win = new BrowserWindow({
    width: 1480, height: 920, minWidth: 1000, minHeight: 600,
    ...titleBar(),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#17181d' : '#eceef2',
    show: false,
    acceptFirstMouse: true, // macOS: the click that focuses the window must also press the button
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (process.env.NEBULA_SNAPSHOT && process.env.NEBULA_WIN_BOUNDS) { // tests: deterministic window position for real-click tests
    const [x, y, width, height] = process.env.NEBULA_WIN_BOUNDS.split(',').map(Number);
    win.setBounds({ x, y, width, height });
  }
  win.once('ready-to-show', () => {
    win.show();
    // Real-input tests launch the bundle as a child process, which macOS doesn't bring to the front
    // (Finder/Dock launches do). Bring it forward so OS-level clicks land on it.
    if (process.env.NEBULA_SNAPSHOT && process.env.NEBULA_WIN_BOUNDS) { win.setAlwaysOnTop(true, 'floating'); app.focus({ steal: true }); }
  });
  win.on('focus', () => win.webContents.send('focus'));
  // Links open in the real browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

function rememberRepo(p) {
  const s = loadState();
  s.recent = [p, ...(s.recent || []).filter((r) => r !== p)].slice(0, 12);
  s.last = p;
  saveState(s);
  app.addRecentDocument(p);
  buildMenu();
}

// Repos opened in tabs. IPC calls must name one of these, so the renderer can't point git at arbitrary paths.
const opened = new Set();
let cliRepo = null;
async function openRepo(dir) {
  const info = await git.open(dir);
  opened.add(info.path);
  rememberRepo(info.path);
  return info;
}
const repoArg = (p) => { if (!p || !opened.has(p)) throw new Error('Repository is not open'); return p; };

async function pickRepo() {
  const r = await dialog.showOpenDialog(win, { title: 'Open a Git repository', properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  return openRepo(r.filePaths[0]);
}

// ---------- IPC ----------
const READS = ['info', 'log', 'status', 'refs', 'stashes', 'commit', 'diff', 'prs'];
const WRITES = ['stage', 'stageAll', 'unstage', 'unstageAll', 'discard', 'commitCreate', 'lastMessage', 'checkout', 'checkoutCommit',
  'createBranch', 'deleteBranch', 'deleteRemoteBranch', 'renameBranch', 'merge', 'rebase', 'cherryPick', 'revert', 'reset',
  'createTag', 'deleteTag', 'abort', 'stash', 'stashApply', 'stashPop', 'stashDrop', 'fetch', 'pull', 'push', 'pushBranch',
  'prCheckout', 'prCreate', 'prMerge',
  'prMeta', 'prCompare',
  'issues', 'issueView', 'issueCreate', 'issueComment', 'issueSetState', 'issueAssignMe', 'issueBranch',
  'continueOp', 'skipOp', 'conflictFile', 'resolveFile', 'saveResolution', 'markResolved', 'rebasePlan', 'rebaseInteractive', 'applyPatch',
  'fileHistory', 'blame', 'compare', 'remotes', 'addRemote', 'removeRemote', 'renameRemote', 'setRemoteUrl', 'fetchRemote',
  'worktrees', 'addWorktree', 'removeWorktree', 'submodules', 'submoduleUpdate', 'lfsInfo', 'lfsPull', 'fastForward'];
const ALLOWED = new Set([...READS, ...WRITES]);

ipcMain.handle('git', async (e, name, args, repoPath) => {
  if (!ALLOWED.has(name)) return { error: `Unknown operation ${name}` };
  try {
    const repo = repoArg(repoPath);
    const onProgress = (p) => { if (!e.sender.isDestroyed()) e.sender.send('git:progress', { repo, op: name, ...p }); };
    return { data: await git.withRepo(repo, () => git[name](args || {}), { onProgress }) };
  } catch (err) { return { error: err.message }; }
});

// ---------- identities & accounts ----------
let svc;
function services() {
  if (svc) return svc;
  const dir = app.getPath('userData');
  const secrets = {
    encrypt: (s) => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage is unavailable (macOS Keychain, Windows DPAPI or a Linux secret service is required)');
      return safeStorage.encryptString(s).toString('base64');
    },
    decrypt: (b) => safeStorage.decryptString(Buffer.from(b, 'base64')),
  };
  svc = { profiles: new identity.Profiles(dir), accounts: new Accounts(dir, secrets) };
  git.setAuthResolver((repo) => svc.accounts.resolve(repo));
  return svc;
}
let pendingLogin = null;

const ID_OPS = {
  async state() {
    const { profiles, accounts } = services();
    const list = await profiles.list();
    const accs = await accounts.list().catch((e) => { console.error(e); return []; });
    if (!git.repo) return { profiles: list, accounts: accs };
    const [eff, routing] = await Promise.all([identity.effective(git.repo), accounts.resolve(git.repo).catch(() => null)]);
    const remote = routing?.remote || (await identity.originOf(git.repo).catch(() => null));
    const sug = identity.suggest(list, git.repo, remote);
    const current = list.find((p) => p.email.toLowerCase() === (eff.email?.value || '').toLowerCase()) || null;
    return {
      profiles: list, accounts: accs, effective: eff, remote, currentProfileId: current?.id || null,
      globalEmail: (await git.gitAt(require('node:os').homedir(), ['config', '--global', '--get', 'user.email'], { ok: [0, 1] })).trim(),
      suggestion: sug && { profileId: sug.profile.id, reason: sug.reason },
      mismatch: !!sug && sug.profile.email.toLowerCase() !== (eff.email?.value || '').toLowerCase(),
      routing: routing && { provider: routing.provider, accountId: routing.account?.id || null, pinned: routing.pinned, pinnedMissing: routing.pinnedMissing, hasToken: !!routing.token, candidates: routing.candidates.map((c) => c.id) },
    };
  },
  saveProfile: ({ profile }) => services().profiles.save(profile),
  async deleteProfile({ id }) {
    const p = await services().profiles.get(id);
    const ok = await confirmNative(`Delete the identity “${p?.label}”?`, 'Repositories already configured keep their git settings.', 'Delete');
    if (ok) await services().profiles.remove(id);
    return ok;
  },
  async useInRepo({ id }) {
    const p = await services().profiles.get(id);
    if (!p) throw new Error('Unknown identity');
    // If the inherited config (global / includeIf folder rule) already gives this identity,
    // drop the local override instead of adding another one: the repo follows the rule again.
    const eff = await identity.effective(git.repo);
    if (eff.email?.scope === 'local') {
      await identity.clearRepo(git.repo);
      const inherited = await identity.effective(git.repo);
      if ((inherited.email?.value || '').toLowerCase() === p.email.toLowerCase() && (inherited.name?.value || '') === p.name) {
        if (p.account) await git.gitAt(git.repo, ['config', '--local', 'nebula.account', p.account]);
        return { mode: 'inherited', file: inherited.email.file };
      }
    }
    await identity.applyToRepo(git.repo, p);
    return { mode: 'local' };
  },
  clearRepo: () => identity.clearRepo(git.repo),
  async setGlobal({ id }) {
    const p = await services().profiles.get(id);
    const ok = await confirmNative(`Make “${p.label}” your global git identity?`, `git config --global user.name "${p.name}"\ngit config --global user.email "${p.email}"\n\nApplies to every repository without its own identity.`, 'Set as default');
    if (ok) await identity.setGlobal(p);
    return ok;
  },
  async folderPlan({ id, folder }) { return identity.folderRule(await services().profiles.get(id), folder); },
  async folderApply({ id, folder }) {
    const p = await services().profiles.get(id);
    const plan = await identity.folderRule(p, folder);
    const ok = await confirmNative(`Use “${p.label}” for every repository in ${identity.tilde(folder)}?`,
      `Nebula will write:\n\n${plan.includeFile}\n${plan.includeContent}\nand add to ${plan.globalFile}:\n${plan.globalLine}\n\nThis is plain git config: the terminal and your editor will use it too.`, 'Apply rule');
    if (!ok) return false;
    await identity.folderRule(p, folder, { apply: true });
    await services().profiles.save({ ...p, folders: [...p.folders, identity.tilde(folder)] });
    return true;
  },
  async setRepoAccount({ id }) {
    if (id) await git.gitAt(git.repo, ['config', '--local', 'nebula.account', id]);
    else await git.gitAt(git.repo, ['config', '--local', '--unset', 'nebula.account'], { ok: [0, 5] });
    return true;
  },
  async githubLogin({ host }) {
    pendingLogin?.cancel();
    pendingLogin = services().accounts.githubLogin(host || 'github.com', (info) => {
      win?.webContents.send('acc:code', info);
      openExternal(info.url);
    });
    try { return await pendingLogin.promise; } finally { pendingLogin = null; }
  },
  githubCancel: () => { pendingLogin?.cancel(); return true; },
  async setupSSH({ id }) {
    const acc = (await services().accounts.list()).find((a) => a.id === id);
    if (!acc) throw new Error('Unknown account');
    const name = acc.kind === 'gitlab' ? 'GitLab' : 'GitHub';
    const p = ssh.plan(acc, name);
    const ok = await confirmNative(`Set up SSH for ${acc.login} on ${acc.host}?`,
      `${p.steps.map((x, i) => `${i + 1}. ${x}`).join('\n')}\n\nAdded to ${p.configFile}:\n${p.configBlock}\nRepos then use git@${p.alias}:owner/repo.git — that is how several ${name} accounts coexist.`, 'Set up SSH');
    if (!ok) return null;
    pendingLogin?.cancel();
    try {
      return await services().accounts.setupSSH(id, {
        onStep: (st) => win?.webContents.send('acc:ssh', { id, ...st }),
        onCode: (info) => { win?.webContents.send('acc:code', info); openExternal(info.url); },
        track: (dev) => { pendingLogin = dev; },
      });
    } finally { pendingLogin = null; }
  },
  async useSSHRemote({ id }) {
    const r = await services().accounts.resolve(git.repo);
    const acc = (await services().accounts.list()).find((a) => a.id === id);
    if (!r?.remote || !acc) throw new Error('Nothing to switch');
    if (!acc.ssh?.ready) throw new Error('Set up SSH for this account first');
    const remotes = (await git.gitAt(git.repo, ['remote'])).split('\n').filter(Boolean);
    const name = remotes.includes('origin') ? 'origin' : remotes[0];
    const before = (await git.gitAt(git.repo, ['config', '--get', `remote.${name}.url`])).trim();
    await git.gitAt(git.repo, ['remote', 'set-url', name, ssh.remoteUrl(acc, r.remote.path)]);
    await git.gitAt(git.repo, ['config', '--local', 'nebula.account', id]);
    await git.gitAt(git.repo, ['config', '--local', 'nebula.previousUrl', before]);
    return true;
  },
  async useHTTPSRemote() {
    const r = await services().accounts.resolve(git.repo);
    if (!r?.remote) throw new Error('No remote');
    const remotes = (await git.gitAt(git.repo, ['remote'])).split('\n').filter(Boolean);
    const name = remotes.includes('origin') ? 'origin' : remotes[0];
    await git.gitAt(git.repo, ['remote', 'set-url', name, `https://${r.remote.host}/${r.remote.path}.git`]);
    return true;
  },
  async githubLogout({ host, login }) {
    const ok = await confirmNative(`Sign out ${login} from ${host}?`, 'This removes the account from the GitHub CLI (gh) on this Mac.', 'Sign out');
    if (ok) await services().accounts.githubLogout(host, login);
    return ok;
  },
  githubSwitch: ({ host, login }) => services().accounts.githubSwitch(host, login),
  gitlabAdd: (a) => services().accounts.gitlabAdd(a),
  async gitlabRemove({ id }) {
    const ok = await confirmNative('Remove this GitLab account from Nebula?', 'Its token is deleted from Nebula. Revoke it on GitLab too if you no longer need it.', 'Remove');
    if (ok) services().accounts.gitlabRemove(id);
    return ok;
  },
  async pickFolder() {
    const r = await dialog.showOpenDialog(win, { title: 'Choose a folder', properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  },
};
async function confirmNative(message, detail, ok) {
  if (TEST_CONFIRM) { console.log(`NEBULA_CONFIRM ${message}`); return TEST_CONFIRM === 'yes'; }
  const r = await dialog.showMessageBox(win, { type: 'question', message, detail, buttons: [ok, 'Cancel'], defaultId: 0, cancelId: 1 });
  return r.response === 0;
}
ipcMain.handle('id', async (_e, name, args, repoPath) => {
  if (!Object.hasOwn(ID_OPS, name)) return { error: `Unknown operation ${name}` };
  try {
    const repo = repoPath ? repoArg(repoPath) : null;
    return { data: await git.withRepo(repo, () => ID_OPS[name](args || {})) };
  } catch (e) { return { error: e.message }; }
});

ipcMain.handle('app:open', async (_e, dir) => {
  try { return { data: dir ? await openRepo(dir) : await pickRepo() }; } catch (e) { return { error: e.message }; }
});
ipcMain.handle('app:state', () => ({ ...loadState(), cli: cliRepo }));
ipcMain.handle('app:appearance', () => ({ accent: resolvedAccent(), theme: appearance().theme }));
ipcMain.handle('app:tabs', (_e, { paths, active }) => {
  const s = loadState();
  s.tabs = (paths || []).filter((p) => opened.has(p));
  s.active = active;
  saveState(s);
  const name = active ? path.basename(active) : null;
  win?.setTitle(name ? `${name} — Nebula` : 'Nebula');
  return true;
});
ipcMain.handle('app:copy', (_e, text) => { clipboard.writeText(String(text)); return true; });
ipcMain.handle('app:external', (_e, url) => { if (/^https:\/\//.test(url)) openExternal(url); return true; });
// ---------- launchpad: recent repos, clone, init ----------
const SAFE_NAME = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;
async function repoMeta(p) {
  if (!fs.existsSync(path.join(p, '.git')) && !fs.existsSync(path.join(p, 'HEAD'))) return { path: p, name: path.basename(p), missing: !fs.existsSync(p), notRepo: fs.existsSync(p) };
  const g = (args) => git.gitAt(p, args, { ok: [0, 1, 128] }).then((o) => o.trim()).catch(() => '');
  const [remoteUrl, branch] = await Promise.all([g(['config', '--get', 'remote.origin.url']), g(['branch', '--show-current'])]);
  let mtime = 0; try { mtime = fs.statSync(path.join(p, '.git')).mtimeMs; } catch {}
  return { path: p, name: path.basename(p), remoteUrl, branch, mtime };
}
const defaultCloneParent = () => {
  const s = loadState();
  if (s.cloneParent && fs.existsSync(s.cloneParent)) return s.cloneParent;
  for (const d of ['Developer', 'Projects', 'Code', 'code', 'dev']) { const p = path.join(require('node:os').homedir(), d); if (fs.existsSync(p)) return p; }
  return require('node:os').homedir();
};
ipcMain.handle('app:recent', async () => {
  const s = loadState();
  return { recent: await Promise.all((s.recent || []).map(repoMeta)), cloneParent: defaultCloneParent(), home: require('node:os').homedir() };
});
ipcMain.handle('app:forgetRecent', (_e, p) => { const s = loadState(); s.recent = (s.recent || []).filter((r) => r !== p); saveState(s); buildMenu(); return true; });
ipcMain.handle('app:pickFolder', async (_e, { title } = {}) => {
  const r = await dialog.showOpenDialog(win, { title: title || 'Choose a folder', properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('app:clone', async (e, { url, parent, name, accountId }) => {
  try {
    if (typeof url !== 'string' || !url.trim() || url.startsWith('-')) throw new Error('Enter a repository URL');
    if (!SAFE_NAME.test(name || '')) throw new Error('Folder name may only contain letters, digits, . _ -');
    if (!parent || !fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) throw new Error('Choose an existing destination folder');
    const dest = path.join(parent, name);
    if (fs.existsSync(dest)) throw new Error(`${dest} already exists`);
    const remote = identity.parseRemote(url.trim());
    const accs = await services().accounts.list().catch(() => []);
    const alias = remote && ssh.aliases().find((a) => a.alias === remote.host);
    const host = alias ? alias.host : remote?.host;
    const acc = accs.find((a) => a.id === accountId) || accs.find((a) => a.host === host && a.active) || accs.find((a) => a.host === host);
    const token = acc && remote?.protocol === 'https' ? await services().accounts.token(acc.id).catch(() => null) : null;
    const env = git.authEnv({ token, provider: acc?.kind, remote });
    const onProgress = (p) => { if (!e.sender.isDestroyed()) e.sender.send('git:progress', { repo: 'clone', op: 'clone', ...p }); };
    await git.runStream('git', ['clone', '--progress', '--', url.trim(), name], { cwd: parent, env, onProgress });
    if (acc) await git.gitAt(dest, ['config', '--local', 'nebula.account', acc.id]).catch(() => {});
    const s = loadState(); s.cloneParent = parent; saveState(s);
    return { data: await openRepo(dest) };
  } catch (err) { return { error: err.message }; }
});
ipcMain.handle('app:init', async (_e, { parent, name, readme }) => {
  try {
    if (!SAFE_NAME.test(name || '')) throw new Error('Folder name may only contain letters, digits, . _ -');
    if (!parent || !fs.existsSync(parent)) throw new Error('Choose an existing parent folder');
    const dest = path.join(parent, name);
    if (fs.existsSync(dest) && fs.readdirSync(dest).length) throw new Error(`${dest} already exists and is not empty`);
    fs.mkdirSync(dest, { recursive: true });
    await git.gitAt(dest, ['init', '-b', 'main']);
    if (readme) {
      fs.writeFileSync(path.join(dest, 'README.md'), `# ${name}\n`);
      await git.gitAt(dest, ['add', 'README.md']);
      await git.gitAt(dest, ['commit', '-m', 'Initial commit']);
    }
    return { data: await openRepo(dest) };
  } catch (err) { return { error: err.message }; }
});
ipcMain.handle('acc:repos', async (_e, { id }) => {
  try {
    const acc = (await services().accounts.list()).find((a) => a.id === id);
    if (!acc) throw new Error('Unknown account');
    return { data: await services().accounts.remoteRepos(acc) };
  } catch (err) { return { error: err.message }; }
});
ipcMain.handle('acc:list', async () => { try { return { data: await services().accounts.list() }; } catch (err) { return { error: err.message }; } });

const fileIn = (repo, rel) => {
  if (!opened.has(repo)) throw new Error('Repository is not open');
  const abs = path.resolve(repo, rel);
  if (abs !== repo && !abs.startsWith(repo + path.sep) && !opened.has(abs)) throw new Error('Path is outside the repository');
  return abs;
};
ipcMain.handle('app:openFile', (_e, repo, rel) => { try { shell.openPath(fileIn(repo, rel)); } catch {} return true; });
ipcMain.handle('app:revealFile', (_e, repo, rel) => { try { const abs = rel === '.' ? repo : fileIn(repo, rel); if (opened.has(repo) || opened.has(abs)) shell.showItemInFolder(abs); } catch {} return true; });
ipcMain.handle('app:reveal', (_e, p) => { if (opened.has(p)) shell.openPath(p); return true; });

// ---------- integrated terminal (one real PTY per repository tab) ----------
ipcMain.handle('term:create', (e, { repo, cols, rows }) => {
  try {
    if (!opened.has(repo)) throw new Error('Repository is not open');
    return { data: term.create({ cwd: repo, cols, rows, sender: e.sender }) };
  } catch (err) { return { error: err.message }; }
});
ipcMain.on('term:write', (_e, { id, data }) => term.write(id, data));
ipcMain.on('term:resize', (_e, { id, cols, rows }) => term.resize(id, cols, rows));
ipcMain.handle('term:kill', (_e, { id }) => { term.kill(id); return true; });
ipcMain.handle('term:busy', (_e, { id }) => term.busy(id));

// Native confirm dialog
ipcMain.handle('app:confirm', async (_e, { message, detail, ok = 'OK', danger }) => {
  if (TEST_CONFIRM) { console.log(`NEBULA_CONFIRM ${message}`); return TEST_CONFIRM === 'yes'; }
  const r = await dialog.showMessageBox(win, {
    type: danger ? 'warning' : 'question', message, detail, buttons: [ok, 'Cancel'], defaultId: danger ? 1 : 0, cancelId: 1,
  });
  return r.response === 0;
});

// Native context menu: renderer sends [{id,label,type?,enabled?}] and gets the chosen id back.
ipcMain.handle('app:menu', (_e, items) => new Promise((resolve) => {
  let chosen = null;
  const build = (list) => list.map((it) => it.type === 'separator' ? { type: 'separator' } : {
    label: it.label, enabled: it.enabled !== false,
    ...(it.submenu ? { submenu: build(it.submenu) } : { click: () => { chosen = it.id; } }),
  });
  Menu.buildFromTemplate(build(items)).popup({ window: win, callback: () => setTimeout(() => resolve(chosen), 0) });
}));

// ---------- app menu ----------
function buildMenu() {
  const recent = (loadState().recent || []).map((p) => ({ label: p, click: () => win?.webContents.send('openPath', p) }));
  const send = (ch) => () => win?.webContents.send('cmd', ch);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(IS_MAC ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [
      { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: send('newTab') },
      { label: 'Open Repository…', accelerator: 'CmdOrCtrl+O', click: send('open') },
      { label: 'Open Recent', submenu: recent.length ? recent : [{ label: 'No recent repositories', enabled: false }] },
      { type: 'separator' },
      { label: `Reveal in ${FILE_MANAGER}`, accelerator: 'CmdOrCtrl+Shift+R', click: send('reveal') },
      { type: 'separator' },
      { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: send('closeTab') },
      { label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W', role: 'close' },
      ...(IS_MAC ? [] : [{ type: 'separator' }, { role: 'quit' }]),
    ] },
    { label: 'Edit', submenu: [
      // ⌘Z undoes text edits inside fields, and git actions everywhere else (decided by the renderer)
      { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: send('undoKey') },
      { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', click: send('redoKey') },
      { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
    ] },
    { label: 'Repository', submenu: [
      { label: 'Refresh', accelerator: 'CmdOrCtrl+R', click: send('refresh') },
      { label: 'Fetch', accelerator: 'CmdOrCtrl+Shift+F', click: send('fetch') },
      { label: 'Pull', accelerator: 'CmdOrCtrl+Shift+L', click: send('pull') },
      { label: 'Push', accelerator: 'CmdOrCtrl+Shift+P', click: send('push') },
      { type: 'separator' },
      { label: 'New Branch…', accelerator: 'CmdOrCtrl+B', click: send('branch') },
      { label: 'Stash Changes', accelerator: 'CmdOrCtrl+Shift+S', click: send('stash') },
      { label: 'Pop Stash', accelerator: 'CmdOrCtrl+Shift+O', click: send('pop') },
      { label: 'New Pull Request…', click: send('pr') },
      { type: 'separator' },
      { label: 'Find Commit', accelerator: 'CmdOrCtrl+F', click: send('find') },
      { type: 'separator' },
      { label: 'Accounts & Identities…', accelerator: 'CmdOrCtrl+,', click: send('identities') },
      { type: 'separator' },
      { label: 'Terminal', accelerator: 'Ctrl+`', click: send('terminal') },
      { label: 'Show/Hide Sidebar', accelerator: 'Alt+CmdOrCtrl+S', click: send('toggleSidebar') },
      { label: 'Show/Hide Details', accelerator: 'Alt+CmdOrCtrl+D', click: send('toggleDetails') },
      { type: 'separator' },
      { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: send('nextTab') },
      { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: send('prevTab') },
    ] },
    { label: 'View', submenu: [
      { label: 'Appearance', submenu: [
        ...[['system', IS_MAC ? 'Match macOS' : 'Match system'], ['light', 'Light'], ['dark', 'Dark']].map(([id, label]) => ({ label, type: 'radio', checked: appearance().theme === id, click: () => setAppearance({ theme: id }) })),
        { type: 'separator' },
        ...ACCENTS.map(([id, label]) => ({ label, type: 'radio', checked: appearance().accent === id, click: () => setAppearance({ accent: id }) })),
      ] },
      { type: 'separator' },
      { role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' },
    ] },
    { role: 'windowMenu' },
  ]));
}

app.whenReady().then(async () => {
  services();
  nativeTheme.on('updated', () => {
    win?.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#17181d' : '#eceef2');
    if (!IS_MAC) { try { win?.setTitleBarOverlay(chromeColors()); } catch {} }
  });
  try { systemPreferences.subscribeNotification('AppleColorPreferencesChangedNotification', () => applyAppearance()); } catch {}
  buildMenu();
  createWindow();
  cliRepo = process.argv.slice(app.isPackaged ? 1 : 2).find((a) => !a.startsWith('-')) || null; // the renderer opens it as a tab
  // Test/dev hook (only active when NEBULA_SNAPSHOT is set): run NEBULA_EVAL in the
  // renderer, print its JSON result + any renderer errors, capture the window, quit.
  if (process.env.NEBULA_SNAPSHOT) {
    win.webContents.on('console-message', (e) => { if (e.level === 'warning' || e.level === 'error') console.log(`NEBULA_CONSOLE ${e.message}`); });
    setTimeout(async () => {
      if (process.env.NEBULA_EVAL) {
        try {
          const res = await win.webContents.executeJavaScript(process.env.NEBULA_EVAL);
          console.log(`NEBULA_EVAL_RESULT ${JSON.stringify(res ?? null)}`);
        } catch (e) { console.log(`NEBULA_EVAL_ERROR ${e.message}`); }
      }
      setTimeout(async () => {
        try { fs.writeFileSync(process.env.NEBULA_SNAPSHOT, (await win.webContents.capturePage()).toPNG()); } catch (e) { console.log(`NEBULA_CONSOLE capture failed: ${e.message}`); }
        app.quit();
      }, 800);
    }, 2500);
  }
});
app.on('before-quit', () => term.killAll());
app.on('window-all-closed', () => { term.killAll(); app.quit(); });
