// Integrated terminal: a real login shell per repository tab (xterm.js + node-pty), in a resizable bottom panel.

const TERM = { open: false, height: 260 };
try { TERM.height = Math.min(700, Math.max(140, +localStorage.getItem('termHeight') || 260)); } catch {}

/** ANSI palette built from the app's theme tokens so the terminal matches light and dark. */
/**
 * Copy/paste conventions. macOS: ⌘C copies the selection, ⌘K clears, ⌘V pastes (Edit menu).
 * Windows/Linux: Ctrl+Shift+C / Ctrl+Shift+V, and Ctrl+C copies when text is selected
 * (otherwise it interrupts the running command, as in any terminal).
 */
function terminalKey(e, xterm) {
  if (e.type !== 'keydown') return true;
  if (IS_MAC) {
    if (!e.metaKey) return true;
    if (e.key === 'c' && xterm.hasSelection()) { api.copy(xterm.getSelection()); return false; }
    if (e.key === 'k') { xterm.clear(); return false; }
    return true; // other ⌘ shortcuts (tabs, ⌘W…) keep working
  }
  if (!e.ctrlKey || e.altKey) return true;
  const k = e.key.toLowerCase();
  if (k === 'c' && (e.shiftKey || xterm.hasSelection())) { if (xterm.hasSelection()) api.copy(xterm.getSelection()); return false; }
  if (k === 'v' && (e.shiftKey || PLATFORM === 'win32')) { navigator.clipboard.readText().then((t) => t && xterm.paste(t)).catch(() => {}); return false; }
  return true;
}

function termTheme() {
  const css = getComputedStyle(document.documentElement);
  const v = (n) => css.getPropertyValue(n).trim();
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  return {
    background: v('--field'), foreground: v('--text'), cursor: v('--accent'), cursorAccent: v('--field'),
    selectionBackground: dark ? 'rgba(108,124,255,.35)' : 'rgba(47,111,209,.22)',
    black: dark ? '#2b2e37' : '#1b1d23', red: v('--red'), green: v('--green'), yellow: v('--amber'), blue: v('--blue'), magenta: v('--violet'),
    cyan: dark ? '#39c5e6' : '#0a7a96', white: dark ? '#c9cdd8' : '#6b7180',
    brightBlack: v('--text-3'), brightRed: v('--red'), brightGreen: v('--green'), brightYellow: v('--amber'), brightBlue: v('--blue'),
    brightMagenta: v('--violet'), brightCyan: dark ? '#6fd6ee' : '#0b6f88', brightWhite: v('--text'),
  };
}

function layoutForTerminal() {
  document.body.classList.toggle('term-on', TERM.open);
  document.documentElement.style.setProperty('--term-h', `${TERM.height}px`);
  $('#tbTerm')?.classList.toggle('on', TERM.open);
}

async function ensureSession(tab) {
  if (tab.term?.alive) return tab.term;
  const host = document.createElement('div');
  host.className = 'term-host';
  $('#termBody').append(host);
  // load the icon font first so xterm measures cells with it available (prompt icons, powerline arrows)
  await document.fonts.load("12px 'Symbols Nerd Font Mono'").catch(() => {});
  const xterm = new Terminal({
    fontFamily: "'SF Mono', Menlo, Consolas, 'Cascadia Mono', 'DejaVu Sans Mono', 'Ubuntu Mono', 'Symbols Nerd Font Mono', monospace", fontSize: 12, lineHeight: 1.25, cursorBlink: true,
    allowProposedApi: false, scrollback: 5000, theme: termTheme(), macOptionIsMeta: true, drawBoldTextInBrightColors: false,
  });
  const fit = new FitAddon.FitAddon();
  xterm.loadAddon(fit);
  xterm.open(host);
  fit.fit();
  let session;
  try { session = await api.term.create({ repo: tab.path, cols: xterm.cols, rows: xterm.rows }); } catch (e) {
    xterm.write(`\x1b[31m${e.message}\x1b[0m\r\n`);
    tab.term = { host, xterm, fit, alive: false };
    return tab.term;
  }
  tab.term = { id: session.id, shell: session.shell, host, xterm, fit, alive: true };
  xterm.onData((d) => {
    api.term.write(session.id, d);
    if (d.includes('\r')) scheduleRefresh(tab); // a command was run: git state may have changed
  });
  xterm.onResize(({ cols, rows }) => api.term.resize(session.id, cols, rows));
  xterm.attachCustomKeyEventHandler((e) => terminalKey(e, xterm));
  renderTermHeader();
  return tab.term;
}

let refreshTimer = null;
function scheduleRefresh(tab) {
  clearTimeout(refreshTimer);
  const run = () => { if (S.tab === tab) reload({ soft: true }).catch(() => {}); };
  refreshTimer = setTimeout(() => { run(); refreshTimer = setTimeout(run, 2500); }, 700);
}

function showTabTerminal() {
  $$('#termBody .term-host').forEach((h) => { h.hidden = true; });
  const t = S.tab?.term;
  if (t) { t.host.hidden = false; requestAnimationFrame(() => { try { t.fit.fit(); } catch {} }); }
  renderTermHeader();
}

function renderTermHeader() {
  const t = S.tab?.term;
  $('#termTitle').innerHTML = S.tab?.info
    ? `${icon('terminal')}<b>${esc(S.tab.info.name)}</b><span>${esc(t?.shell || 'shell')}${t && !t.alive ? ' · exited' : ''}</span>`
    : `${icon('terminal')}<b>Terminal</b><span>open a repository first</span>`;
  $('#termRestart').hidden = !(t && !t.alive);
}

async function toggleTerminal(force) {
  const next = typeof force === 'boolean' ? force : !TERM.open;
  if (next && !S.tab?.info) return hudInfo('Open a repository to use its terminal', 'terminal');
  TERM.open = next;
  layoutForTerminal();
  if (TERM.open) {
    const t = await ensureSession(S.tab);
    showTabTerminal();
    setTimeout(() => t.xterm.focus(), 30);
  }
}

/** Called when the active repository tab changes or closes. */
function terminalTabChanged() {
  if (!TERM.open) return;
  if (!S.tab?.info) { TERM.open = false; layoutForTerminal(); return; }
  ensureSession(S.tab).then(showTabTerminal);
}
async function terminalTabClosed(tab) {
  if (!tab.term) return;
  if (tab.term.alive) api.term.kill(tab.term.id);
  tab.term.xterm.dispose();
  tab.term.host.remove();
  tab.term = null;
}

function bindTerminal() {
  api.on('term:data', ({ id, data }) => { for (const t of S.tabs) if (t.term?.id === id) t.term.xterm.write(data); });
  api.on('term:exit', ({ id, code }) => {
    for (const t of S.tabs) if (t.term?.id === id) {
      t.term.alive = false;
      t.term.xterm.write(`\r\n\x1b[2m[process exited with code ${code}]\x1b[0m\r\n`);
    }
    renderTermHeader();
  });
  $('#termClose').onclick = () => toggleTerminal(false);
  $('#termClear').onclick = () => { S.tab?.term?.xterm.clear(); S.tab?.term?.xterm.focus(); };
  $('#termRestart').onclick = async () => { const tab = S.tab; await terminalTabClosed(tab); await ensureSession(tab); showTabTerminal(); tab.term.xterm.focus(); };
  // drag the top edge to resize
  const grip = $('#termGrip');
  grip.addEventListener('pointerdown', (e) => {
    grip.setPointerCapture(e.pointerId);
    const startY = e.clientY, startH = TERM.height;
    const move = (ev) => { TERM.height = Math.min(Math.round(innerHeight * 0.7), Math.max(140, startH + (startY - ev.clientY))); layoutForTerminal(); S.tab?.term?.fit.fit(); };
    const up = () => { grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); try { localStorage.setItem('termHeight', TERM.height); } catch {} };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
  });
  addEventListener('resize', () => { if (TERM.open) S.tab?.term?.fit.fit(); });
  const retheme = () => { for (const t of S.tabs) if (t.term) t.term.xterm.options.theme = termTheme(); };
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', retheme);
  api.on('appearance', () => setTimeout(retheme, 0)); // accent → cursor colour
  layoutForTerminal();
}
bindTerminal();
