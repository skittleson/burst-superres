/* spike.js — WebGL2 vs JS gather-merge spike (docs/ROADMAP.md P2).
 *
 * Q: does a single WebGL2 pass (upload + render + readPixels) beat the
 * single-threaded JS merge (the app's warpStrip math, one worker) by >= 2x?
 *
 * N=4 synthetic 1024x684 float grayscale frames, 4 known sub-pixel
 * translations, 2x upscale to 2048x1368, mean merge. JS path replicates
 * sr-core.js warpStrip: 6-tap Lanczos3 separable through the warp via the
 * shared 256-phase LUT, two passes (horizontal source rows into tmp, then
 * vertical gather). GL path: same LUT as an R32F texture, frames as R32F
 * textures, one fullscreen pass doing the equivalent tensor-product 6x6
 * gather per frame (identical math to separable two-pass for a translation),
 * mean in the fragment shader, readPixels into Float32Array.
 *
 * Result: window.__spikeDone = { ok, maxDiff, jsMs, glMs, error? }
 */
(function () {
  'use strict';

  var NW = 1024, NH = 684, SCALE = 2, N = 4;
  var OW = NW * SCALE, OH = NH * SCALE;
  var TAPS = 6, PHASES = 256;
  // Known sub-pixel translations (frame coords = ref coords + t). Values are
  // exact binary fractions whose X/2 + tx phases stay >= ~1/64 from integer
  // and half boundaries: JS computes in double, GL in float32, and one
  // flipped LUT row at an edge would blow the 1e-3 diff budget.
  var WARPS = [[0, 0], [0.303125, -0.703125], [-0.55078125, 0.40234375], [0.80078125, 0.25390625]];

  // ---------- shared Lanczos3 LUT (same math as sr-core.js) ----------

  function lanczos3(t) {
    if (t === 0) return 1;
    if (t <= -3 || t >= 3) return 0;
    var a = Math.PI * t;
    return (3 * Math.sin(a) * Math.sin(a / 3)) / (a * a);
  }
  var LUT = new Float32Array((PHASES + 1) * TAPS);
  for (var p = 0; p <= PHASES; p++) {
    var s = 0;
    for (var t = 0; t < TAPS; t++) { var v = lanczos3(p / PHASES + 2 - t); LUT[p * TAPS + t] = v; s += v; }
    for (var t2 = 0; t2 < TAPS; t2++) LUT[p * TAPS + t2] /= s;
  }

  // ---------- synthetic input: smooth value-noise layers + hard edges ----------

  function makeFrames() {
    var seed = 12345;
    function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
    function layer(gs) {
      var g = new Float32Array((gs + 1) * (gs + 1));
      for (var i = 0; i < g.length; i++) g[i] = rnd();
      return function (x, y) {
        var fx = x / NW * gs, fy = y / NH * gs;
        var ix = Math.min(gs - 1, fx | 0), iy = Math.min(gs - 1, fy | 0);
        var tx = fx - ix, ty = fy - iy;
        var a = g[iy * (gs + 1) + ix], b = g[iy * (gs + 1) + ix + 1];
        var c = g[(iy + 1) * (gs + 1) + ix], d = g[(iy + 1) * (gs + 1) + ix + 1];
        return (a + (b - a) * tx) + ((c + (d - c) * tx) - (a + (b - a) * tx)) * ty;
      };
    }
    var layers = [layer(8), layer(24), layer(64), layer(160)];
    var frames = [];
    for (var k = 0; k < N; k++) {
      var d = new Float32Array(NW * NH);
      for (var y = 0; y < NH; y++) {
        for (var x = 0; x < NW; x++) {
          var v2 = 0;
          v2 += 90 * layers[0](x, y);
          v2 += 60 * layers[1](x, y);
          v2 += 40 * layers[2](x, y);
          v2 += 25 * layers[3](x, y);
          if (x > 300 && x < 700) v2 += (y > 200 ? 55 : -55);       // hard step edge
          if ((x + y) % 211 < 3) v2 += 120;                          // thin bright bars
          d[y * NW + x] = v2;
        }
      }
      frames.push(d);
    }
    return frames;
  }

  // ---------- JS path: warpStrip math from sr-core.js, single-threaded ----------

  function clampi(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  // Full OW x OH of `src` through translation (tx, ty) into out.
  // warpStrip with a=1,b=0,c=tx,d=0,e=1,f=ty: al=1, be=0, ga=tx, v = y+ty.
  // Pass 1: resample every source row r horizontally at u = xs + tx.
  // Pass 2: vertical gather at v = y + ty from the tmp rows (edge-clamped).
  function jsRender(src, tx, ty, out) {
    var tmp = new Float32Array(NH * OW);
    for (var r = 0; r < NH; r++) {
      var o = r * OW, row = r * NW;
      for (var X = 0; X < OW; X++) {
        var u = (X + 0.5) / SCALE - 0.5 + tx;
        var fu = Math.floor(u), i0 = fu - 2;
        var wo = Math.round((u - fu) * PHASES) * TAPS;
        var acc = 0;
        if (i0 >= 0 && i0 + TAPS <= NW) {
          for (var tt = 0, p0 = row + i0; tt < TAPS; tt++) acc += LUT[wo + tt] * src[p0 + tt];
        } else {
          for (var t3 = 0; t3 < TAPS; t3++) acc += LUT[wo + t3] * src[row + clampi(i0 + t3, 0, NW - 1)];
        }
        tmp[o + X] = acc;
      }
    }
    for (var Y = 0; Y < OH; Y++) {
      var v3 = (Y + 0.5) / SCALE - 0.5 + ty, fv = Math.floor(v3);
      var wo2 = Math.round((v3 - fv) * PHASES) * TAPS;
      var ob = Y * OW;
      for (var X2 = 0; X2 < OW; X2++) {
        var a2 = 0;
        for (var t4 = 0; t4 < TAPS; t4++) a2 += LUT[wo2 + t4] * tmp[clampi(fv - 2 + t4, 0, NH - 1) * OW + X2];
        out[ob + X2] = a2;
      }
    }
  }

  function jsMerge(frames) {
    var out = new Float32Array(OW * OH), strip = new Float32Array(OW * OH);
    for (var k = 0; k < N; k++) {
      jsRender(frames[k], WARPS[k][0], WARPS[k][1], strip);
      for (var i = 0; i < out.length; i++) out[i] += strip[i];
    }
    for (var i2 = 0; i2 < out.length; i2++) out[i2] /= N;
    return out;
  }

  // ---------- GL path ----------

  function makeGL(frames) {
    var canvas = document.createElement('canvas');
    canvas.width = OW; canvas.height = OH;
    var gl = canvas.getContext('webgl2', { antialias: false, depth: false });
    if (!gl) throw new Error('no webgl2');
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('no EXT_color_buffer_float');

    function shader(type, src) {
      var s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    }
    var vs = shader(gl.VERTEX_SHADER, [
      '#version 300 es',
      'void main() {',
      '  vec2 pos = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));',
      '  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);',
      '}'
    ].join('\n'));
    var fs = shader(gl.FRAGMENT_SHADER, [
      '#version 300 es',
      'precision highp float;',
      'precision highp sampler2D;',
      'uniform sampler2D u_frames[4];',
      'uniform sampler2D u_lut;',
      'uniform vec2 u_tx[4];',
      'out float o_color;',
      // LUT texture is (TAPS x PHASES+1); texel (tap, phase).
      // gl_FragCoord (exact half-integers), NOT an interpolated varying:
      // varyings interpolate in low-precision fixed point and would flip
      // floor(pix) at edges.
      'float gather(sampler2D f, vec2 t) {',
      '  vec2 pix = gl_FragCoord.xy * 0.5 - 0.5 + t;',
      '  vec2 fu = floor(pix);',
      '  int iu0 = int(fu.x) - 2, iv0 = int(fu.y) - 2;',
      '  int rowh = int(floor(fract(pix.x) * 256.0 + 0.5));',
      '  int rowv = int(floor(fract(pix.y) * 256.0 + 0.5));',
      '  float acc = 0.0;',
      '  for (int tv = 0; tv < 6; tv++) {',
      '    float wv = texelFetch(u_lut, ivec2(tv, rowv), 0).r;',
      '    int iv = clamp(iv0 + tv, 0, 683);',
      '    for (int tu = 0; tu < 6; tu++) {',
      '      int iu = clamp(iu0 + tu, 0, 1023);',
      '      acc += wv * texelFetch(u_lut, ivec2(tu, rowh), 0).r * texelFetch(f, ivec2(iu, iv), 0).r;',
      '    }',
      '  }',
      '  return acc;',
      '}',
      'void main() {',
      '  o_color = (gather(u_frames[0], u_tx[0]) + gather(u_frames[1], u_tx[1])',
      '           + gather(u_frames[2], u_tx[2]) + gather(u_frames[3], u_tx[3])) * 0.25;',
      '}'
    ].join('\n'));
    var prog = gl.createProgram();
    gl.attachShader(prog, vs); gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);

    function tex(w, h, data) {
      var t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, w, h, 0, gl.RED, gl.FLOAT, data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    }
    var lutTex = tex(TAPS, PHASES + 1, LUT);
    var frameTex = frames.map(function (d) { return tex(NW, NH, d); });
    gl.uniform1i(gl.getUniformLocation(prog, 'u_lut'), N);
    for (var k = 0; k < N; k++) {
      gl.uniform1i(gl.getUniformLocation(prog, 'u_frames[' + k + ']'), k);
      gl.uniform2f(gl.getUniformLocation(prog, 'u_tx[' + k + ']'), WARPS[k][0], WARPS[k][1]);
    }

    var fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex(OW, OH, null), 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('incomplete fbo');
    gl.viewport(0, 0, OW, OH);

    // One timed iteration: upload frames, render, read back.
    return function render() {
      for (var i = 0; i < N; i++) {
        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(gl.TEXTURE_2D, frameTex[i]);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, NW, NH, gl.RED, gl.FLOAT, frames[i]);
      }
      gl.activeTexture(gl.TEXTURE0 + N);
      gl.bindTexture(gl.TEXTURE_2D, lutTex);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      var out = new Float32Array(OW * OH);
      gl.readPixels(0, 0, OW, OH, gl.RED, gl.FLOAT, out);
      return out; // readPixels row 0 == v_uv.y 0 == JS output row 0 (no flip)
    };
  }

  // ---------- timing ----------

  function med5(fn) {
    fn(); fn(); // warmups
    var ts = [];
    for (var i = 0; i < 5; i++) { var a = performance.now(); fn(); ts.push(performance.now() - a); }
    ts.sort(function (x, y) { return x - y; });
    return ts[2];
  }

  try {
    var frames = makeFrames();
    var jsOut = jsMerge(frames);
    var jsMs = med5(function () { jsMerge(frames); });
    var glRender = makeGL(frames);
    var glOut = glRender();
    var glMs = med5(function () { glRender(); });
    var maxDiff = 0;
    for (var i = 0; i < jsOut.length; i++) {
      var d = Math.abs(jsOut[i] - glOut[i]);
      if (d > maxDiff) maxDiff = d;
    }
    window.__spikeDone = { ok: maxDiff < 1e-3, maxDiff: maxDiff, jsMs: jsMs, glMs: glMs };
  } catch (e) {
    window.__spikeDone = { ok: false, maxDiff: NaN, jsMs: NaN, glMs: NaN, error: String((e && e.stack) || e) };
  }
})();
