// PWA extras for the web version only: an "Install" button when the browser
// offers one, and an offline note. tools/build-web.js loads this after app.js;
// the desktop app never sees it.
(() => {
  const header = document.querySelector('header h1');
  if (!header) return;

  // "Install app" appears only when the browser fires beforeinstallprompt
  // (Chrome/Edge/Firefox desktop, Chrome Android). iOS Safari has no such
  // event; its users install from the Share menu, which the About text covers.
  let deferred = null;
  const button = document.createElement('button');
  button.id = 'installBtn';
  button.className = 'install';
  button.textContent = 'Install app';
  button.title = 'Save Burst Super-Res to this device. It keeps working offline, and your photos never leave it.';
  button.hidden = true;
  button.addEventListener('click', async () => {
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice;
    deferred = null;
    button.hidden = true;
  });
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    button.hidden = false;
    header.after(button);
  });
  window.addEventListener('appinstalled', () => { button.hidden = true; deferred = null; });

  // Offline status, so a dropped connection while traveling is not a mystery.
  const note = document.createElement('span');
  note.id = 'offlineNote';
  note.className = 'offline-note';
  note.hidden = true;
  note.textContent = 'Offline — everything still works';
  const setOnline = () => { note.hidden = navigator.onLine; };
  window.addEventListener('online', setOnline);
  window.addEventListener('offline', setOnline);
  setOnline();
  document.querySelector('footer .muted')?.after(note);

  // Register the service worker: makes the installed app open offline and
  // keeps the online page up to date (the worker is network-first, so a new
  // build takes over on the next load).
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => { /* offline simply will not work */ });
    });
  }
})();
