// Stand-in for the tinyjs bridge so the real frontend runs in a plain browser
// (docs screenshots only). Files load through the preview server; saving and
// native dialogs are no-ops. The self-test config comes from the URL hash.
window.tiny = (() => {
  const config = location.hash.length > 1 ? JSON.parse(decodeURIComponent(location.hash.slice(1))) : null;
  const store = {};
  return {
    fileURL: (p) => '/file?p=' + encodeURIComponent(p),
    api: {
      call: async (method) => {
        if (method === 'selftestConfig') return config && { quit: false, ...config };
        if (method === 'saveBegin') return 1;
        if (method === 'saveEnd') return 0;
        return true;
      },
      on: () => () => {},
    },
    store: { set: async (k, v) => { store[k] = v; window.__store = store; }, get: async (k) => store[k] },
    dialog: { openFiles: async () => null, saveFile: async () => null, alert: async () => {}, confirm: async () => false },
    menu: { set: async () => {}, on: () => {} },
    win: { onDrop: () => {}, setFullscreen: () => {} },
    app: { shell: { open: (u) => window.open(u, '_blank'), reveal: () => {} } },
    quit: () => {},
  };
})();
