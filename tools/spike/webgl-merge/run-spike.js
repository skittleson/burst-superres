/* run-spike.js — serve the spike dir, run it in a background tab of the
 * Chrome on CDP 127.0.0.1:9223, print {ok,maxDiff,jsMs,glMs}, clean up.
 * Node >= 22 (global fetch + WebSocket), no deps. Usage: node run-spike.js
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const CDP_HOST = '127.0.0.1';
const CDP_PORT = 9223;
const TOTAL_TIMEOUT_MS = 120000;

const MIME = { '.html': 'text/html', '.js': 'text/javascript' };

function startServer(dir) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const name = path.basename(req.url.split('?')[0]);
      const file = path.join(dir, name);
      if (!file.startsWith(dir) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function cdpSession(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const eventHandlers = [];
  let id = 0;
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id != null) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (!p) return;
      msg.error ? p.reject(new Error(msg.method + ': ' + JSON.stringify(msg.error))) : p.resolve(msg.result);
    } else {
      for (const h of eventHandlers) h(msg);
    }
  };
  const open = new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('ws error')); });
  return {
    open,
    send(method, params = {}, sessionId) {
      return open.then(() => new Promise((resolve, reject) => {
        const mid = ++id;
        pending.set(mid, { resolve, reject });
        ws.send(JSON.stringify(sessionId ? { id: mid, method, params, sessionId } : { id: mid, method, params }));
      }));
    },
    once(method, sessionId) {
      return new Promise((resolve) => {
        eventHandlers.push((msg) => {
          if (msg.method === method && msg.sessionId === sessionId) { eventHandlers.length && eventHandlers.splice(eventHandlers.indexOf(eventHandlers.at(-1)), 1); resolve(); }
        });
      });
    },
    close() { ws.close(); },
  };
}

async function main() {
  const dir = __dirname;
  const srv = await startServer(dir);
  const port = srv.address().port;
  let cdp, targetId;
  try {
    const ver = await (await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/version`)).json();
    cdp = cdpSession(ver.webSocketDebuggerUrl);
    const created = await cdp.send('Target.createTarget', { url: 'about:blank', background: true });
    targetId = created.targetId;
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    const loaded = cdp.once('Page.loadEventFired', sessionId);
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/spike.html` }, sessionId);
    await Promise.race([
      loaded,
      new Promise((_, rej) => setTimeout(() => rej(new Error('page load timeout')), TOTAL_TIMEOUT_MS)),
    ]);
    // Poll window.__spikeDone inside the page (spike.js sets it synchronously
    // during load; the poll is belt-and-braces).
    const waiter = `(new Promise((res, rej) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (window.__spikeDone) { clearInterval(iv); res(JSON.stringify(window.__spikeDone)); }
        else if (Date.now() - t0 > ${TOTAL_TIMEOUT_MS}) { clearInterval(iv); rej(new Error('spike timeout')); }
      }, 100);
    }))`;
    const ev = await cdp.send('Runtime.evaluate', { expression: waiter, awaitPromise: true, returnByValue: true }, sessionId);
    if (ev.exceptionDetails) throw new Error('page: ' + JSON.stringify(ev.exceptionDetails.exception || ev.exceptionDetails.text));
    const r = JSON.parse(ev.result.value);
    const ratio = r.jsMs / r.glMs;
    const pass = r.ok && r.glMs <= r.jsMs / 2;
    console.log(JSON.stringify({ ok: r.ok, maxDiff: r.maxDiff, jsMs: r.jsMs, glMs: r.glMs, error: r.error }));
    console.log(`ratio(js/gl)=${ratio.toFixed(2)}  verdict=${pass ? 'PROCEED' : 'ABANDON'}  (bar: glMs <= jsMs/2 AND maxDiff < 1e-3)`);
  } finally {
    try { if (cdp && targetId) await cdp.send('Target.closeTarget', { targetId }); } catch {}
    try { cdp && cdp.close(); } catch {}
    srv.close();
  }
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
