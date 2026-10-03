// WebGL2 viewer for a FetLoom die layout, in two modes:
//   mask      - the manufacturing masks, straight from the cached Int32 records
//   schematic - the same placement drawn as MOS symbols and wire centre lines,
//               with the bits of a bus merged into one thick line
// Both are drawn as instanced quads; the live logic value of every net is uploaded as a
// texture each frame, so geometry is coloured by voltage without being rebuilt.

import {LAYERS, FLAG_NCH, FLAG_PCH} from './die.js';
import {SCH_LAYERS, buildSchematic, busValue, busText} from './die-schematic.js';

const VS = `#version 300 es
precision highp float; precision highp int;
layout(location=0) in vec2 aCorner;
layout(location=1) in ivec4 aRect;
layout(location=2) in ivec2 aInfo;
uniform vec2 uScale, uOffset, uPx;
uniform highp usampler2D uVals;
uniform int uVoltage, uMono;
uniform vec4 uColor;
out vec4 vColor;
vec3 level(uint v) {
  return v == 1u ? vec3(1.0, 0.30, 0.16) : v == 0u ? vec3(0.13, 0.40, 1.0) : v == 3u ? vec3(0.92, 0.22, 0.95) : v == 4u ? vec3(1.0, 0.76, 0.2) : vec3(0.55, 0.58, 0.62);
}
void main() {
  vec2 size = max(vec2(aRect.zw), uPx);
  vec2 p = vec2(aRect.xy) + (vec2(aRect.zw) - size) * 0.5 + aCorner * size;
  gl_Position = vec4(p * uScale + uOffset, 0.0, 1.0);
  vec4 c = uColor;
  int net = aInfo.y, flags = aInfo.x >> 8;
  if (uVoltage == 1 && uMono == 0 && net >= 0) {
    uint v = texelFetch(uVals, ivec2(net & 1023, net >> 10), 0).r;
    if (flags == ${FLAG_NCH} || flags == ${FLAG_PCH}) {
      bool on = (flags == ${FLAG_NCH} && v == 1u) || (flags == ${FLAG_PCH} && v == 0u);
      c = on ? vec4(0.25, 1.0, 0.45, 0.95) : vec4(0.06, 0.07, 0.08, 0.9);
    } else {
      c = vec4(mix(level(v), uColor.rgb, 0.18), net < 2 ? uColor.a : max(uColor.a, 0.6)); // supply rails stay subdued
    }
  }
  vColor = c;
}`;
const FS = `#version 300 es
precision mediump float;
in vec4 vColor; out vec4 o;
void main() { o = vColor; }`;

function hex(c, a) { const n = parseInt(c.slice(1), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255, a]; }
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); }
  for (const k of kids) e.append(k);
  return e;
}

export class DieView {
  constructor(container, {onProbe = () => {}, getNetName = n => String(n)} = {}) {
    this.onProbe = onProbe; this.getNetName = getNetName;
    this.visible = LAYERS.map(() => true);
    this.solo = -1; this.voltage = true; this.showBlocks = true; this.showShorts = true;
    this.getValue = null; this.die = null; this.hover = null; this.mode = 'mask';
    this.cam = {x:0, y:0, z:1};
    container.innerHTML = '';
    container.classList.add('die-pane');
    this.statusEl = el('span', {class:'die-status'});
    this.hoverEl = el('span', {class:'die-hover'});
    const maskSel = el('select', {title:'show a single manufacturing mask', onchange: e => { this.solo = Number(e.target.value); this.render(); }},
      el('option', {value:'-1'}, 'All masks (composite)'), ...LAYERS.map((l, i) => el('option', {value:String(i)}, `Mask ${i + 1}: ${l.label}`)));
    const chk = (label, val, fn) => { const i = el('input', {type:'checkbox'}); i.checked = val; i.addEventListener('change', () => { fn(i.checked); this.render(); }); return el('label', {}, i, label); };
    const legend = el('div', {class:'die-legend'});
    LAYERS.forEach((l, i) => {
      const box = el('input', {type:'checkbox'}); box.checked = true;
      box.addEventListener('change', () => { this.visible[i] = box.checked; this.render(); });
      legend.append(el('label', {title:l.name}, box, el('i', {style:`background:${l.color}`}), l.label));
    });
    this.maskSel = maskSel; this.legend = legend;
    const modeSel = this.modeSel = el('select', {title:'drawing mode', onchange: e => this.setMode(e.target.value)},
      el('option', {value:'mask'}, 'Mask pattern'), el('option', {value:'schematic'}, 'Schematic'));
    this.shortsChk = chk('Conflicts', true, v => { this.showShorts = v; });
    const bar = el('div', {class:'toolbar wrap'},
      modeSel,
      chk('Voltage', true, v => { this.voltage = v; }),
      chk('Blocks', true, v => { this.showBlocks = v; }),
      this.shortsChk,
      maskSel,
      el('button', {onclick: () => this.fit()}, 'Fit'),
      this.statusEl);
    this.wrap = el('div', {class:'die-canvas'});
    this.canvas = el('canvas'); this.overlay = el('canvas', {class:'die-overlay'});
    this.wrap.append(this.canvas, this.overlay);
    container.append(bar, legend, this.wrap, el('div', {class:'die-foot'}, this.hoverEl));
    this.ctx = this.overlay.getContext('2d');
    this.gl = this.canvas.getContext('webgl2', {antialias:false, premultipliedAlpha:false});
    if (!this.gl) { this.statusEl.textContent = 'WebGL2 is not available in this browser'; return; }
    this._initGl();
    this._bindEvents();
    new ResizeObserver(() => this._resize()).observe(this.wrap);
  }

  _initGl() {
    const gl = this.gl;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    this.prog = p;
    this.u = Object.fromEntries(['uScale', 'uOffset', 'uPx', 'uVals', 'uVoltage', 'uMono', 'uColor'].map(n => [n, gl.getUniformLocation(p, n)]));
    this.vao = gl.createVertexArray(); gl.bindVertexArray(this.vao);
    const quad = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.inst = gl.createBuffer();
    this.schBuf = gl.createBuffer();
    this.bg = gl.createBuffer();
    this.valTex = gl.createTexture();
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  _bindInstances(buf, firstRect) {
    const gl = this.gl, off = firstRect * 24;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(1); gl.vertexAttribIPointer(1, 4, gl.INT, 24, off); gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2); gl.vertexAttribIPointer(2, 2, gl.INT, 24, off + 16); gl.vertexAttribDivisor(2, 1);
  }

  // netMeta (from the elaborated circuit) is needed to find buses for the schematic mode
  setDie(die, info = '', netMeta = null) {
    this.die = die; this.netMeta = netMeta;
    this.hover = null;
    const {header, rects} = die;
    this.statusEl.textContent = info;
    this.scenes = {mask: {rects, ranges: header.layerRanges, styles: LAYERS, buf: this.inst}, schematic: null};
    this.buses = [];
    if (!this.gl) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.inst); gl.bufferData(gl.ARRAY_BUFFER, rects, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bg); gl.bufferData(gl.ARRAY_BUFFER, new Int32Array([0, 0, header.size[0], header.size[1], 0, -1]), gl.STATIC_DRAW);
    this._allocValues(header.stats.nets);
    this.blocks = header.blocks.slice().sort((a, b) => a.d - b.d);
    if (this.mode === 'schematic') this._ensureSchematic();
    this.fit();
  }

  _allocValues(count) {
    const gl = this.gl;
    this.texH = Math.max(1, Math.ceil(count / 1024));
    this.vals = new Uint8Array(1024 * this.texH).fill(2);
    gl.bindTexture(gl.TEXTURE_2D, this.valTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, 1024, this.texH, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, this.vals);
  }

  _ensureSchematic() {
    if (!this.die || this.scenes.schematic) return;
    const sch = buildSchematic(this.die, this.netMeta || []);
    this.buses = sch.buses;
    this.scenes.schematic = {rects: sch.rects, ranges: sch.layerRanges, styles: SCH_LAYERS, buf: this.schBuf};
    if (this.gl) {
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.schBuf); this.gl.bufferData(this.gl.ARRAY_BUFFER, sch.rects, this.gl.STATIC_DRAW);
      this._allocValues(this.die.header.stats.nets + this.buses.length);
    }
  }

  setMode(mode) {
    this.mode = mode; this.modeSel.value = mode;
    const mask = mode === 'mask';
    this.legend.hidden = !mask; this.maskSel.hidden = !mask; this.shortsChk.hidden = !mask;
    if (!mask) this._ensureSchematic();
    this.hover = null;
    this.render();
  }

  get scene() { return this.scenes?.[this.mode] || this.scenes?.mask; }
  _layerVisible(i) { return this.mode !== 'mask' || (this.solo >= 0 ? i === this.solo : this.visible[i]); }
  _name(id) {
    const nets = this.die.header.stats.nets;
    if (id < nets) return this.getNetName(id);
    return this.buses[id - nets]?.label ?? String(id);
  }
  _valueText(id) {
    if (!this.getValue) return '';
    const nets = this.die.header.stats.nets;
    return id < nets ? '01ZX'[this.getValue(id)] : busText(this.buses[id - nets], this.getValue);
  }

  setValueSource(fn) { this.getValue = fn; this.render(); }

  fit() {
    if (!this.die) return;
    const [W, H] = this.die.header.size;
    const cw = this.wrap.clientWidth || 800, ch = this.wrap.clientHeight || 600;
    this.cam = {x: W / 2, y: H / 2, z: Math.min(cw / W, ch / H) * 0.96};
    this.render();
  }

  zoomToPath(path) {
    if (!this.die) return;
    let b = null;
    for (let p = path; p && !b; p = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '') b = this.die.header.blocks.find(x => x.p === p);
    if (!b) return this.fit();
    const [x, y, w, h] = b.r;
    const cw = this.wrap.clientWidth, ch = this.wrap.clientHeight;
    this.cam = {x: x + w / 2, y: y + h / 2, z: Math.min(cw / w, ch / h) * 0.85};
    this.render();
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1, w = this.wrap.clientWidth, h = this.wrap.clientHeight;
    for (const c of [this.canvas, this.overlay]) { c.width = Math.max(1, Math.round(w * dpr)); c.height = Math.max(1, Math.round(h * dpr)); }
    if (this.die && !this._fitted) { this._fitted = true; this.fit(); }
    this.render();
  }

  render() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this._draw(); });
  }

  _draw() {
    const gl = this.gl;
    if (!gl || !this.die || !this.canvas.width) return;
    const {header} = this.die;
    const dpr = window.devicePixelRatio || 1, W = this.canvas.width, H = this.canvas.height;
    const z = this.cam.z * dpr;
    gl.viewport(0, 0, W, H);
    const scene = this.scene, schem = this.mode !== 'mask';
    const mono = !schem && this.solo >= 0;
    gl.clearColor(...(mono ? [0.93, 0.95, 0.96, 1] : [0.06, 0.07, 0.09, 1])); gl.clear(gl.COLOR_BUFFER_BIT);
    if (this.getValue && this.voltage) {
      const n = header.stats.nets, v = this.vals;
      for (let i = 0; i < n; i++) v[i] = this.getValue(i);
      if (schem) this.buses.forEach((b, i) => { v[n + i] = busValue(b, this.getValue); });
      gl.bindTexture(gl.TEXTURE_2D, this.valTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 1024, this.texH, gl.RED_INTEGER, gl.UNSIGNED_BYTE, v);
    }
    gl.useProgram(this.prog); gl.bindVertexArray(this.vao);
    gl.uniform2f(this.u.uScale, 2 * z / W, -2 * z / H);
    gl.uniform2f(this.u.uOffset, -2 * z * this.cam.x / W, 2 * z * this.cam.y / H);
    gl.uniform2f(this.u.uPx, 1 / z, 1 / z);
    gl.uniform1i(this.u.uVals, 0); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.valTex);
    gl.uniform1i(this.u.uVoltage, this.voltage && this.getValue ? 1 : 0);
    gl.uniform1i(this.u.uMono, mono ? 1 : 0);
    // silicon substrate
    if (!mono) {
      this._bindInstances(this.bg, 0);
      if (schem) gl.uniform4f(this.u.uColor, 0.09, 0.11, 0.14, 1); else gl.uniform4f(this.u.uColor, 0.17, 0.19, 0.22, 1);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, 1);
    }
    scene.styles.forEach((l, i) => {
      if (!this._layerVisible(i)) return;
      const [first, count] = scene.ranges[i];
      if (!count) return;
      let c = hex(l.color, l.alpha);
      if (mono) c = [0.08, 0.09, 0.1, 1];
      else if (!schem && this.voltage && this.getValue && !l.conductive) c[3] *= 0.5;
      gl.uniform4f(this.u.uColor, ...c);
      this._bindInstances(scene.buf, first);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    });
    this._drawOverlay(dpr);
  }

  _toScreen(x, y) { return [(x - this.cam.x) * this.cam.z + this.wrap.clientWidth / 2, (y - this.cam.y) * this.cam.z + this.wrap.clientHeight / 2]; }
  _toWorld(sx, sy) { return [(sx - this.wrap.clientWidth / 2) / this.cam.z + this.cam.x, (sy - this.wrap.clientHeight / 2) / this.cam.z + this.cam.y]; }

  _drawOverlay(dpr) {
    const ctx = this.ctx, {header} = this.die;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    const schem = this.mode !== 'mask', mono = !schem && this.solo >= 0;
    ctx.font = '11px ui-monospace, monospace';
    if (mono) { // die edge for orientation on a single mask plate
      const [sx, sy] = this._toScreen(0, 0);
      ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 1;
      ctx.strokeRect(sx, sy, header.size[0] * this.cam.z, header.size[1] * this.cam.z);
      ctx.fillStyle = '#333'; ctx.fillText(`mask ${this.solo + 1}/${LAYERS.length}: ${LAYERS[this.solo].label}`, 8, 16);
    }
    // pads
    for (const p of header.pads) {
      const [sx, sy] = this._toScreen(p.r[0], p.r[1]), s = p.r[2] * this.cam.z;
      if (s < 14) continue;
      ctx.fillStyle = mono ? '#333' : '#e8edf2';
      ctx.font = `${Math.min(12, Math.max(8, s * 0.24)) | 0}px ui-monospace, monospace`;
      ctx.fillText(p.l, sx + 2, sy + s / 2 + 4, s - 4);
    }
    ctx.font = '11px ui-monospace, monospace';
    if (this.showBlocks && !mono) {
      const placed = [];
      for (const b of this.blocks) {
        const [sx, sy] = this._toScreen(b.r[0], b.r[1]), sw = b.r[2] * this.cam.z, sh = b.r[3] * this.cam.z;
        if (sw < 6 || sh < 6) continue;
        if (sx > this.wrap.clientWidth || sy > this.wrap.clientHeight || sx + sw < 0 || sy + sh < 0) continue;
        if (b.h) { ctx.setLineDash([]); ctx.strokeStyle = 'rgba(255,214,102,.75)'; ctx.lineWidth = 1.2; ctx.strokeRect(sx, sy, sw, sh); }
        else if (sw > 60) { ctx.setLineDash([4, 3]); ctx.strokeStyle = 'rgba(200,220,255,.35)'; ctx.lineWidth = 1; ctx.strokeRect(sx, sy, sw, sh); }
        if (sw > 70 && sh > 22 && (b.h || sw > 120)) {
          const lx = Math.max(sx, 0) + 4, ly = Math.max(sy, 0) + 13, lw = ctx.measureText(b.m).width;
          if (!placed.some(q => lx < q[0] + q[2] && q[0] < lx + lw && ly - 11 < q[1] && q[1] - 11 < ly)) {
            placed.push([lx, ly, lw]);
            ctx.fillStyle = b.h ? 'rgba(255,224,140,.95)' : 'rgba(220,230,255,.8)';
            ctx.fillText(b.m, lx, ly);
          }
        }
      }
      ctx.setLineDash([]);
    }
    // bus names and values along the thick bus lines
    if (schem) {
      ctx.font = '11px ui-monospace, monospace';
      let n = 0;
      for (const b of this.buses) {
        if (!b.seg || b.seg[2] * this.cam.z < 70 || n > 300) continue;
        const [sx, sy] = this._toScreen(b.seg[0], b.seg[1]);
        if (sx < 0 || sy < 0 || sx > this.wrap.clientWidth || sy > this.wrap.clientHeight) continue;
        const t = `${b.label.split(/[./]/).pop()}${this.getValue ? ' = ' + busText(b, this.getValue) : ''}`;
        const w = ctx.measureText(t).width;
        ctx.fillStyle = 'rgba(10,14,18,.75)'; ctx.fillRect(sx - w / 2 - 3, sy - 8, w + 6, 15);
        ctx.fillStyle = '#ffe9b0'; ctx.fillText(t, sx - w / 2, sy + 4);
        n++;
      }
    }
    // routing conflicts left by the router
    const sh = header.shorts || [];
    if (sh.length && this.showShorts && !schem) {
      ctx.strokeStyle = '#ff3df2'; ctx.lineWidth = 1.5;
      const rad = Math.max(3, 6 * this.cam.z);
      for (let i = 0; i < sh.length; i += 2) {
        const [sx, sy] = this._toScreen(sh[i], sh[i + 1]);
        if (sx < -rad || sy < -rad || sx > this.wrap.clientWidth + rad || sy > this.wrap.clientHeight + rad) continue;
        ctx.beginPath(); ctx.arc(sx, sy, rad, 0, Math.PI * 2); ctx.stroke();
      }
    }
    if (this.hover?.net != null) {
      const idx = this._netRects(this.hover.net), r = this.scene.rects;
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1;
      for (let k = 0; k < idx.length; k++) {
        const o = idx[k] * 6;
        const [sx, sy] = this._toScreen(r[o], r[o + 1]);
        ctx.strokeRect(sx - 0.5, sy - 0.5, Math.max(1, r[o + 2] * this.cam.z) + 1, Math.max(1, r[o + 3] * this.cam.z) + 1);
      }
    }
  }

  // per-net rect lists, built on demand
  _netRects(net) {
    const sc = this.scene;
    if (!sc.netIndex) {
      const r = sc.rects, n = r.length / 6, nets = this.die.header.stats.nets + this.buses.length;
      const start = new Int32Array(nets + 1);
      for (let i = 0; i < n; i++) { const t = r[i * 6 + 5]; if (t >= 2) start[t + 1]++; }
      for (let i = 0; i < nets; i++) start[i + 1] += start[i];
      const list = new Int32Array(start[nets]), fillp = start.slice();
      for (let i = 0; i < n; i++) { const t = r[i * 6 + 5]; if (t >= 2) list[fillp[t]++] = i; }
      sc.netIndex = {start, list};
    }
    const {start, list} = sc.netIndex;
    return net >= 2 && net + 1 < start.length ? list.subarray(start[net], start[net + 1]) : new Int32Array(0);
  }

  // uniform bucket grid over conductive rects for picking
  _pick(wx, wy) {
    const sc = this.scene, r = sc.rects, B = 64;
    if (!sc.bucket) {
      const [W, H] = this.die.header.size, bw = Math.ceil(W / B), bh = Math.ceil(H / B), n = r.length / 6;
      const cnt = new Int32Array(bw * bh + 1);
      const each = fn => { for (let i = 0; i < n; i++) { const o = i * 6; if (r[o + 5] < 0 || !sc.styles[r[o + 4] & 255].conductive) continue;
        const x0 = Math.max(0, Math.floor(r[o] / B)), x1 = Math.min(bw - 1, Math.floor((r[o] + r[o + 2]) / B)), y0 = Math.max(0, Math.floor(r[o + 1] / B)), y1 = Math.min(bh - 1, Math.floor((r[o + 1] + r[o + 3]) / B));
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) fn(y * bw + x, i); } };
      each(b => cnt[b + 1]++);
      for (let i = 0; i < bw * bh; i++) cnt[i + 1] += cnt[i];
      const list = new Int32Array(cnt[bw * bh]), fp = cnt.slice();
      each((b, i) => { list[fp[b]++] = i; });
      sc.bucket = {bw, bh, cnt, list};
    }
    const {bw, bh, cnt, list} = sc.bucket, bx = Math.floor(wx / B), by = Math.floor(wy / B);
    if (bx < 0 || by < 0 || bx >= bw || by >= bh) return null;
    const tol = 2 / this.cam.z;
    let best = null, bestL = -1;
    for (let k = cnt[by * bw + bx]; k < cnt[by * bw + bx + 1]; k++) {
      const o = list[k] * 6, layer = r[o + 4] & 255;
      if (!this._layerVisible(layer)) continue;
      if (wx >= r[o] - tol && wx <= r[o] + r[o + 2] + tol && wy >= r[o + 1] - tol && wy <= r[o + 1] + r[o + 3] + tol && layer > bestL) { bestL = layer; best = r[o + 5]; }
    }
    return best;
  }

  _blockAt(wx, wy) {
    let best = null;
    for (const b of this.die.header.blocks) if (wx >= b.r[0] && wy >= b.r[1] && wx < b.r[0] + b.r[2] && wy < b.r[1] + b.r[3] && (!best || b.d > best.d)) best = b;
    return best;
  }

  _bindEvents() {
    const c = this.overlay;
    let drag = null;
    c.addEventListener('wheel', e => {
      e.preventDefault();
      const rect = c.getBoundingClientRect(), sx = e.clientX - rect.left, sy = e.clientY - rect.top;
      const [wx, wy] = this._toWorld(sx, sy);
      this.cam.z *= Math.exp(-e.deltaY * 0.0015);
      const [nx, ny] = this._toWorld(sx, sy);
      this.cam.x += wx - nx; this.cam.y += wy - ny;
      this.render();
    }, {passive:false});
    c.addEventListener('pointerdown', e => { drag = {x:e.clientX, y:e.clientY, cx:this.cam.x, cy:this.cam.y, moved:false}; c.setPointerCapture(e.pointerId); });
    c.addEventListener('pointermove', e => {
      const rect = c.getBoundingClientRect();
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
        if (drag.moved) { this.cam.x = drag.cx - dx / this.cam.z; this.cam.y = drag.cy - dy / this.cam.z; this.render(); return; }
      }
      if (!this.die) return;
      const [wx, wy] = this._toWorld(e.clientX - rect.left, e.clientY - rect.top);
      const net = this._pick(wx, wy), blk = this._blockAt(wx, wy);
      if (net !== this.hover?.net || blk !== this.hover?.blk) {
        this.hover = {net, blk};
        const v = net != null ? this._valueText(net) : '';
        this.hoverEl.textContent = (blk ? `${blk.p}  ` : '') + (net != null ? `| ${this._name(net)}${v ? ' = ' + v : ''}` : '');
        this.render();
      }
    });
    c.addEventListener('pointerup', e => {
      if (drag && !drag.moved && this.die) {
        const rect = c.getBoundingClientRect();
        const net = this._pick(...this._toWorld(e.clientX - rect.left, e.clientY - rect.top));
        const nets = this.die.header.stats.nets;
        if (net != null && net >= nets) for (const b of this.buses[net - nets].bits) this.onProbe(b);
        else if (net != null && net >= 2) this.onProbe(net);
      }
      drag = null;
    });
    c.addEventListener('dblclick', e => {
      if (!this.die) return;
      const rect = c.getBoundingClientRect();
      const b = this._blockAt(...this._toWorld(e.clientX - rect.left, e.clientY - rect.top));
      if (b) this.zoomToPath(b.p);
    });
  }
}
