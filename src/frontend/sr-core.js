/* sr-core.js: burst registration + merge math. No DOM, no dependencies.
 *
 * Plain script on purpose: the page loads it with <script>, the worker is built
 * from `createSRCore.toString()` (Chromium refuses file:// workers), and node
 * tests/tools get it through module.exports.
 *
 * Images are { width, height, data } with RGBA bytes (canvas ImageData shape).
 *
 * A warp maps reference coordinates to frame coordinates (pixel centres at
 * integers): u = a·x + b·y + c, v = d·x + e·y + f. The reference frame gets the
 * identity. registerBurst() returns one warp per frame.
 */
function createSRCore() {
  'use strict';

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  // Round half to even, like OpenCV's saturate_cast (Math.round biases .5 upward).
  const roundEven = (v) => { const r = Math.round(v); return r - v === 0.5 && (r & 1) ? r - 1 : r; };
  const IDENTITY = Object.freeze({ a: 1, b: 0, c: 0, d: 0, e: 1, f: 0 });
  const SMOOTH_SIGMA = 1.0;
  const translation = (tx, ty) => ({ a: 1, b: 0, c: tx, d: 0, e: 1, f: ty });

  // ---------- luma + pyramid ----------

  function toLuma(img) {
    const { width: w, height: h, data } = img;
    const d = new Float32Array(w * h);
    for (let i = 0, j = 0; i < d.length; i++, j += 4) {
      d[i] = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
    }
    return { w, h, d };
  }

  function cropLuma(L, x, y, w, h) {
    const d = new Float32Array(w * h);
    for (let r = 0; r < h; r++) d.set(L.d.subarray((y + r) * L.w + x, (y + r) * L.w + x + w), r * w);
    return { w, h, d };
  }

  // T×T luma tile whose pixel (i, j) is L sampled (bilinear) at W(x0 + i, y0 + j).
  function warpCropLuma(L, W, x0, y0, T) {
    const d = new Float32Array(T * T), s = L.d, w = L.w, h = L.h;
    for (let j = 0; j < T; j++) {
      for (let i = 0; i < T; i++) {
        const x = x0 + i, y = y0 + j;
        const u = clamp(W.a * x + W.b * y + W.c, 0, w - 1.001), v = clamp(W.d * x + W.e * y + W.f, 0, h - 1.001);
        const iu = Math.floor(u), iv = Math.floor(v), fu = u - iu, fv = v - iv, k = iv * w + iu;
        d[j * T + i] = (1 - fv) * ((1 - fu) * s[k] + fu * s[k + 1]) + fv * ((1 - fu) * s[k + w] + fu * s[k + w + 1]);
      }
    }
    return { w: T, h: T, d };
  }

  function down2(L) {
    const w = L.w >> 1, h = L.h >> 1, s = L.d, sw = L.w;
    const d = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const r0 = 2 * y * sw, r1 = r0 + sw;
      for (let x = 0; x < w; x++) {
        const c = 2 * x;
        d[y * w + x] = 0.25 * (s[r0 + c] + s[r0 + c + 1] + s[r1 + c] + s[r1 + c + 1]);
      }
    }
    return { w, h, d };
  }

  // levels[0] is full resolution, lightly smoothed: it cuts aliasing and the
  // bias bilinear interpolation gives Lucas–Kanade towards whole pixels.
  // The last level has min(w, h) >= minDim.
  function buildPyramid(L, minDim = 48) {
    const levels = [{ w: L.w, h: L.h, d: gaussBlur(L.d, L.w, L.h, SMOOTH_SIGMA) }];
    while (Math.min(levels[levels.length - 1].w, levels[levels.length - 1].h) >= 2 * minDim) {
      levels.push(down2(levels[levels.length - 1]));
    }
    return levels;
  }

  // Variance of the 4-neighbour Laplacian at half resolution: higher = sharper.
  function sharpness(img) {
    const { w, h, d } = down2(toLuma(img));
    let sum = 0, sum2 = 0, n = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const v = d[i - 1] + d[i + 1] + d[i - w] + d[i + w] - 4 * d[i];
        sum += v; sum2 += v * v; n++;
      }
    }
    const m = sum / n;
    return sum2 / n - m * m;
  }

  // ---------- translation registration ----------

  // Integer search minimizing mean |F(x+p) - R(x)| over the overlap.
  function coarseSearch(R, F, radius) {
    const { w, h } = R;
    let best = { px: 0, py: 0, cost: Infinity };
    for (let py = -radius; py <= radius; py++) {
      for (let px = -radius; px <= radius; px++) {
        const x0 = Math.max(0, -px), x1 = Math.min(w, w - px);
        const y0 = Math.max(0, -py), y1 = Math.min(h, h - py);
        if ((x1 - x0) * (y1 - y0) < 0.4 * w * h) continue;
        let cost = 0;
        for (let y = y0; y < y1; y++) {
          const ro = y * w, fo = (y + py) * w + px;
          for (let x = x0; x < x1; x++) cost += Math.abs(F.d[fo + x] - R.d[ro + x]);
        }
        cost /= (x1 - x0) * (y1 - y0);
        if (cost < best.cost) best = { px, py, cost };
      }
    }
    return best;
  }

  // Inverse-compositional Lucas–Kanade for a pure translation: find p with
  // F(x + p) ≈ R(x). Also returns the RMS residual and the gradient energy
  // (smallest Hessian eigenvalue per pixel), which is low on featureless areas,
  // and the gradient-energy centroid (cx, cy): under a slight rotation the
  // estimate is the displacement there, not at the window centre.
  function lkTranslate(R, F, px, py, maxIter = 30) {
    const { w, h } = R, rd = R.d, fd = F.d;
    let rms = NaN, texture = 0, cx = (w - 1) / 2, cy = (h - 1) / 2;
    for (let it = 0; it < maxIter; it++) {
      let hxx = 0, hxy = 0, hyy = 0, bx = 0, by = 0, sse = 0, n = 0, gsx = 0, gsy = 0;
      const ix = Math.floor(px), fx = px - ix, iy = Math.floor(py), fy = py - iy;
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
      // pixels whose sample point and its +1 neighbours stay inside F
      const xa = Math.max(1, -ix), xb = Math.min(w - 1, w - 1 - ix - 1);
      const ya = Math.max(1, -iy), yb = Math.min(h - 1, h - 1 - iy - 1);
      for (let y = ya; y < yb; y++) {
        const ro = y * w, fo = (y + iy) * w + ix;
        for (let x = xa; x < xb; x++) {
          const i = ro + x, j = fo + x;
          const fv = w00 * fd[j] + w10 * fd[j + 1] + w01 * fd[j + w] + w11 * fd[j + w + 1];
          const e = fv - rd[i];
          const gx = 0.5 * (rd[i + 1] - rd[i - 1]);
          const gy = 0.5 * (rd[i + w] - rd[i - w]);
          const g2 = gx * gx + gy * gy;
          hxx += gx * gx; hxy += gx * gy; hyy += gy * gy;
          bx += gx * e; by += gy * e; gsx += g2 * x; gsy += g2 * y;
          sse += e * e; n++;
        }
      }
      rms = Math.sqrt(sse / Math.max(1, n));
      if (hxx + hyy > 0) { cx = gsx / (hxx + hyy); cy = gsy / (hxx + hyy); }
      const tr = hxx + hyy, det = hxx * hyy - hxy * hxy;
      texture = (tr / 2 - Math.sqrt(Math.max(0, tr * tr / 4 - det))) / Math.max(1, n);
      if (!(det > 1e-9)) break;
      const dpx = (hyy * bx - hxy * by) / det;
      const dpy = (hxx * by - hxy * bx) / det;
      px -= dpx; py -= dpy;
      if (dpx * dpx + dpy * dpy < 1e-8) break;
    }
    return { px, py, rms, texture, cx, cy };
  }

  // Coarse-to-fine translation between two luma pyramids: F(x + p) ≈ R(x).
  // `coarse: false` skips the integer search (the caller already pre-aligned).
  function registerPyramids(refPyr, framePyr, { coarse = true } = {}) {
    const top = refPyr.length - 1;
    const R = refPyr[top];
    let px = 0, py = 0, r = null;
    if (coarse) {
      const radius = Math.max(1, Math.min(8, Math.floor(Math.min(R.w, R.h) / 4)));
      const c = coarseSearch(R, framePyr[top], radius);
      px = c.px; py = c.py;
    }
    for (let l = top; l >= 0; l--) {
      if (l !== top) { px *= 2; py *= 2; }
      r = lkTranslate(refPyr[l], framePyr[l], px, py);
      px = r.px; py = r.py;
    }
    return r;
  }

  // ---------- affine registration from tile translations ----------

  function solve3(m, v) {
    // Cramer's rule on a symmetric 3×3 system
    const [a, b, c, d, e, f, g, h, i] = m;
    const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    if (Math.abs(det) < 1e-12) return null;
    return [
      (v[0] * (e * i - f * h) - b * (v[1] * i - f * v[2]) + c * (v[1] * h - e * v[2])) / det,
      (a * (v[1] * i - f * v[2]) - v[0] * (d * i - f * g) + c * (d * v[2] - v[1] * g)) / det,
      (a * (e * v[2] - v[1] * h) - b * (d * v[2] - v[1] * g) + v[0] * (d * h - e * g)) / det,
    ];
  }

  // Least-squares fit of p(x, y) = g0 + g1·x + g2·y for both components over
  // the tiles flagged as inliers.
  function fitAffine(tiles) {
    const m = new Array(9).fill(0), vx = [0, 0, 0], vy = [0, 0, 0];
    for (const t of tiles) {
      if (!t.inlier) continue;
      const row = [1, t.x, t.y];
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) m[i * 3 + j] += row[i] * row[j];
        vx[i] += row[i] * t.px; vy[i] += row[i] * t.py;
      }
    }
    const gx = solve3(m, vx), gy = solve3(m, vy);
    if (!gx || !gy) return null;
    return { a: 1 + gx[1], b: gx[2], c: gx[0], d: gy[1], e: 1 + gy[2], f: gy[0] };
  }

  const applyWarp = (W, x, y) => [W.a * x + W.b * y + W.c, W.d * x + W.e * y + W.f];

  /**
   * Register `frameL` against `refL` (luma). Global translation first, then a
   * grid of tiles each refined to sub-pixel translation, then a robust affine
   * fit through the tile centres. Small images fall back to translation only.
   * Returns { warp, fitRms, inliers, tiles, rms }.
   */
  function registerLuma(refL, frameL, refPyr) {
    refPyr = refPyr || buildPyramid(refL);
    const g = registerPyramids(refPyr, buildPyramid(frameL));
    const base = { warp: translation(g.px, g.py), rms: g.rms, fitRms: 0, inliers: 0, tiles: [] };
    const { w, h } = refL;
    const T = Math.min(512, Math.floor(Math.min(w, h) / 4));
    if (T < 96) return base;

    // Spread tiles over the region both frames see (ref rect and shifted rect in bounds).
    const ox = Math.round(g.px), oy = Math.round(g.py);
    const xLo = Math.max(0, -ox), xHi = Math.min(w, w - ox) - T;
    const yLo = Math.max(0, -oy), yHi = Math.min(h, h - oy) - T;
    if (xHi < xLo || yHi < yLo) return base;
    const nx = clamp(Math.round((xHi - xLo + T) / (1.5 * T)), 2, 8), ny = clamp(Math.round((yHi - yLo + T) / (1.5 * T)), 2, 6);
    const rects = [];
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      rects.push([Math.round(xLo + (xHi - xLo) * i / (nx - 1)), Math.round(yLo + (yHi - yLo) * j / (ny - 1))]);
    }
    const refTiles = rects.map(([x0, y0]) => buildPyramid(cropLuma(refL, x0, y0, T, T)));

    // Pass 0 measures each tile against the global translation. Later passes
    // pre-warp the frame tile with the current affine fit, so a slight
    // rotation no longer smears the motion inside a tile, and re-measure.
    let warp = base.warp, fit = null;
    for (let pass = 0; pass < 3; pass++) {
      const tiles = rects.map(([x0, y0], k) => {
        const r = registerPyramids(refTiles[k], buildPyramid(warpCropLuma(frameL, warp, x0, y0, T)));
        // the frame tile sampled ref point x at warp(x), so x ↦ warp(x + p)
        const x = x0 + r.cx, y = y0 + r.cy, [u, v] = applyWarp(warp, x + r.px, y + r.py);
        return { x, y, px: u - x, py: v - y, rms: r.rms, texture: r.texture, inlier: true };
      });
      fit = fitTiles(tiles);
      if (!fit) return { ...base, tiles };
      warp = fit.warp;
    }
    return { warp, rms: g.rms, fitRms: fit.fitRms, inliers: fit.inliers, tiles: fit.tiles };
  }

  // Robust affine fit through tile vectors: drop featureless tiles (sky, walls),
  // then iteratively drop tiles that disagree (moving subject, parallax).
  function fitTiles(tiles) {
    const tex = tiles.map((t) => t.texture).sort((a, b) => a - b);
    const minTex = Math.max(0.5, 0.05 * (tex[tex.length >> 1] || 0));
    for (const t of tiles) t.inlier = t.texture >= minTex;
    if (tiles.filter((t) => t.inlier).length < 4) return null;
    let warp = null;
    for (let it = 0; it < 5; it++) {
      warp = fitAffine(tiles);
      if (!warp) return null;
      const res = [];
      for (const t of tiles) {
        const [u, v] = applyWarp(warp, t.x, t.y);
        t.err = Math.hypot(u - t.x - t.px, v - t.y - t.py);
        if (t.inlier) res.push(t.err);
      }
      res.sort((a, b) => a - b);
      const cut = Math.max(0.1, 3 * 1.4826 * res[res.length >> 1]);
      let changed = false;
      for (const t of tiles) {
        const keep = t.texture >= minTex && t.err <= cut;
        if (keep !== t.inlier) { t.inlier = keep; changed = true; }
      }
      if (tiles.filter((t) => t.inlier).length < 4) return null;
      if (!changed) break;
    }
    warp = fitAffine(tiles);
    const inl = tiles.filter((t) => t.inlier);
    for (const t of tiles) { const [u, v] = applyWarp(warp, t.x, t.y); t.err = Math.hypot(u - t.x - t.px, v - t.y - t.py); }
    const fitRms = Math.sqrt(inl.reduce((s, t) => s + t.err * t.err, 0) / inl.length);
    return { warp, fitRms, inliers: inl.length, tiles };
  }

  // ---------- local alignment (handheld bursts) ----------
  //
  // After the global affine fit, a handheld burst still moves differently in
  // different places: parallax between near and far objects, lens
  // distortion, a little perspective. A grid of small cells measures what is
  // left over, giving a smooth displacement field r(x) on top of the affine
  // warp W: the frame point for reference point x is W(x + r(x)). Cells that
  // still do not line up afterwards (moving subjects, parallax edges) are
  // flagged so the merge leaves that frame out there.

  const LOCAL_CELL = 64;         // cell size, input pixels
  const LOCAL_TRIGGER = 0.1;     // only frames whose affine fit is worse than this
  const CELL_BAD_PX = 1;         // a cell is "bad" above this remaining error
  const LOCAL_PASSES = 3;        // estimate + refine passes before the final measurement

  // Residual r at reference point (x, y): bilinear between cell centres.
  function fieldAt(F, x, y) {
    const gx = clamp((x - F.x0) / F.T, 0, F.nx - 1), gy = clamp((y - F.y0) / F.T, 0, F.ny - 1);
    const i = Math.min(Math.floor(gx), F.nx - 2 < 0 ? 0 : F.nx - 2), j = Math.min(Math.floor(gy), F.ny - 2 < 0 ? 0 : F.ny - 2);
    const fx = F.nx > 1 ? gx - i : 0, fy = F.ny > 1 ? gy - j : 0;
    const i1 = Math.min(i + 1, F.nx - 1), j1 = Math.min(j + 1, F.ny - 1);
    const k00 = j * F.nx + i, k10 = j * F.nx + i1, k01 = j1 * F.nx + i, k11 = j1 * F.nx + i1;
    const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
    return [w00 * F.dx[k00] + w10 * F.dx[k10] + w01 * F.dx[k01] + w11 * F.dx[k11],
            w00 * F.dy[k00] + w10 * F.dy[k10] + w01 * F.dy[k01] + w11 * F.dy[k11]];
  }

  // Frame coordinates of reference point (x, y) through affine W plus field F.
  function mapPoint(W, F, x, y) {
    if (!F) return applyWarp(W, x, y);
    const [rx, ry] = fieldAt(F, x, y);
    return applyWarp(W, x + rx, y + ry);
  }

  // Affine that matches x ↦ W(x + r(x)) near (x, y) (finite differences over ±h).
  function localAffineAt(W, F, x, y, h = 32) {
    const [ux1, vx1] = mapPoint(W, F, x + h, y), [ux0, vx0] = mapPoint(W, F, x - h, y);
    const [uy1, vy1] = mapPoint(W, F, x, y + h), [uy0, vy0] = mapPoint(W, F, x, y - h);
    const a = (ux1 - ux0) / (2 * h), b = (uy1 - uy0) / (2 * h);
    const d = (vx1 - vx0) / (2 * h), e = (vy1 - vy0) / (2 * h);
    const [u, v] = mapPoint(W, F, x, y);
    return { a, b, c: u - a * x - b * y, d, e, f: v - d * x - e * y };
  }

  // 3×3 median of one field component (robust to single bad cells).
  function median3x3(src, nx, ny) {
    const out = new Float32Array(src.length), win = new Float32Array(9);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      let m = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ii = i + di, jj = j + dj;
        if (ii >= 0 && jj >= 0 && ii < nx && jj < ny) win[m++] = src[jj * nx + ii];
      }
      out[j * nx + i] = median(win, m);
    }
    return out;
  }

  /**
   * Measure the residual field of `frameL` against `refL` on top of affine W.
   * Returns null when there is too little texture to measure, else
   * { field, err, badFraction } where err is the RMS remaining misalignment
   * (input px) over the textured cells, measured after the field is applied.
   */
  function buildLocalField(refL, frameL, W, { cell = LOCAL_CELL, passes = LOCAL_PASSES } = {}) {
    const { w, h } = refL, T = cell;
    const nx = Math.floor(w / T), ny = Math.floor(h / T);
    if (nx < 3 || ny < 3) return null;
    const ox = Math.floor((w - nx * T) / 2), oy = Math.floor((h - ny * T) / 2);
    const n = nx * ny;
    const F = { T, nx, ny, x0: ox + (T - 1) / 2, y0: oy + (T - 1) / 2,
      dx: new Float32Array(n), dy: new Float32Array(n), ok: new Uint8Array(n).fill(1) };
    const refPyrs = [];
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      refPyrs.push(buildPyramid(cropLuma(refL, ox + i * T, oy + j * T, T, T), 24));
    }
    // One pass: measure each cell through the current mapping. The frame
    // tile sampled reference point x at L(x), so the cell maps x ↦ L(x + p).
    const measure = () => {
      const cells = [];
      for (let k = 0; k < n; k++) {
        const i = k % nx, j = (k / nx) | 0, x0 = ox + i * T, y0 = oy + j * T;
        const cx = F.x0 + i * T, cy = F.y0 + j * T;
        const L = localAffineAt(W, F, cx, cy);
        const r = registerPyramids(refPyrs[k], buildPyramid(warpCropLuma(frameL, L, x0, y0, T), 24), { coarse: false });
        // the same displacement expressed as a change of r at the cell centre (L ≈ W(x + r) locally)
        const det = W.a * W.e - W.b * W.d;
        const [u0, v0] = applyWarp(L, cx, cy), [u1, v1] = applyWarp(L, cx + r.px, cy + r.py);
        const du = u1 - u0, dv = v1 - v0;
        cells.push({ qx: (W.e * du - W.b * dv) / det, qy: (-W.d * du + W.a * dv) / det, rms: r.rms, texture: r.texture });
      }
      return cells;
    };
    const textured = (cells) => {
      const tex = cells.map((c) => c.texture).sort((a, b) => a - b);
      const minTex = Math.max(0.5, 0.05 * tex[tex.length >> 1]);
      return cells.map((c) => c.texture >= minTex && Number.isFinite(c.qx) && Math.hypot(c.qx, c.qy) < 24);
    };

    // Estimate and refine the field, then one more pass only measures.
    for (let pass = 0; pass < passes; pass++) {
      const cells = measure(), good = textured(cells);
      if (good.filter(Boolean).length < Math.max(4, n * 0.1)) return null;
      const qx = new Float32Array(n), qy = new Float32Array(n), have = Uint8Array.from(good);
      cells.forEach((c, k) => { if (good[k]) { qx[k] = c.qx; qy[k] = c.qy; } });
      // fill untextured cells from their measured neighbours, ring by ring
      for (let left = n - have.reduce((s, v) => s + v, 0); left > 0;) {
        const add = [];
        for (let k = 0; k < n; k++) {
          if (have[k]) continue;
          const i = k % nx, j = (k / nx) | 0;
          let sx = 0, sy = 0, c = 0;
          for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
            const ii = i + di, jj = j + dj, kk = jj * nx + ii;
            if (ii >= 0 && jj >= 0 && ii < nx && jj < ny && have[kk]) { sx += qx[kk]; sy += qy[kk]; c++; }
          }
          if (c) add.push([k, sx / c, sy / c]);
        }
        if (!add.length) break;
        for (const [k, x, y] of add) { qx[k] = x; qy[k] = y; have[k] = 1; }
        left -= add.length;
      }
      const mx = median3x3(qx, nx, ny), my = median3x3(qy, nx, ny);
      for (let k = 0; k < n; k++) { F.dx[k] += mx[k]; F.dy[k] += my[k]; }
    }

    const cells = measure(), good = textured(cells);
    const rmsSorted = cells.filter((c, k) => good[k]).map((c) => c.rms).sort((a, b) => a - b);
    const rmsMed = rmsSorted[rmsSorted.length >> 1] || 0;
    let sse = 0, cnt = 0, bad = 0;
    cells.forEach((c, k) => {
      const e = Math.hypot(c.qx, c.qy);
      const isBad = good[k] ? (e > CELL_BAD_PX || c.rms > Math.max(6, 2.5 * rmsMed)) : false;
      if (isBad) { F.ok[k] = 0; bad++; }
      if (good[k] && !isBad) { sse += e * e; cnt++; }
    });
    return { field: F, err: cnt ? Math.sqrt(sse / cnt) : Infinity, badFraction: bad / n };
  }

  // Alignment quality verdict from the remaining error (input px).
  function verdictFor(err) {
    return err <= 0.3 ? 'good' : err <= 1 ? 'soft' : 'bad';
  }

  // Which photos to merge by default: the reference and every photo that
  // lined up to `maxErr` or better (the rest would soften or ghost the result).
  // When that leaves only the reference, photos up to 1 px ("soft") are used too.
  function defaultSelection(details, refIndex, maxErr = 0.3) {
    const good = details.map((d, i) => i === refIndex || d.err <= maxErr);
    if (good.filter(Boolean).length >= 2) return good;
    return details.map((d, i) => i === refIndex || d.err <= 1);
  }

  function register(ref, frame, opts) {
    return finishRegistration(toLuma(ref), toLuma(frame), registerLuma(toLuma(ref), toLuma(frame)), opts);
  }

  // Adds local alignment when the affine fit is not good enough, and the verdict.
  function finishRegistration(refL, frameL, r, { local = true, trigger = LOCAL_TRIGGER, cell, passes } = {}) {
    r.err = r.inliers ? r.fitRms : 0;
    r.mode = 'affine';
    r.badFraction = 0;
    if (local && r.inliers && r.fitRms > trigger) {
      const lf = buildLocalField(refL, frameL, r.warp, { cell, passes });
      if (lf && lf.err < r.fitRms) {
        r.warp = { ...r.warp, field: lf.field };
        r.err = lf.err; r.badFraction = lf.badFraction; r.mode = 'local';
      }
    }
    r.verdict = verdictFor(r.err);
    return r;
  }

  // ---------- brightness matching ----------
  //
  // Exposure flicker or auto exposure makes one photo a little brighter than
  // another. Alignment compares brightness, and the merge averages it, so a
  // per-photo gain is matched first (multiplicative, like an exposure change).

  // Mean luma over the central 80% of the frame (motion barely moves it).
  function centralMean(L) {
    const x0 = Math.floor(L.w * 0.1), x1 = Math.ceil(L.w * 0.9), y0 = Math.floor(L.h * 0.1), y1 = Math.ceil(L.h * 0.9);
    let s = 0, n = 0;
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) { s += L.d[y * L.w + x]; n++; }
    return s / n;
  }

  function scaleLuma(L, g) {
    if (Math.abs(g - 1) < 1e-4) return L;
    const d = new Float32Array(L.d.length);
    for (let i = 0; i < d.length; i++) d[i] = L.d[i] * g;
    return { w: L.w, h: L.h, d };
  }

  // Per-channel gain that maps `frame` onto `ref` through warp W: the median,
  // over 32 px blocks, of ref block mean / frame block mean (sampled through
  // the warp). Blocks near black or white, or cells the local field rejected,
  // are skipped. Median = robust to things that moved.
  function channelGains(ref, frame, W) {
    const B = 32, { width: w, height: h } = ref, F = W.field;
    const ratios = [[], [], []];
    const sample = (img, u, v, c) => {
      const x = clamp(u, 0, img.width - 1.001), y = clamp(v, 0, img.height - 1.001), ix = x | 0, iy = y | 0, fx = x - ix, fy = y - iy;
      const o = (iy * img.width + ix) * 4 + c, r = img.width * 4, d = img.data;
      return (1 - fy) * ((1 - fx) * d[o] + fx * d[o + 4]) + fy * ((1 - fx) * d[o + r] + fx * d[o + r + 4]);
    };
    for (let by = B; by + B < h; by += B) for (let bx = B; bx + B < w; bx += B) {
      if (F) {
        const i = clamp(Math.round((bx + B / 2 - F.x0) / F.T), 0, F.nx - 1), j = clamp(Math.round((by + B / 2 - F.y0) / F.T), 0, F.ny - 1);
        if (!F.ok[j * F.nx + i]) continue;
      }
      const sr = [0, 0, 0], sf = [0, 0, 0];
      let inside = true;
      for (let y = by + 2; y < by + B; y += 4) for (let x = bx + 2; x < bx + B; x += 4) {
        const [u, v] = mapPoint(W, F, x, y);
        if (u < 1 || v < 1 || u > w - 2 || v > h - 2) { inside = false; break; }
        const o = (y * w + x) * 4;
        for (let c = 0; c < 3; c++) { sr[c] += ref.data[o + c]; sf[c] += sample(frame, u, v, c); }
      }
      if (!inside) continue;
      for (let c = 0; c < 3; c++) {
        const mr = sr[c] / 64, mf = sf[c] / 64;
        if (mr > 16 && mr < 240 && mf > 16 && mf < 240) ratios[c].push(mr / mf);
      }
    }
    return ratios.map((r) => {
      if (r.length < 16) return 1;
      r.sort((a, b) => a - b);
      return r[r.length >> 1];
    });
  }

  // Registers every frame against a reference: the sharpest one unless
  // opts.refIndex is given (the benchmark pins it to keep ground truth aligned).
  // opts.matchBrightness (default true) also fits a per-photo, per-channel gain.
  function registerBurst(frames, onProgress = () => {}, opts = {}) {
    const n = frames.length;
    const sharp = frames.map((f, i) => { onProgress(i / n * 0.2, 'Measuring sharpness'); return sharpness(f); });
    let refIndex = 0;
    if (opts.refIndex != null) refIndex = opts.refIndex;
    else for (let i = 1; i < n; i++) if (sharp[i] > sharp[refIndex]) refIndex = i;
    const ref = frames[refIndex], match = opts.matchBrightness !== false;
    const refL = toLuma(ref), refPyr = buildPyramid(refL), refMean = centralMean(refL);
    const results = frames.map((f, i) => {
      onProgress(0.2 + i / n * 0.8, `Aligning photo ${i + 1} of ${n}`);
      if (i === refIndex) return { warp: { ...IDENTITY }, rms: 0, fitRms: 0, inliers: 0, tiles: [], err: 0, mode: 'reference', badFraction: 0, verdict: 'good', gain: [1, 1, 1] };
      if (f.width !== ref.width || f.height !== ref.height) throw new Error('All photos must have the same dimensions.');
      let fL = toLuma(f);
      if (match) fL = scaleLuma(fL, refMean / Math.max(1e-3, centralMean(fL)));   // rough gain, for alignment only
      const r = finishRegistration(refL, fL, registerLuma(refL, fL, refPyr), opts);
      r.gain = match ? channelGains(ref, f, r.warp) : [1, 1, 1];
      if (match) r.warp = { ...r.warp, gain: r.gain };
      return r;
    });
    onProgress(1, 'Aligned');
    return { refIndex, warps: results.map((r) => r.warp), details: results, sharpness: sharp };
  }

  // ---------- Lanczos-3 resampling through an affine warp ----------

  const TAPS = 6, PHASES = 256;
  function lanczos3(t) {
    if (t === 0) return 1;
    if (t <= -3 || t >= 3) return 0;
    const a = Math.PI * t;
    return (3 * Math.sin(a) * Math.sin(a / 3)) / (a * a);
  }
  // LUT[p * 6 + t]: normalized weight of tap i0 + t for a sample at i0 + 2 + p / PHASES.
  const LUT = new Float32Array((PHASES + 1) * TAPS);
  for (let p = 0; p <= PHASES; p++) {
    let s = 0;
    for (let t = 0; t < TAPS; t++) { const v = lanczos3(p / PHASES + 2 - t); LUT[p * TAPS + t] = v; s += v; }
    for (let t = 0; t < TAPS; t++) LUT[p * TAPS + t] /= s;
  }

  /**
   * Render output rows [Y0, Y1) x columns [X0, X0 + outW) of `img` seen through
   * `warp` on a grid `scale`× denser than the reference, into `out` (float RGB).
   * Output pixel (X, Y) sits at reference coords ((X + .5) / scale - .5, ...).
   *
   * Two separable passes (Catmull–Smith), exact for affine warps:
   *   1. along each source row v: I1(X, v) = F(α·x + β·v + γ, v)
   *   2. along each output column: out(X, Y) = I1(X, d·x + e·y + f)
   * `valid` (optional Uint8Array) gets 1 where the sample lies inside the frame.
   */
  function warpStrip(img, warp, scale, X0, outW, Y0, Y1, out, valid) {
    const { width: w, height: h, data } = img;
    const { a, b, c, d, e, f } = warp;
    const al = a - b * d / e, be = b / e, ga = c - b * f / e;
    const xs = new Float64Array(outW);
    for (let X = 0; X < outW; X++) xs[X] = (X0 + X + 0.5) / scale - 0.5;
    // source rows needed by this strip (v is linear, so the corners bound it)
    let vMin = Infinity, vMax = -Infinity;
    for (const x of [xs[0], xs[outW - 1]]) for (const Y of [Y0, Y1 - 1]) {
      const v = d * x + e * ((Y + 0.5) / scale - 0.5) + f;
      vMin = Math.min(vMin, v); vMax = Math.max(vMax, v);
    }
    const rFirst = clamp(Math.floor(vMin) - 2, 0, h - 1), rLast = clamp(Math.floor(vMax) + 3, 0, h - 1);
    const nr = rLast - rFirst + 1, line = outW * 3;
    const tmp = new Float32Array(nr * line);

    for (let r = 0; r < nr; r++) {
      const v = r + rFirst, src = v * w * 4;
      let o = r * line;
      for (let X = 0; X < outW; X++, o += 3) {
        const u = al * xs[X] + be * v + ga, fu = Math.floor(u), i0 = fu - 2;
        const wo = Math.round((u - fu) * PHASES) * TAPS;
        let R = 0, G = 0, B = 0;
        if (i0 >= 0 && i0 + TAPS <= w) {
          for (let t = 0, p = src + i0 * 4; t < TAPS; t++, p += 4) {
            const wt = LUT[wo + t];
            R += wt * data[p]; G += wt * data[p + 1]; B += wt * data[p + 2];
          }
        } else {
          for (let t = 0; t < TAPS; t++) {
            const p = src + clamp(i0 + t, 0, w - 1) * 4, wt = LUT[wo + t];
            R += wt * data[p]; G += wt * data[p + 1]; B += wt * data[p + 2];
          }
        }
        tmp[o] = R; tmp[o + 1] = G; tmp[o + 2] = B;
      }
    }

    for (let Y = Y0; Y < Y1; Y++) {
      const y = (Y + 0.5) / scale - 0.5, ob = (Y - Y0) * line;
      for (let X = 0; X < outW; X++) {
        const x = xs[X], v = d * x + e * y + f, fv = Math.floor(v);
        const wo = Math.round((v - fv) * PHASES) * TAPS;
        let R = 0, G = 0, B = 0;
        for (let t = 0; t < TAPS; t++) {
          const q = (clamp(fv - 2 + t, rFirst, rLast) - rFirst) * line + X * 3, wt = LUT[wo + t];
          R += wt * tmp[q]; G += wt * tmp[q + 1]; B += wt * tmp[q + 2];
        }
        const o = ob + X * 3;
        out[o] = R; out[o + 1] = G; out[o + 2] = B;
        if (valid) {
          const u = a * x + b * y + c;
          valid[(Y - Y0) * outW + X] = u >= -0.5 && u <= w - 0.5 && v >= -0.5 && v <= h - 0.5 ? 1 : 0;
        }
      }
    }
    return out;
  }

  const CHUNK = 128;   // output columns per local-affine chunk

  /**
   * warpStrip for any warp: affine-only warps go straight through; a warp
   * with a local field is rendered in CHUNK-wide column blocks, each through
   * the affine that matches the field at the block centre (the field is smooth
   * over a block, so the seams are far below a pixel). Pixels in cells the
   * field flagged as misaligned get valid = 0.
   */
  function renderStrip(img, warp, scale, X0, outW, Y0, Y1, out, valid) {
    renderStripRaw(img, warp, scale, X0, outW, Y0, Y1, out, valid);
    const g = warp.gain;
    if (g && (g[0] !== 1 || g[1] !== 1 || g[2] !== 1)) {
      const n = (Y1 - Y0) * outW * 3;
      for (let i = 0; i < n; i += 3) { out[i] *= g[0]; out[i + 1] *= g[1]; out[i + 2] *= g[2]; }
    }
    return out;
  }

  function renderStripRaw(img, warp, scale, X0, outW, Y0, Y1, out, valid) {
    const F = warp.field;
    if (!F) return warpStrip(img, warp, scale, X0, outW, Y0, Y1, out, valid);
    const rows = Y1 - Y0, yc = ((Y0 + Y1) / 2 + 0.5) / scale - 0.5;
    const buf = new Float32Array(rows * CHUNK * 3), vbuf = valid ? new Uint8Array(rows * CHUNK) : null;
    for (let c0 = 0; c0 < outW; c0 += CHUNK) {
      const cw = Math.min(CHUNK, outW - c0), xc = (X0 + c0 + cw / 2 + 0.5) / scale - 0.5;
      warpStrip(img, localAffineAt(warp, F, xc, yc), scale, X0 + c0, cw, Y0, Y1, buf, vbuf);
      for (let r = 0; r < rows; r++) {
        out.set(buf.subarray(r * cw * 3, (r + 1) * cw * 3), (r * outW + c0) * 3);
        if (!valid) continue;
        const y = (Y0 + r + 0.5) / scale - 0.5, j = clamp(Math.round((y - F.y0) / F.T), 0, F.ny - 1);
        for (let x = 0; x < cw; x++) {
          const i = clamp(Math.round(((X0 + c0 + x + 0.5) / scale - 0.5 - F.x0) / F.T), 0, F.nx - 1);
          valid[r * outW + c0 + x] = F.ok[j * F.nx + i] ? vbuf[r * cw + x] : 0;
        }
      }
    }
    return out;
  }

  // Resample a region of one frame through a warp (default identity). Returns RGBA.
  function resampleRegion(img, { scale = 2, warp = IDENTITY, x = 0, y = 0, width, height }) {
    const out = new Uint8ClampedArray(width * height * 4);
    const strip = 64, buf = new Float32Array(strip * width * 3);
    for (let Y0 = y; Y0 < y + height; Y0 += strip) {
      const Y1 = Math.min(y + height, Y0 + strip);
      renderStrip(img, warp, scale, x, width, Y0, Y1, buf);
      writeRGB(buf, out, (Y0 - y) * width, (Y1 - Y0) * width);
    }
    return { width, height, data: out };
  }

  function writeRGB(rgb, rgba, pixelOffset, count) {
    for (let i = 0, j = pixelOffset * 4; i < count * 3; i += 3, j += 4) {
      rgba[j] = rgb[i]; rgba[j + 1] = rgb[i + 1]; rgba[j + 2] = rgb[i + 2]; rgba[j + 3] = 255;
    }
  }

  // ---------- merge ----------

  const MODES = ['mean', 'median', 'pairwise'];

  /**
   * Merge registered frames onto a `scale`× grid, strip by strip, so no
   * full-size float buffer is ever allocated.
   *   mean     per-pixel average of the frames that cover the pixel
   *   median   per-pixel median (resists moving things / misalignment)
   *   pairwise guide ch. 7: 50/50 blend in pairs as 8-bit images, then repeat
   * opts: { mode = 'mean', scale = 2, refIndex = 0, stripRows = 32, onProgress }
   * With opts.modes = ['mean', 'median', ...] every listed mode is made from
   * the same rendered strips (one pass) and an object { mode: image } is
   * returned instead of a single image.
   */
  function merge(frames, warps, opts = {}) {
    const modes = opts.modes || [opts.mode || 'mean'];
    for (const m of modes) if (!MODES.includes(m)) throw new Error('Unknown merge mode: ' + m);
    const scale = opts.scale || 2, refIndex = opts.refIndex || 0;
    const onProgress = opts.onProgress || (() => {});
    const { width: w, height: h } = frames[0], N = frames.length;
    // opts.region { x, y, width, height } (output px) merges just that part
    const R = opts.region || { x: 0, y: 0, width: w * scale, height: h * scale };
    const W = R.width, H = R.height;
    const stripRows = opts.stripRows || 32, line = W * 3;
    const outs = Object.fromEntries(modes.map((m) => [m, new Uint8ClampedArray(W * H * 4)]));
    const strips = frames.map(() => new Float32Array(stripRows * line));
    const valid = frames.map(() => new Uint8Array(stripRows * W));
    const res = new Float32Array(stripRows * line), vals = new Float32Array(N);

    for (let Y0 = 0; Y0 < H; Y0 += stripRows) {
      const Y1 = Math.min(H, Y0 + stripRows), n = (Y1 - Y0) * W;
      onProgress(Y0 / H, 'Merging');
      for (let k = 0; k < N; k++) renderStrip(frames[k], warps[k], scale, R.x, W, R.y + Y0, R.y + Y1, strips[k], valid[k]);

      for (const mode of modes) {
        if (mode === 'pairwise') {
          let level = strips.map((s) => { const q = new Float32Array(n * 3); for (let i = 0; i < n * 3; i++) q[i] = roundEven(clamp(s[i], 0, 255)); return q; });
          while (level.length > 1) {
            const next = [];
            for (let i = 0; i + 1 < level.length; i += 2) {
              const p = level[i], q = level[i + 1];
              for (let j = 0; j < n * 3; j++) p[j] = roundEven(0.5 * p[j] + 0.5 * q[j]);
              next.push(p);
            }
            if (level.length % 2) next.push(level[level.length - 1]);
            level = next;
          }
          writeRGB(level[0], outs[mode], Y0 * W, n);
          continue;
        }
        // The reference always counts; other frames only where they cover the pixel.
        for (let i = 0; i < n; i++) {
          for (let ch = 0; ch < 3; ch++) {
            const q = i * 3 + ch;
            let m = 0;
            for (let k = 0; k < N; k++) if (k === refIndex || valid[k][i]) vals[m++] = strips[k][q];
            if (mode === 'mean') { let s = 0; for (let t = 0; t < m; t++) s += vals[t]; res[q] = s / m; }
            else res[q] = median(vals, m);
          }
        }
        writeRGB(res, outs[mode], Y0 * W, n);
      }
    }
    onProgress(1, 'Merged');
    const images = Object.fromEntries(modes.map((m) => [m, { width: W, height: H, data: outs[m] }]));
    return opts.modes ? images : images[modes[0]];
  }

  // ---------- merge straight from raw sensor samples ----------
  //
  // Each raw photo carries one colour per pixel (Bayer pattern). Instead of
  // demosaicing every photo and merging the results, every output pixel
  // gathers the raw samples of each colour near its position in every photo
  // (3x3 around the nearest sample) with a Gaussian weight on the true
  // sub-pixel distance, as in Wronski et al. 2019 (isotropic kernel here).
  // The photos' shifts fill in the colours each one is missing.
  //
  // frames: [{ width, height, data (one value per pixel), cfa, stride?, black?, gain? }]
  //   value used = (data[y * stride + x] - black[(y&1)*2 + (x&1)]) * gain[colour]
  // warps: from registerBurst on demosaiced versions of the same photos.
  // opts: { scale = 2, refIndex = 0, sigma = 0.22 (input px; tuned on tools/bench-raw.js), region, onProgress,
  //         toRGBA(r, g, b, out, o) to turn merged values into 8-bit (default: clamp) }

  function mergeCFA(frames, warps, opts = {}) {
    const scale = opts.scale || 2, refIndex = opts.refIndex || 0, onProgress = opts.onProgress || (() => {});
    const sigma = opts.sigma || 0.22, inv = 1 / (2 * sigma * sigma);
    const { width: w, height: h } = frames[0], N = frames.length;
    const R = opts.region || { x: 0, y: 0, width: w * scale, height: h * scale };
    const W = R.width, H = R.height, out = new Uint8ClampedArray(W * H * 4);
    const toRGBA = opts.toRGBA || ((r, g, b, o, i) => { o[i] = r; o[i + 1] = g; o[i + 2] = b; o[i + 3] = 255; });
    const LUTN = 2048, LUTMAX = 9, lut = new Float32Array(LUTN + 1);
    for (let i = 0; i <= LUTN; i++) lut[i] = Math.exp(-(i / LUTN) * LUTMAX * inv);
    const rows = 32, num = new Float32Array(rows * W * 3), den = new Float32Array(rows * W * 3);
    for (let Y0 = 0; Y0 < H; Y0 += rows) {
      const Y1 = Math.min(H, Y0 + rows);
      onProgress(Y0 / H, 'Merging raw');
      num.fill(0); den.fill(0);
      for (let k = 0; k < N; k++) {
        const f = frames[k], d = f.data, cfa = f.cfa, warp = warps[k], F = warp.field, stride = f.stride || f.width;
        const bl = f.black || [0, 0, 0, 0], wg = warp.gainLinear || warp.gain || [1, 1, 1], fg = f.gain || [1, 1, 1];
        const g = [wg[0] * fg[0], wg[1] * fg[1], wg[2] * fg[2]];
        for (let c0 = 0; c0 < W; c0 += 128) {
          const cw = Math.min(128, W - c0);
          const xc = (R.x + c0 + cw / 2 + 0.5) / scale - 0.5, yc = ((R.y + Y0 + R.y + Y1) / 2 + 0.5) / scale - 0.5;
          const L = F ? localAffineAt(warp, F, xc, yc) : warp;
          for (let Y = Y0; Y < Y1; Y++) {
            const y = (R.y + Y + 0.5) / scale - 0.5;
            let cell = -1;
            if (F && k !== refIndex) cell = clamp(Math.round((y - F.y0) / F.T), 0, F.ny - 1) * F.nx;
            for (let X = c0; X < c0 + cw; X++) {
              const x = (R.x + X + 0.5) / scale - 0.5;
              if (cell >= 0 && !F.ok[cell + clamp(Math.round((x - F.x0) / F.T), 0, F.nx - 1)]) continue;
              const qx = L.a * x + L.b * y + L.c, qy = L.d * x + L.e * y + L.f;
              const ix = Math.round(qx), iy = Math.round(qy);
              if (ix < 1 || iy < 1 || ix > f.width - 2 || iy > f.height - 2) continue;
              const ob = ((Y - Y0) * W + X) * 3;
              for (let sy = iy - 1; sy <= iy + 1; sy++) {
                const dy = qy - sy, row = sy * stride, crow = (sy & 1) * 2;
                for (let sx = ix - 1; sx <= ix + 1; sx++) {
                  const dx = qx - sx, d2 = dx * dx + dy * dy;
                  const wgt = lut[Math.min(LUTN, (d2 / LUTMAX * LUTN) | 0)], c = cfa[crow + (sx & 1)];
                  num[ob + c] += wgt * (d[row + sx] - bl[crow + (sx & 1)]) * g[c]; den[ob + c] += wgt;
                }
              }
            }
          }
        }
      }
      for (let Y = Y0; Y < Y1; Y++) for (let X = 0; X < W; X++) {
        const ob = ((Y - Y0) * W + X) * 3;
        toRGBA(num[ob] / (den[ob] || 1), num[ob + 1] / (den[ob + 1] || 1), num[ob + 2] / (den[ob + 2] || 1), out, (Y * W + X) * 4);
      }
    }
    onProgress(1, 'Merged');
    return { width: W, height: H, data: out };
  }

  // ---------- deblur (after the merge) ----------
  //
  // Richardson–Lucy deconvolution with a mild 3-tap blur model
  // [1/4, 1/2, 1/4] per axis (each output pixel is half an input pixel; the
  // sensor integrates over the whole input pixel). Merging several photos
  // lowers the noise enough for this to recover detail; on one photo alone it
  // mostly amplifies noise.
  //
  // `amount` (0..1) blends the result per pixel by local detail, like a
  // Wiener filter: flat areas (variance near the noise level) keep the merge,
  // textured areas get the deconvolved value. Runs in strips with a halo, so
  // memory stays a few strips of float.

  const RL_K = [0.25, 0.5, 0.25];

  // Noise sigma of an RGBA image (Immerkær 1996: 3x3 Laplacian-difference
  // kernel, on luma, sampled every 4th row).
  function estimateNoise(img) {
    const { width: w, height: h, data: d } = img;
    const Y = (i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    let s = 0, n = 0;
    for (let y = 1; y < h - 1; y += 4) for (let x = 1; x < w - 1; x++) {
      const o = (y * w + x) * 4, r = w * 4;
      const v = Y(o - r - 4) - 2 * Y(o - r) + Y(o - r + 4) - 2 * Y(o - 4) + 4 * Y(o) - 2 * Y(o + 4) + Y(o + r - 4) - 2 * Y(o + r) + Y(o + r + 4);
      s += Math.abs(v); n++;
    }
    return Math.sqrt(Math.PI / 2) / 6 * s / n;
  }

  function blur3(src, w, h, out, tmp) {
    for (let y = 0; y < h; y++) {
      const o = y * w;
      tmp[o] = 0.75 * src[o] + 0.25 * src[o + 1];
      for (let x = 1; x < w - 1; x++) tmp[o + x] = 0.25 * src[o + x - 1] + 0.5 * src[o + x] + 0.25 * src[o + x + 1];
      tmp[o + w - 1] = 0.25 * src[o + w - 2] + 0.75 * src[o + w - 1];
    }
    for (let y = 0; y < h; y++) {
      const a = Math.max(0, y - 1) * w, b = y * w, c = Math.min(h - 1, y + 1) * w;
      for (let x = 0; x < w; x++) out[b + x] = 0.25 * tmp[a + x] + 0.5 * tmp[b + x] + 0.25 * tmp[c + x];
    }
    return out;
  }

  /**
   * opts: { iterations = 6, amount = 1, noise (sigma, levels; estimated if
   * missing), stripRows = 256, onProgress }. Returns a new RGBA image.
   */
  function deblur(img, opts = {}) {
    const iters = opts.iterations || 6, amount = opts.amount == null ? 1 : opts.amount;
    const { width: W, height: H, data } = img, out = new Uint8ClampedArray(data.length);
    const noise = opts.noise == null ? estimateNoise(img) : opts.noise, nv = Math.max(0.25, noise * noise);
    const halo = 2 * iters + 4, rows = opts.stripRows || 256, onProgress = opts.onProgress || (() => {});
    for (let Y0 = 0; Y0 < H; Y0 += rows) {
      onProgress(Y0 / H, 'Sharpening');
      const Y1 = Math.min(H, Y0 + rows), a = Math.max(0, Y0 - halo), b = Math.min(H, Y1 + halo), h = b - a, n = W * h;
      const obs = new Float32Array(n), est = new Float32Array(n), tmp = new Float32Array(n), bl = new Float32Array(n);
      for (let c = 0; c < 3; c++) {
        for (let i = 0, j = a * W * 4 + c; i < n; i++, j += 4) obs[i] = data[j] + 1;
        est.set(obs);
        for (let it = 0; it < iters; it++) {
          blur3(est, W, h, bl, tmp);
          for (let i = 0; i < n; i++) bl[i] = obs[i] / Math.max(bl[i], 1e-3);
          blur3(bl, W, h, bl, tmp);
          for (let i = 0; i < n; i++) est[i] *= bl[i];
        }
        // local variance of the observation (3x3 box), for the detail weight
        for (let y = Y0; y < Y1; y++) {
          const r = y - a;
          for (let x = 0; x < W; x++) {
            let s = 0, s2 = 0, m = 0;
            for (let dy = -1; dy <= 1; dy++) {
              const rr = clamp(r + dy, 0, h - 1) * W;
              for (let dx = -1; dx <= 1; dx++) { const v = obs[rr + clamp(x + dx, 0, W - 1)]; s += v; s2 += v * v; m++; }
            }
            const variance = Math.max(0, s2 / m - (s / m) * (s / m));
            const wgt = amount * Math.max(0, variance - nv) / (variance + 1e-6);
            const i = r * W + x;
            out[(y * W + x) * 4 + c] = obs[i] - 1 + wgt * (est[i] - obs[i]);
          }
        }
      }
      for (let y = Y0; y < Y1; y++) for (let x = 0; x < W; x++) out[(y * W + x) * 4 + 3] = 255;
    }
    onProgress(1, 'Sharpened');
    return { width: W, height: H, data: out };
  }

  /**
   * Choose the deblur amount from the burst itself (hold-out validation):
   * leave out the best-aligned non-reference photo, merge the others on a few
   * regions, deblur each candidate amount, shrink it back to photo size with
   * the 2x2 sensor box, and compare with the left-out photo seen through its
   * own warp. The amount that predicts the unseen photo best wins.
   * Needs 3+ photos. Returns { amount, errors: { amount: rms }, held }.
   * opts.mergeRegion(keepIndices, region) replaces the default mean merge
   * (the raw path passes its own); `frames` are always RGBA, for the
   * comparison. Only trust this when the photos are not sharpened in camera:
   * a sharpened held-out photo rewards matching the camera's sharpening.
   */
  function chooseDeblur(frames, warps, details, refIndex, opts = {}) {
    const amounts = opts.amounts || [0, 0.25, 0.5, 0.75, 1];
    const iterations = opts.iterations || 6, scale = 2, N = frames.length;
    if (N < 3) return { amount: opts.fallback ?? 0, errors: {}, held: -1, reason: 'needs 3 or more photos' };
    let held = -1;
    for (let k = 0; k < N; k++) if (k !== refIndex && (held < 0 || details[k].err < details[held].err)) held = k;
    const keep = [...Array(N).keys()].filter((k) => k !== held);
    const { width: w, height: h } = frames[0];
    const S = Math.min(384, (Math.min(w, h) * scale) >> 2) & ~1, pad = 2 * iterations + 8;
    const regions = [];
    for (const fy of [0.3, 0.7]) for (const fx of [0.3, 0.7]) {
      regions.push({ x: (Math.round(fx * w * scale - S / 2 - pad)) & ~1, y: (Math.round(fy * h * scale - S / 2 - pad)) & ~1, width: S + 2 * pad, height: S + 2 * pad });
    }
    const sse = Object.fromEntries(amounts.map((a) => [a, 0]));
    let count = 0;
    for (const R of regions) {
      const X = opts.mergeRegion ? opts.mergeRegion(keep, R)
        : merge(keep.map((k) => frames[k]), keep.map((k) => warps[k]), { region: R, refIndex: keep.indexOf(refIndex), mode: 'mean' });
      // the held-out photo on the reference grid at photo resolution (scale 1)
      const lx = R.x / 2, ly = R.y / 2, lw = R.width / 2, lh = R.height / 2;
      const Fk = resampleRegion(frames[held], { scale: 1, warp: warps[held], x: lx, y: ly, width: lw, height: lh });
      const g = warps[held].gain || [1, 1, 1];
      const lp = pad / 2;
      const noise = estimateNoise(X);
      for (const a of amounts) {
        const D = a ? deblur(X, { iterations, amount: a, noise }) : X;
        for (let y = lp; y < lh - lp; y++) for (let x = lp; x < lw - lp; x++) {
          for (let c = 0; c < 3; c++) {
            const o = (2 * y * R.width + 2 * x) * 4 + c, r = R.width * 4;
            const pred = 0.25 * (D.data[o] + D.data[o + 4] + D.data[o + r] + D.data[o + r + 4]);
            const e = pred - Fk.data[(y * lw + x) * 4 + c] * g[c];
            sse[a] += e * e;
          }
          if (a === amounts[0]) count += 3;
        }
      }
    }
    const errors = Object.fromEntries(amounts.map((a) => [a, Math.sqrt(sse[a] / count)]));
    let amount = amounts[0];
    for (const a of amounts) if (errors[a] < errors[amount]) amount = a;
    return { amount, errors, held };
  }

  function median(a, m) {
    // insertion sort: m is the frame count (small)
    for (let i = 1; i < m; i++) { const v = a[i]; let j = i - 1; while (j >= 0 && a[j] > v) { a[j + 1] = a[j]; j--; } a[j + 1] = v; }
    return m & 1 ? a[m >> 1] : 0.5 * (a[(m >> 1) - 1] + a[m >> 1]);
  }

  /**
   * How much the merge changed the picture: compares `merged` with the
   * reference photo upscaled 2× on its own, on `sampleRows` evenly spaced
   * output rows (cheap; no second full-size image). Luma levels, 0..255.
   * Returns { meanAbs, pctOver } where pctOver = % of pixels off by > `threshold`.
   */
  function compareToSingle(merged, ref, { scale = 2, sampleRows = 96, threshold = 3 } = {}) {
    const W = merged.width, H = merged.height, rows = Math.min(sampleRows, H);
    let sum = 0, over = 0, n = 0;
    for (let k = 0; k < rows; k++) {
      const Y = Math.min(H - 1, Math.round((k + 0.5) * H / rows));
      const single = resampleRegion(ref, { scale, x: 0, y: Y, width: W, height: 1 }).data;
      const o = Y * W * 4, m = merged.data;
      for (let i = 0; i < W * 4; i += 4) {
        const d = Math.abs(0.299 * (m[o + i] - single[i]) + 0.587 * (m[o + i + 1] - single[i + 1]) + 0.114 * (m[o + i + 2] - single[i + 2]));
        sum += d; if (d > threshold) over++; n++;
      }
    }
    return { meanAbs: sum / n, pctOver: 100 * over / n, threshold };
  }

  // ---------- metrics (luma, border excluded) ----------

  function borderLuma(img, border) {
    const L = toLuma(img);
    return cropLuma(L, border, border, L.w - 2 * border, L.h - 2 * border);
  }

  function psnr(a, b, border = 0) {
    const A = borderLuma(a, border), B = borderLuma(b, border);
    let sse = 0;
    for (let i = 0; i < A.d.length; i++) { const e = A.d[i] - B.d[i]; sse += e * e; }
    const mse = sse / A.d.length;
    return mse === 0 ? Infinity : 10 * Math.log10(255 * 255 / mse);
  }

  function gaussBlur(src, w, h, sigma) {
    const r = Math.ceil(3 * sigma), k = new Float32Array(2 * r + 1);
    let s = 0;
    for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-i * i / (2 * sigma * sigma)); s += k[i + r]; }
    for (let i = 0; i < k.length; i++) k[i] /= s;
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = 0;
      for (let t = -r; t <= r; t++) v += k[t + r] * src[y * w + clamp(x + t, 0, w - 1)];
      tmp[y * w + x] = v;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = 0;
      for (let t = -r; t <= r; t++) v += k[t + r] * tmp[clamp(y + t, 0, h - 1) * w + x];
      out[y * w + x] = v;
    }
    return out;
  }

  // Standard SSIM (Wang et al. 2004): Gaussian window sigma 1.5, K1 0.01, K2 0.03.
  function ssim(a, b, border = 0) {
    const A = borderLuma(a, border), B = borderLuma(b, border), { w, h } = A, n = w * h;
    const ma = gaussBlur(A.d, w, h, 1.5), mb = gaussBlur(B.d, w, h, 1.5);
    const p = new Float32Array(n);
    for (let i = 0; i < n; i++) p[i] = A.d[i] * A.d[i];
    const saa = gaussBlur(p, w, h, 1.5);
    for (let i = 0; i < n; i++) p[i] = B.d[i] * B.d[i];
    const sbb = gaussBlur(p, w, h, 1.5);
    for (let i = 0; i < n; i++) p[i] = A.d[i] * B.d[i];
    const sab = gaussBlur(p, w, h, 1.5);
    const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2;
    let s = 0;
    for (let i = 0; i < n; i++) {
      const va = saa[i] - ma[i] * ma[i], vb = sbb[i] - mb[i] * mb[i], cv = sab[i] - ma[i] * mb[i];
      s += ((2 * ma[i] * mb[i] + C1) * (2 * cv + C2)) / ((ma[i] * ma[i] + mb[i] * mb[i] + C1) * (va + vb + C2));
    }
    return s / n;
  }

  // f×f box average: the sensor-integration model used to synthesize test bursts.
  function downsampleBox(img, f) {
    const w = Math.floor(img.width / f), h = Math.floor(img.height / f), W = img.width, src = img.data;
    const out = new Uint8ClampedArray(w * h * 4), inv = 1 / (f * f);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let j = 0; j < f; j++) for (let i = 0; i < f; i++) {
        const p = ((y * f + j) * W + x * f + i) * 4;
        r += src[p]; g += src[p + 1]; b += src[p + 2];
      }
      const o = (y * w + x) * 4;
      out[o] = r * inv; out[o + 1] = g * inv; out[o + 2] = b * inv; out[o + 3] = 255;
    }
    return { width: w, height: h, data: out };
  }

  return {
    MODES, IDENTITY, translation, applyWarp, mapPoint, verdictFor, defaultSelection, toLuma, buildPyramid, sharpness,
    register, registerBurst, lanczos3, resampleRegion, merge, mergeCFA, deblur, chooseDeblur, estimateNoise, compareToSingle, psnr, ssim, downsampleBox,
  };
}

if (typeof module === 'object' && module.exports) module.exports = createSRCore();
