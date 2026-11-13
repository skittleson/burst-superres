// "Try a sample burst" for the web version: downloads the sample photos
// listed in samples/samples.json (added by tools/build-web.js --samples) and
// adds them like dropped files. No samples.json, no button.
/* global tiny, state, setStatus, setProgress, addDropped */
(async () => {
  const button = document.getElementById('sample');
  let list;
  try {
    const r = await fetch('samples/samples.json');
    if (!r.ok) return;
    list = await r.json();
  } catch { return; }
  const total = list.files.reduce((s, f) => s + f.size, 0);
  button.textContent = `Try a sample burst (${list.files.length} photos, ${Math.round(total / 1048576)} MB)`;
  button.title = list.title;
  button.hidden = false;

  button.addEventListener('click', async () => {
    if (state.busy) return;
    button.disabled = true;
    let got = 0;
    try {
      const files = [];
      for (const f of list.files) {
        const r = await fetch('samples/' + encodeURIComponent(f.name));
        if (!r.ok || !r.body) throw new Error(`${f.name}: HTTP ${r.status}`);
        const reader = r.body.getReader(), parts = [];
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          parts.push(value);
          got += value.length;
          setProgress(got / total);
          setStatus(`Downloading the sample burst… ${Math.round(got / 1048576)} of ${Math.round(total / 1048576)} MB`);
        }
        files.push(new File(parts, f.name, { type: 'image/jpeg' }));
      }
      setProgress(null);
      setStatus('');
      state.photos = [];
      await addDropped(tiny.addFiles(files));
      setStatus(list.note);
    } catch (e) {
      setProgress(null);
      setStatus('Could not download the sample burst: ' + ((e && e.message) || e), true);
    } finally {
      button.disabled = false;
    }
  });
})();
