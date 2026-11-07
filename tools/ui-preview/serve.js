#!/usr/bin/env node
// Serves the real frontend (src/frontend) in a normal browser for docs
// screenshots, with a stand-in for the tinyjs bridge (tiny-shim.js).
//
//   node tools/ui-preview/serve.js [port]
//   open http://127.0.0.1:8765/#{"photos":["/abs/a.jpg",...],"focus":[x,y]}
//
// The hash is the same JSON the BURST_SELFTEST env var takes; leave it out
// for the empty start screen. /file?p=<abs path> serves local images (GET
// only, image extensions only, bound to 127.0.0.1).
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '../../src/frontend');
const port = +(process.argv[2] || 8765);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let file;
  if (url.pathname === '/list') {               // tiny.api 'listImages' stand-in
    const out = [];
    for (const p of JSON.parse(url.searchParams.get('paths') || '[]')) {
      try {
        if (fs.statSync(p).isDirectory()) {
          for (const n of fs.readdirSync(p)) if (/\.(jpe?g|png|arw)$/i.test(n)) out.push(path.join(p, n));
        } else if (/\.(jpe?g|png|arw)$/i.test(p)) out.push(p);
      } catch { /* skip */ }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(out.sort()));
  }
  if (url.pathname === '/head') {               // tiny.api 'readHead' / 'readRange' stand-in
    const p = url.searchParams.get('p') || '';
    if (!/\.(jpe?g|png|arw)$/i.test(p)) { res.writeHead(403); return res.end(); }
    const off = +(url.searchParams.get('o') || 0), len = Math.min(8 << 20, +(url.searchParams.get('n') || 70000));
    try {
      const fd = fs.openSync(p, 'r'), buf = Buffer.alloc(len), n = fs.readSync(fd, buf, 0, len, off);
      fs.closeSync(fd);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end(buf.subarray(0, n).toString('base64'));
    } catch { res.writeHead(404); return res.end(); }
  }
  if (url.pathname === '/file') {
    file = url.searchParams.get('p') || '';
    if (!/\.(jpe?g|png|arw)$/i.test(file)) { res.writeHead(403); return res.end(); }
  } else if (url.pathname === '/tiny-shim.js') {
    file = path.join(__dirname, 'tiny-shim.js');
  } else {
    file = path.join(root, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
    if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end(); }
    if (file.endsWith('index.html')) {
      data = data.toString().replace('<script src="sr-core.js">', '<script src="/tiny-shim.js"></script>\n<script src="sr-core.js">');
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(port, '127.0.0.1', () => console.log(`ui preview on http://127.0.0.1:${port}/`));
