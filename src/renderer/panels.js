// Resizable / collapsible side panels (sidebar on the left, details on the right).

const PANELS = {
  side: { def: 250, min: 180, max: 420, key: 'sideW', cssVar: '--side-w', cls: 'side-collapsed' },
  detail: { def: 380, min: 300, max: 640, key: 'detailW', cssVar: '--detail-w', cls: 'detail-collapsed' },
};
const MIN_GRAPH = 420; // the commit graph always keeps room to breathe
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

function panelWidth(name) { return parseInt(getComputedStyle(document.documentElement).getPropertyValue(PANELS[name].cssVar), 10) || PANELS[name].def; }
function setPanelWidth(name, w, { save = true } = {}) {
  const p = PANELS[name];
  const other = name === 'side' ? 'detail' : 'side';
  const otherW = document.body.classList.contains(PANELS[other].cls) ? 0 : panelWidth(other);
  const room = innerWidth - 20 - 20 - otherW - MIN_GRAPH; // margins + gaps
  const clamped = Math.round(Math.max(p.min, Math.min(p.max, room, w)));
  document.documentElement.style.setProperty(p.cssVar, `${clamped}px`);
  if (save) store.set(p.key, clamped);
  return clamped;
}
function setCollapsed(name, collapsed) {
  document.body.classList.toggle(PANELS[name].cls, collapsed);
  store.set(`${name}Collapsed`, collapsed ? '1' : '');
  const s = $(`.splitter[data-split="${name}"]`);
  if (s) s.title = collapsed ? `Drag or double-click to show the ${name === 'side' ? 'sidebar' : 'details'}` : 'Drag to resize · double-click to reset';
}
const togglePanel = (name) => setCollapsed(name, !document.body.classList.contains(PANELS[name].cls));

function bindPanels() {
  for (const name of Object.keys(PANELS)) {
    const saved = Number(store.get(PANELS[name].key));
    setPanelWidth(name, saved || PANELS[name].def, { save: false });
    setCollapsed(name, store.get(`${name}Collapsed`) === '1');
  }
  document.querySelectorAll('.splitter').forEach((grip) => {
    const name = grip.dataset.split;
    const p = PANELS[name];
    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const wasCollapsed = document.body.classList.contains(p.cls);
      const startW = wasCollapsed ? 0 : panelWidth(name);
      document.body.classList.add('resizing');
      grip.classList.add('active');
      const move = (ev) => {
        const dx = ev.clientX - startX;
        const w = startW + (name === 'side' ? dx : -dx);
        if (w < p.min - 60) { if (startW) setPanelWidth(name, startW); setCollapsed(name, true); return; } // drag past the minimum → collapse, remembering the previous width
        if (document.body.classList.contains(p.cls)) setCollapsed(name, false);
        setPanelWidth(name, w);
      };
      const up = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        document.body.classList.remove('resizing');
        grip.classList.remove('active');
        dispatchEvent(new Event('resize')); // terminal / graph re-measure
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
    });
    grip.addEventListener('dblclick', () => {
      if (document.body.classList.contains(p.cls)) setCollapsed(name, false);
      else setPanelWidth(name, p.def);
      dispatchEvent(new Event('resize'));
    });
  });
  addEventListener('resize', () => { for (const n of Object.keys(PANELS)) setPanelWidth(n, panelWidth(n), { save: false }); });
}
bindPanels();
