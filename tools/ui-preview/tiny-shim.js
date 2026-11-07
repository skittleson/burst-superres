// Stand-in for the tinyjs bridge so the real frontend runs in a plain browser
// (docs screenshots only). Files load through the preview server; saving and
// native dialogs are no-ops. The self-test config comes from the URL hash.
window.tiny = (() => {
  const config = location.hash.length > 1 ? JSON.parse(decodeURIComponent(location.hash.slice(1))) : null;
  const store = {};
  return {
    fileURL: (p) => '/file?p=' + encodeURIComponent(p),
    api: {
      call: async (method, params = {}) => {
        if (method === 'selftestConfig') return config && { quit: false, ...config };
        if (method === 'listImages') return (await fetch('/list?paths=' + encodeURIComponent(JSON.stringify(params.paths)))).json();
        if (method === 'readHead') return (await fetch('/head?p=' + encodeURIComponent(params.path) + '&n=' + (params.bytes || 70000))).text();
        if (method === 'readRange') return (await fetch('/head?p=' + encodeURIComponent(params.path) + '&o=' + params.offset + '&n=' + params.length)).text();
        if (method === 'saveBegin') return 1;
        if (method === 'saveEnd') return 0;
        return true;
      },
      on: () => () => {},
    },
    store: { set: async (k, v) => { store[k] = v; window.__store = store; }, get: async (k) => store[k] },
    dialog: { openFiles: async () => null, pickFolder: async () => null, saveFile: async () => null, alert: async () => {}, confirm: async () => false },
    menu: { set: async () => {}, on: () => {} },
    win: { onDrop: () => {}, setFullscreen: () => {} },
    app: { shell: { open: (u) => window.open(u, '_blank'), reveal: () => {} } },
    quit: () => {},
  };
})();
