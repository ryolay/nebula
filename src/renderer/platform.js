// Platform conventions for the UI: the shortcut modifier, shortcut labels and the
// file manager's name. Labels are written the macOS way in the markup (⌘⇧P) and
// read "Ctrl+Shift+P" on Windows and Linux.
const PLATFORM = window.nebula?.platform || 'darwin';
const IS_MAC = PLATFORM === 'darwin';
const FILE_MANAGER = IS_MAC ? 'Finder' : PLATFORM === 'win32' ? 'Explorer' : 'File Manager';

/** The primary shortcut modifier: ⌘ on macOS, Ctrl elsewhere. */
const modKey = (e) => (IS_MAC ? e.metaKey : e.ctrlKey);

const MODIFIERS = [['⌃', 'Ctrl'], ['⌘', 'Ctrl'], ['⌥', 'Alt'], ['⇧', 'Shift']];
const HAS_GLYPH = /[⌃⌥⇧⌘]/;

/** "⌘⇧P" → "Ctrl+Shift+P", "⌘-click" → "Ctrl-click" (unchanged on macOS). */
function keys(s) {
  if (IS_MAC || !s || !HAS_GLYPH.test(s)) return s;
  return String(s).replace(/([⌃⌥⇧⌘]+)(↵|[^\s)·,]*)/g, (_m, mods, key) => {
    const names = [...new Set(MODIFIERS.filter(([g]) => mods.includes(g)).map(([, n]) => n))];
    const k = key === '↵' ? 'Enter' : key;
    return k.startsWith('-') ? names.join('+') + k : [...names, k].filter(Boolean).join('+');
  });
}

// Tooltips, placeholders and <kbd> labels are rewritten as they appear, so markup
// stays in one convention. User content (diffs, terminal output) is never touched.
function localizeShortcuts(node) {
  if (node.nodeType !== 1) return;
  const els = [node, ...node.querySelectorAll('[title], [placeholder], kbd')];
  for (const el of els) {
    for (const a of ['title', 'placeholder']) {
      const v = el.getAttribute(a);
      if (v && HAS_GLYPH.test(v)) el.setAttribute(a, keys(v));
    }
    if (el.tagName === 'KBD' && HAS_GLYPH.test(el.textContent)) el.textContent = keys(el.textContent);
  }
}

document.documentElement.dataset.platform = PLATFORM;
if (!IS_MAC) {
  document.addEventListener('DOMContentLoaded', () => {
    localizeShortcuts(document.body);
    new MutationObserver((list) => {
      for (const m of list) {
        if (m.type === 'attributes') localizeShortcuts(m.target);
        else m.addedNodes.forEach((n) => (n.nodeType === 3 ? n.parentElement?.tagName === 'KBD' && localizeShortcuts(n.parentElement) : localizeShortcuts(n)));
      }
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['title', 'placeholder'] });
  });
}
