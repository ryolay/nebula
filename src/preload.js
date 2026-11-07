const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('nebula', {
  git: async (name, args, repo) => {
    const r = await ipcRenderer.invoke('git', name, args, repo);
    if (r.error) throw new Error(r.error);
    return r.data;
  },
  open: async (dir) => {
    const r = await ipcRenderer.invoke('app:open', dir);
    if (r.error) throw new Error(r.error);
    return r.data;
  },
  id: async (name, args, repo) => {
    const r = await ipcRenderer.invoke('id', name, args, repo);
    if (r.error) throw new Error(r.error);
    return r.data;
  },
  pathForFile: (f) => webUtils.getPathForFile(f),
  state: () => ipcRenderer.invoke('app:state'),
  copy: (t) => ipcRenderer.invoke('app:copy', t),
  external: (u) => ipcRenderer.invoke('app:external', u),
  reveal: (p) => ipcRenderer.invoke('app:reveal', p),
  saveTabs: (t) => ipcRenderer.invoke('app:tabs', t),
  recent: () => ipcRenderer.invoke('app:recent'),
  appearance: () => ipcRenderer.invoke('app:appearance'),
  term: {
    create: async (o) => { const r = await ipcRenderer.invoke('term:create', o); if (r.error) throw new Error(r.error); return r.data; },
    write: (id, data) => ipcRenderer.send('term:write', { id, data }),
    resize: (id, cols, rows) => ipcRenderer.send('term:resize', { id, cols, rows }),
    kill: (id) => ipcRenderer.invoke('term:kill', { id }),
    busy: (id) => ipcRenderer.invoke('term:busy', { id }),
  },
  openFile: (repo, rel) => ipcRenderer.invoke('app:openFile', repo, rel),
  revealFile: (repo, rel) => ipcRenderer.invoke('app:revealFile', repo, rel),
  forgetRecent: (p) => ipcRenderer.invoke('app:forgetRecent', p),
  pickFolder: (o) => ipcRenderer.invoke('app:pickFolder', o),
  clone: async (o) => { const r = await ipcRenderer.invoke('app:clone', o); if (r.error) throw new Error(r.error); return r.data; },
  init: async (o) => { const r = await ipcRenderer.invoke('app:init', o); if (r.error) throw new Error(r.error); return r.data; },
  accounts: async () => { const r = await ipcRenderer.invoke('acc:list'); if (r.error) throw new Error(r.error); return r.data; },
  accountRepos: async (id) => { const r = await ipcRenderer.invoke('acc:repos', { id }); if (r.error) throw new Error(r.error); return r.data; },
  confirm: (o) => ipcRenderer.invoke('app:confirm', o),
  menu: (items) => ipcRenderer.invoke('app:menu', items),
  on: (ch, fn) => {
    if (!['reload', 'cmd', 'focus', 'acc:code', 'acc:ssh', 'git:progress', 'openPath', 'appearance', 'term:data', 'term:exit'].includes(ch)) return;
    ipcRenderer.on(ch, (_e, ...a) => fn(...a));
  },
});
