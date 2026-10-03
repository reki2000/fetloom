// WebGL2 viewer with two independent drawings of the same circuit:
//   mask      - the die layout as manufacturing masks (cached by src/die.js)
//   schematic - a readable nested block schematic, laid out without regard to the die
//               (cached by src/schematic.js); buses are single thick lines and the inside
//               of a box only appears once the box is large enough on screen
// Both are lists of rectangles drawn as instanced quads.  The live logic value of every
// net (and of every bus bundle) is uploaded as a texture each frame, so the geometry is
// coloured by voltage without being rebuilt.

import {LAYERS, FLAG_NCH, FLAG_PCH} from './die.js';
import {SCH_LAYERS, busValue, busText} from './schematic.js';

const LOD_PX = 90; // a box's content is drawn once the box is at least this many pixels

const VS = `#version 300 es
precision highp float; precision highp int;
layout(location=0) in vec2 aCorner;
layout(location=1) in ivec4 aRect;
layout(location=2) in ivec2 aInfo;
uniform ivec2 uOrigin;      // integer camera origin: keeps large world coordinates exact
uniform vec2 uScale, uShift, uPx;
uniform float uZoom;
uniform highp usampler2D uVals;
uniform int uVoltage, uMono;
uniform vec4 uColor;
out vec4 vColor;
vec3 level(uint v) {
  return v == 1u ? vec3(1.0, 0.30, 0.16) : v == 0u ? vec3(0.13, 0.40, 1.0) : v == 3u ? vec3(0.92, 0.22, 0.95) : v == 4u ? vec3(1.0, 0.76, 0.2) : vec3(0.55, 0.58, 0.62);
}
void main() {
  int lod = (aInfo.x >> 16) & 255;
  if (lod > 0 && exp2(float(lod) / 8.0) * uZoom < ${LOD_PX}.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vColor = vec4(0.0); return; }
  vec2 size = max(vec2(aRect.zw), uPx);
  vec2 p = vec2(aRect.xy - uOrigin) + (vec2(aRect.zw) - size) * 0.5 + aCorner * size;
  gl_Position = vec4((p + uShift) * uScale, 0.0, 1.0);
  vec4 c = uColor;
  int net = aInfo.y, flags = (aInfo.x >> 8) & 255;
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
const lodSize = info => { const c = (info >> 16) & 255; return c ? 2 ** (c / 8) : Infinity; };

export class DieView {
  // loadSchematic: async (onStatus) => ({die, info}) supplying the schematic layout on first use
  constructor(container, {onProbe = () => {}, getNetName = n => String(n), loadSchematic = null} = {}) {
    this.onProbe = onProbe; this.getNetName = getNetName; this.loadSchematic = loadSchematic;
    this.visible = LAYERS.map(() => true);
    this.solo = -1; this.voltage = true; this.showBlocks = true; this.showShorts = true;
    this.getValue = null; this.hover = null; this.mode = 'mask';
    this.scenes = {mask: null, schematic: null};
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
    this.modeSel = el('select', {title:'drawing mode', onchange: e => this.setMode(e.target.value)},
      el('option', {value:'mask'}, 'Mask pattern'), el('option', {value:'schematic'}, 'Schematic'));
    const blocksChk = chk('Blocks', true, v => { this.showBlocks = v; }), shortsChk = chk('Conflicts', true, v => { this.showShorts = v; });
    this.maskOnly = [blocksChk, shortsChk, maskSel, legend];
    const bar = el('div', {class:'toolbar wrap'}, this.modeSel, chk('Voltage', true, v => { this.voltage = v; }),
      blocksChk, shortsChk, maskSel, el('button', {onclick: () => this.fit()}, 'Fit'), this.statusEl);
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
    this.u = Object.fromEntries(['uOrigin', 'uScale', 'uShift', 'uPx', 'uZoom', 'uVals', 'uVoltage', 'uMono', 'uColor'].map(n => [n, gl.getUniformLocation(p, n)]));
    this.vao = gl.createVertexArray(); gl.bindVertexArray(this.vao);
    const quad = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
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

  _makeScene(data, styles, info) {
    const sc = {header: data.header, rects: data.rects, styles, info, ranges: data.header.layerRanges,
      blocks: (data.header.blocks || data.header.boxes).slice().sort((a, b) => a.d - b.d), groups: data.header.groups || [], cam: null};
    if (this.gl) { sc.buf = this.gl.createBuffer(); this.gl.bindBuffer(this.gl.ARRAY_BUFFER, sc.buf); this.gl.bufferData(this.gl.ARRAY_BUFFER, data.rects, this.gl.STATIC_DRAW); }
    return sc;
  }

  // the mask layout of a newly compiled circuit; drops the previous schematic
  setDie(die, info = '') {
    for (const sc of Object.values(this.scenes)) if (sc?.buf) this.gl.deleteBuffer(sc.buf);
    this.scenes = {mask: this._makeScene(die, LAYERS, info), schematic: null};
    this.nets = die.header.stats.nets;
    this.hover = null; this._schLoading = null;
    if (!this.gl) return;
    this._allocValues(this.nets);
    if (this.mode === 'schematic') this._ensureSchematic();
    this._showInfo();
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

  async _ensureSchematic() {
    if (this.scenes.schematic || this._schLoading || !this.loadSchematic || !this.scenes.mask) return;
    const mask = this.scenes.mask;
    this._schLoading = this.loadSchematic(msg => { if (this.mode === 'schematic') this.statusEl.textContent = msg; });
    try {
      const {die, info} = await this._schLoading;
      if (this.scenes.mask !== mask) return; // recompiled meanwhile
      if (die.header.stats.nets !== this.nets) throw new Error('cached schematic does not match the compiled circuit');
      this.scenes.schematic = this._makeScene(die, SCH_LAYERS, info);
      this._allocValues(this.nets + this.scenes.schematic.groups.length);
      if (this.mode === 'schematic') { this._showInfo(); this.fit(); }
    } catch (e) {
      this.statusEl.textContent = `schematic failed: ${e.message}`;
    } finally { this._schLoading = null; }
  }

  setMode(mode) {
    this.mode = mode; this.modeSel.value = mode;
    for (const e of this.maskOnly) e.hidden = mode !== 'mask';
    this.hover = null;
    if (mode === 'schematic' && !this.scenes.schematic) this._ensureSchematic();
    this._showInfo();
    if (this.scene && !this.scene.cam) this.fit(); else this.render();
  }

  _showInfo() { if (this.scene) this.statusEl.textContent = this.scene.info; else if (this.mode === 'schematic') this.statusEl.textContent = 'preparing schematic…'; }
  get scene() { return this.scenes[this.mode]; }
  get cam() { return this.scene?.cam || {x:0, y:0, z:1}; }
  _layerVisible(i) { return this.mode !== 'mask' || (this.solo >= 0 ? i === this.solo : this.visible[i]); }
  _name(id) { return id < this.nets ? this.getNetName(id) : this.scene.groups[id - this.nets]?.l ?? String(id); }
  _valueText(id) {
    if (!this.getValue) return '';
    return id < this.nets ? '01ZX'[this.getValue(id)] : busText(this.scene.groups[id - this.nets], this.getValue);
  }

  setValueSource(fn) { this.getValue = fn; this.render(); }

  fit() {
    const sc = this.scene;
    if (!sc) return;
    const [W, H] = sc.header.size;
    const cw = this.wrap.clientWidth || 800, ch = this.wrap.clientHeight || 600;
    sc.cam = {x: W / 2, y: H / 2, z: Math.min(cw / W, ch / H) * 0.96};
    this.render();
  }

  zoomToPath(path) {
    const sc = this.scene;
    if (!sc) return;
    let b = null;
    for (let p = path; p && !b; p = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '') b = sc.blocks.find(x => x.p === p);
    if (!b) return this.fit();
    const [x, y, w, h] = b.r;
    sc.cam = {x: x + w / 2, y: y + h / 2, z: Math.min(this.wrap.clientWidth / w, this.wrap.clientHeight / h) * 0.85};
    this.render();
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1, w = this.wrap.clientWidth, h = this.wrap.clientHeight;
    for (const c of [this.canvas, this.overlay]) { c.width = Math.max(1, Math.round(w * dpr)); c.height = Math.max(1, Math.round(h * dpr)); }
    if (this.scene && !this._fitted) { this._fitted = true; this.fit(); }
    this.render();
  }

  render() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this._draw(); });
  }

  _draw() {
    const gl = this.gl, sc = this.scene;
    const dpr = window.devicePixelRatio || 1, W = this.canvas.width, H = this.canvas.height;
    if (!gl || !W) return;
    const schem = this.mode !== 'mask', mono = !schem && this.solo >= 0;
    gl.viewport(0, 0, W, H);
    gl.clearColor(...(mono ? [0.93, 0.95, 0.96, 1] : [0.06, 0.07, 0.09, 1])); gl.clear(gl.COLOR_BUFFER_BIT);
    this.ctx.setTransform(1, 0, 0, 1, 0, 0); this.ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    if (!sc || !sc.cam) return;
    const cam = sc.cam, z = cam.z * dpr;
    if (this.getValue && this.voltage) {
      const n = this.nets, v = this.vals;
      for (let i = 0; i < n; i++) v[i] = this.getValue(i);
      sc.groups.forEach((b, i) => { if (n + i < v.length) v[n + i] = busValue(b, this.getValue); });
      gl.bindTexture(gl.TEXTURE_2D, this.valTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 1024, this.texH, gl.RED_INTEGER, gl.UNSIGNED_BYTE, v);
    }
    gl.useProgram(this.prog); gl.bindVertexArray(this.vao);
    const ox = Math.round(cam.x), oy = Math.round(cam.y);
    gl.uniform2i(this.u.uOrigin, ox, oy);
    gl.uniform2f(this.u.uShift, ox - cam.x, oy - cam.y);
    gl.uniform2f(this.u.uScale, 2 * z / W, -2 * z / H);
    gl.uniform2f(this.u.uPx, 1 / z, 1 / z);
    gl.uniform1f(this.u.uZoom, cam.z);
    gl.uniform1i(this.u.uVals, 0); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.valTex);
    gl.uniform1i(this.u.uVoltage, this.voltage && this.getValue ? 1 : 0);
    gl.uniform1i(this.u.uMono, mono ? 1 : 0);
    if (!mono && !schem) { // silicon substrate
      gl.bindBuffer(gl.ARRAY_BUFFER, this.bg); gl.bufferData(gl.ARRAY_BUFFER, new Int32Array([0, 0, sc.header.size[0], sc.header.size[1], 0, -1]), gl.DYNAMIC_DRAW);
      this._bindInstances(this.bg, 0);
      gl.uniform4f(this.u.uColor, 0.17, 0.19, 0.22, 1);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, 1);
    }
    sc.styles.forEach((l, i) => {
      if (!this._layerVisible(i)) return;
      const [first, count] = sc.ranges[i];
      if (!count) return;
      let c = hex(l.color, l.alpha);
      if (mono) c = [0.08, 0.09, 0.1, 1];
      else if (!schem && this.voltage && this.getValue && !l.conductive) c[3] *= 0.5;
      gl.uniform4f(this.u.uColor, ...c);
      this._bindInstances(sc.buf, first);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    });
    this._drawOverlay(dpr);
  }

  _toScreen(x, y) { const c = this.cam; return [(x - c.x) * c.z + this.wrap.clientWidth / 2, (y - c.y) * c.z + this.wrap.clientHeight / 2]; }
  _toWorld(sx, sy) { const c = this.cam; return [(sx - this.wrap.clientWidth / 2) / c.z + c.x, (sy - this.wrap.clientHeight / 2) / c.z + c.y]; }
  _onScreen(sx, sy, pad = 0) { return sx > -pad && sy > -pad && sx < this.wrap.clientWidth + pad && sy < this.wrap.clientHeight + pad; }

  _drawOverlay(dpr) {
    const ctx = this.ctx, sc = this.scene, {header} = sc, z = this.cam.z;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const schem = this.mode !== 'mask', mono = !schem && this.solo >= 0;
    ctx.font = '11px ui-monospace, monospace';
    if (schem) return this._drawSchematicLabels(ctx, sc);
    if (mono) { // die edge for orientation on a single mask plate
      const [sx, sy] = this._toScreen(0, 0);
      ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 1;
      ctx.strokeRect(sx, sy, header.size[0] * z, header.size[1] * z);
      ctx.fillStyle = '#333'; ctx.fillText(`mask ${this.solo + 1}/${LAYERS.length}: ${LAYERS[this.solo].label}`, 8, 16);
    }
    for (const p of header.pads) {
      const [sx, sy] = this._toScreen(p.r[0], p.r[1]), s = p.r[2] * z;
      if (s < 14) continue;
      ctx.fillStyle = mono ? '#333' : '#e8edf2';
      ctx.font = `${Math.min(12, Math.max(8, s * 0.24)) | 0}px ui-monospace, monospace`;
      ctx.fillText(p.l, sx + 2, sy + s / 2 + 4, s - 4);
    }
    ctx.font = '11px ui-monospace, monospace';
    if (this.showBlocks && !mono) {
      const placed = [];
      for (const b of sc.blocks) {
        const [sx, sy] = this._toScreen(b.r[0], b.r[1]), sw = b.r[2] * z, sh = b.r[3] * z;
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
    const sh = header.shorts || [];
    if (sh.length && this.showShorts) {
      ctx.strokeStyle = '#ff3df2'; ctx.lineWidth = 1.5;
      const rad = Math.max(3, 6 * z);
      for (let i = 0; i < sh.length; i += 2) {
        const [sx, sy] = this._toScreen(sh[i], sh[i + 1]);
        if (!this._onScreen(sx, sy, rad)) continue;
        ctx.beginPath(); ctx.arc(sx, sy, rad, 0, Math.PI * 2); ctx.stroke();
      }
    }
    this._drawHover(ctx);
  }

  _drawSchematicLabels(ctx, sc) {
    const {labels, texts} = sc.header, z = this.cam.z;
    for (let i = 0, k = 0; i < labels.length; i += 5, k++) {
      const size = labels[i + 2] * z;
      if (size < 6 || labels[i + 3] * z < LOD_PX) continue;
      const [sx, sy] = this._toScreen(labels[i], labels[i + 1]);
      if (!this._onScreen(sx, sy, 200)) continue;
      ctx.font = `${Math.min(18, size) | 0}px ui-monospace, monospace`;
      ctx.textAlign = ['left', 'right', 'center'][labels[i + 4]];
      ctx.fillStyle = size > 10 ? 'rgba(232,238,245,.95)' : 'rgba(205,215,228,.85)';
      ctx.fillText(texts[k], sx, sy);
    }
    ctx.textAlign = 'left';
    // bus names and values along their longest segment
    ctx.font = '11px ui-monospace, monospace';
    // longest visible segments first; a label is skipped if it would cover another one
    sc.byLength ||= sc.groups.filter(b => b.seg).sort((a, b) => b.seg[2] - a.seg[2]);
    const placed = [];
    for (const b of sc.byLength) {
      if (b.seg[2] * z < 110 || b.seg[3] * z < LOD_PX) continue;
      const [sx, sy] = this._toScreen(b.seg[0], b.seg[1]);
      if (!this._onScreen(sx, sy)) continue;
      const t = `${b.l.split(/[./]/).pop()}${this.getValue ? ' = ' + busText(b, this.getValue) : ''}`;
      const w = ctx.measureText(t).width + 6, x0 = sx - w / 2, y0 = sy - 8;
      if (placed.some(q => x0 < q[0] + q[2] + 4 && q[0] < x0 + w + 4 && y0 < q[1] + 19 && q[1] < y0 + 19)) continue;
      placed.push([x0, y0, w]);
      if (placed.length > 120) break;
      ctx.fillStyle = 'rgba(10,14,18,.8)'; ctx.fillRect(x0, y0, w, 15);
      ctx.fillStyle = '#ffe9b0'; ctx.fillText(t, x0 + 3, sy + 4);
    }
    this._drawHover(ctx);
  }

  _drawHover(ctx) {
    if (this.hover?.net == null) return;
    const idx = this._netRects(this.hover.net), r = this.scene.rects, z = this.cam.z;
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1;
    for (let k = 0; k < idx.length && k < 20000; k++) {
      const o = idx[k] * 6;
      if (lodSize(r[o + 4]) * z < LOD_PX) continue;
      const [sx, sy] = this._toScreen(r[o], r[o + 1]);
      ctx.strokeRect(sx - 0.5, sy - 0.5, Math.max(1, r[o + 2] * z) + 1, Math.max(1, r[o + 3] * z) + 1);
    }
  }

  // per-net rect lists, built on demand
  _netRects(net) {
    const sc = this.scene;
    if (!sc.netIndex) {
      const r = sc.rects, n = r.length / 6, nets = this.nets + sc.groups.length;
      const start = new Int32Array(nets + 1);
      for (let i = 0; i < n; i++) { const t = r[i * 6 + 5]; if (t >= 2 && t < nets) start[t + 1]++; }
      for (let i = 0; i < nets; i++) start[i + 1] += start[i];
      const list = new Int32Array(start[nets]), fillp = start.slice();
      for (let i = 0; i < n; i++) { const t = r[i * 6 + 5]; if (t >= 2 && t < nets) list[fillp[t]++] = i; }
      sc.netIndex = {start, list};
    }
    const {start, list} = sc.netIndex;
    return net >= 2 && net + 1 < start.length ? list.subarray(start[net], start[net + 1]) : new Int32Array(0);
  }

  // uniform bucket grid over conductive rects for picking
  _pick(wx, wy) {
    const sc = this.scene, r = sc.rects, [W, H] = sc.header.size;
    if (!sc.bucket) {
      const n = r.length / 6, B = Math.max(64, Math.ceil(Math.max(W, H) / 1024)), bw = Math.ceil(W / B) + 1, bh = Math.ceil(H / B) + 1;
      const cnt = new Int32Array(bw * bh + 1);
      const each = fn => { for (let i = 0; i < n; i++) { const o = i * 6; if (r[o + 5] < 0 || !sc.styles[r[o + 4] & 255].conductive) continue;
        const x0 = Math.max(0, Math.floor(r[o] / B)), x1 = Math.min(bw - 1, Math.floor((r[o] + r[o + 2]) / B)), y0 = Math.max(0, Math.floor(r[o + 1] / B)), y1 = Math.min(bh - 1, Math.floor((r[o + 1] + r[o + 3]) / B));
        if ((x1 - x0 + 1) * (y1 - y0 + 1) > 4096) continue;
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) fn(y * bw + x, i); } };
      each(b => cnt[b + 1]++);
      for (let i = 0; i < bw * bh; i++) cnt[i + 1] += cnt[i];
      const list = new Int32Array(cnt[bw * bh]), fp = cnt.slice();
      each((b, i) => { list[fp[b]++] = i; });
      sc.bucket = {B, bw, bh, cnt, list};
    }
    const {B, bw, bh, cnt, list} = sc.bucket, bx = Math.floor(wx / B), by = Math.floor(wy / B);
    if (bx < 0 || by < 0 || bx >= bw || by >= bh) return null;
    const z = this.cam.z, tol = 2 / z;
    let best = null, bestL = -1;
    for (let k = cnt[by * bw + bx]; k < cnt[by * bw + bx + 1]; k++) {
      const o = list[k] * 6, layer = r[o + 4] & 255;
      if (!this._layerVisible(layer) || lodSize(r[o + 4]) * z < LOD_PX) continue;
      if (wx >= r[o] - tol && wx <= r[o] + r[o + 2] + tol && wy >= r[o + 1] - tol && wy <= r[o + 1] + r[o + 3] + tol && layer > bestL) { bestL = layer; best = r[o + 5]; }
    }
    return best;
  }

  _blockAt(wx, wy) {
    let best = null;
    const z = this.cam.z;
    for (const b of this.scene.blocks) {
      if (!(wx >= b.r[0] && wy >= b.r[1] && wx < b.r[0] + b.r[2] && wy < b.r[1] + b.r[3])) continue;
      if (this.mode !== 'mask' && Math.max(b.r[2], b.r[3]) * z < 12) continue;
      if (!best || b.d > best.d) best = b;
    }
    return best;
  }

  _bindEvents() {
    const c = this.overlay;
    let drag = null;
    c.addEventListener('wheel', e => {
      e.preventDefault();
      if (!this.scene?.cam) return;
      const rect = c.getBoundingClientRect(), sx = e.clientX - rect.left, sy = e.clientY - rect.top;
      const [wx, wy] = this._toWorld(sx, sy);
      this.scene.cam.z *= Math.exp(-e.deltaY * 0.0015);
      const [nx, ny] = this._toWorld(sx, sy);
      this.scene.cam.x += wx - nx; this.scene.cam.y += wy - ny;
      this.render();
    }, {passive:false});
    c.addEventListener('pointerdown', e => { if (!this.scene?.cam) return; drag = {x:e.clientX, y:e.clientY, cx:this.cam.x, cy:this.cam.y, moved:false}; c.setPointerCapture(e.pointerId); });
    c.addEventListener('pointermove', e => {
      const rect = c.getBoundingClientRect();
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
        if (drag.moved) { this.scene.cam.x = drag.cx - dx / this.cam.z; this.scene.cam.y = drag.cy - dy / this.cam.z; this.render(); return; }
      }
      if (!this.scene?.cam) return;
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
      if (drag && !drag.moved && this.scene) {
        const rect = c.getBoundingClientRect();
        const net = this._pick(...this._toWorld(e.clientX - rect.left, e.clientY - rect.top));
        if (net != null && net >= this.nets) for (const b of this.scene.groups[net - this.nets].bits) this.onProbe(b);
        else if (net != null && net >= 2) this.onProbe(net);
      }
      drag = null;
    });
    c.addEventListener('dblclick', e => {
      if (!this.scene?.cam) return;
      const rect = c.getBoundingClientRect();
      const b = this._blockAt(...this._toWorld(e.clientX - rect.left, e.clientY - rect.top));
      if (b) this.zoomToPath(b.p);
    });
  }
}
