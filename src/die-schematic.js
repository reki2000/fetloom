// Schematic rendering of a die layout: same placement as the masks, but transistors are
// drawn as MOS symbols and wires as centre lines.  The bits of one bus (same local
// name, different index) are drawn as a single thick line that follows the route of
// its lowest routed bit; the other bits are left out.  Each bus gets a virtual net id
// (nets + i) whose value is the aggregate of its bits.

import {L, FLAG_NCH, FLAG_PCH} from './die.js';

export const SCH_LAYERS = [
  {name:'block',  label:'Block',  color:'#1a2430', alpha:.95, conductive:false},
  {name:'pad',    label:'Pad',    color:'#6b7a8a', alpha:.9,  conductive:true},
  {name:'wire',   label:'Wire',   color:'#7f93a8', alpha:.95, conductive:true},
  {name:'bus',    label:'Bus',    color:'#b8c7d6', alpha:.95, conductive:true},
  {name:'device', label:'Device', color:'#d7e0e8', alpha:1,   conductive:true},
  {name:'bubble', label:'Bubble', color:'#0e1318', alpha:1,   conductive:false},
];
const S = Object.fromEntries(SCH_LAYERS.map((l, i) => [l.name, i]));
const WIRE = 4; // routed wire width in the mask data

export function buildSchematic(die, netMeta) {
  const {header, rects} = die, nets = header.stats.nets;
  const byLayer = SCH_LAYERS.map(() => []);
  const R = (x, y, w, h, layer, net = -1, flags = 0) => byLayer[layer].push(x, y, w, h, layer | (flags << 8), net);
  const range = l => { const [f, c] = header.layerRanges[l]; return [f, f + c]; };

  // wire centre lines, grouped by net
  const segs = new Map();
  for (const l of [L.metal1, L.metal2]) {
    const [a, b] = range(l);
    for (let i = a; i < b; i++) {
      const o = i * 6, net = rects[o + 5], w = rects[o + 2], h = rects[o + 3];
      if (net < 2 || Math.min(w, h) !== WIRE || Math.max(w, h) <= WIRE) continue;
      let s = segs.get(net); if (!s) segs.set(net, s = []);
      s.push(rects[o], rects[o + 1], w, h);
    }
  }

  // buses: bits sharing module path + local name
  const groups = new Map();
  for (const net of segs.keys()) {
    const m = netMeta[net];
    if (!m || m.index == null || !m.local) continue;
    const key = `${m.modulePath}.${m.local}`;
    let g = groups.get(key); if (!g) groups.set(key, g = []);
    g.push(net);
  }
  const buses = [], busOf = new Map();
  for (const [key, bits] of groups) {
    if (bits.length < 2) continue;
    bits.sort((p, q) => netMeta[p].index - netMeta[q].index);
    const all = []; // every bit of the bus, routed or not, for the value
    const width = netMeta[bits[0]].width || bits.length;
    for (let i = 0; i < nets && all.length < width; i++) { const m = netMeta[i]; if (m && m.local === netMeta[bits[0]].local && m.modulePath === netMeta[bits[0]].modulePath && m.index != null) all.push(i); }
    all.sort((p, q) => netMeta[p].index - netMeta[q].index);
    const bus = {id: nets + buses.length, key, label: `${key}[${all.length}]`, bits: all, rep: bits[0], seg: null};
    buses.push(bus);
    for (const n of bits) busOf.set(n, bus);
  }

  for (const [net, s] of segs) {
    const bus = busOf.get(net);
    if (bus && bus.rep !== net) continue;
    const t = bus ? Math.min(28, 4 + 3 * bus.bits.length) : 2;
    for (let k = 0; k < s.length; k += 4) {
      const [x, y, w, h] = [s[k], s[k + 1], s[k + 2], s[k + 3]];
      const cx = x + WIRE / 2, cy = y + WIRE / 2; // centre line start
      if (w > h) R(cx - t / 2, cy - t / 2, w - WIRE + t, t, bus ? S.bus : S.wire, bus ? bus.id : net);
      else R(cx - t / 2, cy - t / 2, t, h - WIRE + t, bus ? S.bus : S.wire, bus ? bus.id : net);
      if (bus && (!bus.seg || Math.max(w, h) > bus.seg[2])) bus.seg = w > h ? [cx + w / 2, cy, w] : [cx, cy + h / 2, h];
    }
  }

  // hard blocks, memories and pads
  for (const b of header.blocks) if (b.h) R(...b.r, S.block);
  for (const p of header.pads) R(...p.r, S.pad, p.n);

  // devices, recovered from the mask geometry
  const at = new Map();
  for (const l of [L.active, L.poly]) {
    const [a, b] = range(l);
    for (let i = a; i < b; i++) { const o = i * 6; at.set(`${l}:${rects[o]},${rects[o + 1]},${rects[o + 2]},${rects[o + 3]}`, rects[o + 5]); }
  }
  const get = (l, x, y, w, h) => at.get(`${l}:${x},${y},${w},${h}`);
  {
    const [a, b] = range(L.active);
    for (let i = a; i < b; i++) {
      const o = i * 6, flags = rects[o + 4] >> 8;
      if (flags !== FLAG_NCH && flags !== FLAG_PCH) continue;
      const X = rects[o] - 10, Y = rects[o + 1] - 6, g = rects[o + 5];
      const na = get(L.active, X + 1, Y + 6, 9, 12), nb = get(L.active, X + 14, Y + 6, 9, 12);
      const bottom = get(L.poly, X + 9, Y + 17, 6, 6) != null && get(L.poly, X + 9, Y + 1, 6, 6) == null;
      // symbol drawn for a top gate pin, mirrored vertically for a bottom one
      const D = (x, y, w, h, layer, net, fl = 0) => R(X + x, bottom ? Y + 24 - y - h : Y + y, w, h, layer, net, fl);
      const pch = flags === FLAG_PCH;
      D(11, 2, 2, pch ? 3 : 6, S.device, g);
      if (pch) { D(10, 5, 4, 3, S.device, g); D(11, 6, 2, 1, S.bubble); }
      D(5, 8, 14, 2, S.device, g);
      D(5, 11, 14, 2, S.device, g, flags);
      D(3, 11, 3, 2, S.device, na ?? -1);
      D(18, 11, 4, 2, S.device, nb ?? -1);
      D(5, 11, 2, 5, S.device, na ?? -1);
      D(17, 11, 2, 5, S.device, nb ?? -1);
    }
  }
  {
    const [a, b] = range(L.poly);
    for (let i = a; i < b; i++) {
      const o = i * 6, x = rects[o], y = rects[o + 1], w = rects[o + 2], h = rects[o + 3], net = rects[o + 5];
      if (w === 20 && h === 20) { R(x + 2, y + 7, 16, 2, S.device, net); R(x + 2, y + 11, 16, 2, S.device, 1); R(x + 9, y + 13, 2, 5, S.device, 1); } // capacitor
      else if (w === 20 && h === 3) { R(x + 1, y + 1, 18, 2, S.device, net); R(x + 1, y + 17, 18, 2, S.device, net); R(x + 1, y + 1, 2, 18, S.device, net); R(x + 17, y + 1, 2, 18, S.device, net); } // clock source
    }
  }
  // supply taps
  {
    const [a, b] = range(L.via2);
    for (let i = a; i < b; i++) { const o = i * 6, net = rects[o + 5]; if (net === 0 || net === 1) R(rects[o] - 3, rects[o + 1] + (net ? 3 : -1), 10, 2, S.device, net); }
  }

  let total = 0;
  for (const a of byLayer) total += a.length;
  const out = new Int32Array(total), layerRanges = [];
  let off = 0;
  byLayer.forEach(a => { layerRanges.push([off / 6, a.length / 6]); out.set(a, off); off += a.length; });
  return {rects: out, layerRanges, buses};
}

// aggregate value of a bus: 0/1 if all bits agree, 3 if any X, 2 if all Z, else 4 (mixed)
export function busValue(bus, getValue) {
  let seen = 0;
  for (const n of bus.bits) { const v = getValue(n); if (v === 3) return 3; seen |= 1 << v; }
  return seen === 1 ? 0 : seen === 2 ? 1 : seen === 4 ? 2 : 4;
}

export function busText(bus, getValue) {
  const v = bus.bits.map(getValue);
  if (v.every(x => x <= 1)) return '0x' + v.reduce((s, x, i) => s + (x << i), 0).toString(16).toUpperCase();
  return v.map(x => '01ZX'[x]).reverse().join('');
}
