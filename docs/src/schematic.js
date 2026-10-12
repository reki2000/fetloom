// Readable schematic layout, independent of the die floorplan.
//
// Every module is a box with its inputs on the left edge and outputs on the right edge.
// Children are placed in signal-flow columns (longest path from the inputs, feedback
// edges ignored), ordered by barycentre to reduce crossings; tall columns are split and
// very wide drawings are folded into bands so each box is filled evenly in two
// dimensions.  Modules made only of transistors use the textbook CMOS arrangement
// (PMOS row above NMOS row, aligned by gate).  Wires are routed per module on a grid
// (horizontal and vertical tracks may cross, but not overlap); nets that connect exactly
// the same set of pins are drawn as one thick line.  Geometry carries a level-of-detail
// size so the viewer hides the inside of boxes that are too small on screen.
//
// Output: {header, rects} in the same container format as the die layout.

import {DIE_VERSION} from './die.js';

export const SCH_VERSION = 4;
export const U = 8; // world units per grid cell

export const SCH_LAYERS = [
  {name:'box',    label:'Module',  color:'#16202a', alpha:.92, conductive:false},
  {name:'frame',  label:'Frame',   color:'#5f7488', alpha:1,   conductive:false},
  {name:'wire',   label:'Wire',    color:'#8da2b6', alpha:1,   conductive:true},
  {name:'bus',    label:'Bus',     color:'#c3d1de', alpha:1,   conductive:true},
  {name:'pin',    label:'Pin',     color:'#e0e7ee', alpha:1,   conductive:true},
  {name:'device', label:'Device',  color:'#dfe7ee', alpha:1,   conductive:true},
  {name:'bubble', label:'Bubble',  color:'#0e1318', alpha:1,   conductive:false},
];
const S = Object.fromEntries(SCH_LAYERS.map((l, i) => [l.name, i]));
export const FLAG_NCH = 1, FLAG_PCH = 2;

function cyrb53(str, seed) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) { const ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}
export function schematicKey(source, top) {
  const s = `fetloom-sch/${SCH_VERSION}/${DIE_VERSION}\n${top}\n${source.replace(/\r\n?/g, '\n')}`;
  return cyrb53(s, 3) + cyrb53(s, 4);
}

const isPower = n => n === 0 || n === 1;
const CHAR = 0.75; // label character width in cells

// ---------------------------------------------------------------- tree

function buildTree(circuit) {
  const top = circuit.topName;
  const root = {kind:'module', name:top, path:top, children:[],
    ports:[...circuit.topInputs.map(p => ({name:p.name, dir:'in', nets:p.nets})), ...circuit.topOutputs.map(p => ({name:p.name, dir:'out', nets:p.nets}))]};
  const byPath = new Map([[top, root]]);
  for (const h of circuit.hierarchy) {
    const parent = byPath.get(h.parentPath);
    if (!parent) continue;
    let node;
    if (h.type === 'module') node = {kind:'module', name:h.moduleName, children:[], ports: h.ports || [{name:'in', dir:'in', nets:h.inputs}, {name:'out', dir:'out', nets:h.outputs}]};
    else if (h.type === 'Nmos' || h.type === 'Pmos') node = {kind:h.type === 'Nmos' ? 'nmos' : 'pmos', g:h.nets[0], a:h.nets[1], b:h.nets[2]};
    else if (h.type === 'Cap') node = {kind:'cap', net:h.nets[0]};
    else if (h.type === 'Clk') node = {kind:'clk', net:h.nets[0], name:h.label};
    else if (h.type === 'Rom') node = {kind:'mem', name:h.label, children:[], ports:[{name:'addr', dir:'in', nets:h.inputs}, {name:'data', dir:'out', nets:h.outputs}]};
    else if (h.type === 'Ram') {
      const k = h.outputs.length, n = h.nets, al = n.length - 2 * k - 2;
      node = {kind:'mem', name:'RAM', children:[], ports:[{name:'addr', dir:'in', nets:n.slice(0, al)}, {name:'din', dir:'in', nets:n.slice(al, al + k)},
        {name:'we', dir:'in', nets:[n[al + 2 * k]]}, {name:'clk', dir:'in', nets:[n[al + 2 * k + 1]]}, {name:'dout', dir:'out', nets:n.slice(al + k, al + 2 * k)}]};
    } else continue;
    node.path = h.path; node.parent = parent;
    parent.children.push(node); byPath.set(h.path, node);
  }
  return root;
}

// pins of a node in its own coordinates: {x, y, nets, name, out:[dx,dy]}
function leafShape(n) {
  switch (n.kind) {
    case 'nmos': case 'pmos':
      n.w = 4; n.h = 5;
      n.pins = [{x:0, y:2, nets:[n.g], name:'g', out:[-1, 0]}, {x:2, y:0, nets:[n.a], name:'a', out:[0, -1]}, {x:2, y:4, nets:[n.b], name:'b', out:[0, 1]}];
      return;
    case 'cap': n.w = 3; n.h = 4; n.pins = [{x:1, y:0, nets:[n.net], name:'c', out:[0, -1]}]; return;
    case 'clk': n.w = 5; n.h = 3; n.pins = [{x:4, y:1, nets:[n.net], name:'clk', out:[1, 0]}]; return;
  }
}

const inNets = c => c.kind === 'nmos' || c.kind === 'pmos' ? [c.g] : c.kind === 'cap' ? [c.net] : c.kind === 'clk' ? [] : c.ports.filter(p => p.dir === 'in').flatMap(p => p.nets);
const outNets = c => c.kind === 'nmos' || c.kind === 'pmos' ? [c.a, c.b] : c.kind === 'cap' ? [] : c.kind === 'clk' ? [c.net] : c.ports.filter(p => p.dir === 'out').flatMap(p => p.nets);

// ---------------------------------------------------------------- placement

function placeCmos(m) {
  const order = new Map();
  m.children.forEach(c => { const g = c.g ?? c.net; if (!order.has(g)) order.set(g, order.size); });
  const key = c => order.get(c.g ?? c.net);
  const P = m.children.filter(c => c.kind === 'pmos').sort((a, b) => key(a) - key(b));
  const N = m.children.filter(c => c.kind !== 'pmos').sort((a, b) => key(a) - key(b));
  const pitch = Math.round(8 * (m.spread || 1)), cols = Math.max(P.length, N.length);
  // align N and P sharing a gate column when possible
  P.forEach((c, i) => { c.x = i * pitch; c.y = 0; });
  N.forEach((c, i) => { c.x = i * pitch; c.y = P.length ? 10 : 0; });
  return {w: (cols - 1) * pitch + 5, h: (P.length && N.length ? 10 : 0) + 5};
}

function placeLayered(m) {
  const ch = m.children, n = ch.length;
  const ins = ch.map(c => new Set(inNets(c).filter(x => !isPower(x))));
  const drivers = new Map();
  ch.forEach((c, i) => outNets(c).forEach(x => { if (isPower(x)) return; let a = drivers.get(x); if (!a) drivers.set(x, a = []); a.push(i); }));
  const succ = ch.map(() => new Set()), pred = ch.map(() => new Set());
  ins.forEach((s, v) => s.forEach(x => (drivers.get(x) || []).forEach(u => { if (u !== v) { succ[u].add(v); pred[v].add(u); } })));
  // drop feedback edges (DFS back edges) and take the longest path from the sources
  const state = new Uint8Array(n), order = [], dag = ch.map(() => []);
  for (let s = 0; s < n; s++) {
    if (state[s]) continue;
    const stack = [[s, [...succ[s]], 0]]; state[s] = 1;
    while (stack.length) {
      const top = stack[stack.length - 1];
      if (top[2] < top[1].length) {
        const v = top[1][top[2]++];
        if (state[v] === 0) { dag[top[0]].push(v); state[v] = 1; stack.push([v, [...succ[v]], 0]); }
        else if (state[v] === 2) dag[top[0]].push(v);
      } else { state[top[0]] = 2; order.push(top[0]); stack.pop(); }
    }
  }
  const level = new Int32Array(n);
  for (let k = order.length - 1; k >= 0; k--) { const u = order[k]; for (const v of dag[u]) level[v] = Math.max(level[v], level[u] + 1); }
  // nodes without predecessors but feeding only late levels move right next to their consumers
  for (let u = 0; u < n; u++) if (!pred[u].size && dag[u].length) level[u] = Math.max(level[u], Math.min(...dag[u].map(v => level[v])) - 1);
  let cols = [];
  for (let i = 0; i < n; i++) (cols[level[i]] ||= []).push(i);
  cols = cols.filter(Boolean);
  // barycentre ordering, a few sweeps
  const pos = new Float64Array(n);
  const setPos = () => cols.forEach(c => c.forEach((v, k) => { pos[v] = k / Math.max(1, c.length - 1); }));
  setPos();
  for (let sweep = 0; sweep < 4; sweep++) {
    const fwd = sweep % 2 === 0;
    for (const c of fwd ? cols : cols.slice().reverse()) {
      const nb = v => [...(fwd ? pred[v] : succ[v])];
      const bc = v => { const a = nb(v); return a.length ? a.reduce((s, u) => s + pos[u], 0) / a.length : pos[v]; };
      const keyed = c.map(v => [bc(v), v]).sort((p, q) => p[0] - q[0] || p[1] - q[1]);
      c.splice(0, c.length, ...keyed.map(k => k[1]));
      c.forEach((v, k) => { pos[v] = k / Math.max(1, c.length - 1); });
    }
  }
  // spacing grows with the number of nets that have to pass between the columns
  const netCount = new Set(ch.flatMap(c => [...inNets(c), ...outNets(c)].filter(x => !isPower(x)))).size;
  const sp = m.spread || 1;
  const gy = Math.round(3 * sp), gx = Math.round((4 + Math.min(14, Math.ceil(netCount / Math.max(2, cols.length) / 3))) * sp);
  let area = 0;
  for (const c of ch) area += (c.cw + gx) * (c.ch + gy);
  const side = Math.sqrt(area);
  // split tall columns
  const split = [];
  for (const c of cols) {
    const hgt = c.reduce((s, v) => s + ch[v].ch + gy, 0);
    const k = Math.max(1, Math.round(hgt / (side * 1.15)));
    if (k === 1) { split.push(c); continue; }
    let cur = [], acc = 0;
    for (const v of c) { cur.push(v); acc += ch[v].ch + gy; if (acc >= hgt / k && split.length < 1e6) { split.push(cur); cur = []; acc = 0; } }
    if (cur.length) split.push(cur);
  }
  const colW = split.map(c => Math.max(...c.map(v => ch[v].cw)));
  // extra tracks in front of a column for the wires entering its pins, behind it for the ones leaving
  // (pins may end up on either side once the children are mirrored, so reserve on both)
  const pinsOf = (c, horiz) => Math.max(0, ...c.map(v => ch[v].ppins.filter(p => (p.out[1] === 0) === horiz).length));
  const gapBefore = split.map(c => Math.ceil(pinsOf(c, true) * 0.6 * sp));
  const gapAfter = gapBefore;
  const colGy = split.map(c => gy + Math.ceil(pinsOf(c, false) * 0.6 * sp));
  const colH = split.map((c, i) => c.reduce((s, v) => s + ch[v].ch, 0) + colGy[i] * (c.length - 1));
  // fold very wide drawings into bands
  const span = i => gapBefore[i] + colW[i] + gapAfter[i] + gx;
  const totalW = split.reduce((s, c, i) => s + span(i), 0) - gx, maxH = Math.max(...colH);
  const bands = split.length > 2 && totalW > 2.2 * maxH ? Math.max(1, Math.round(Math.sqrt(totalW / maxH))) : 1;
  const bandCols = [];
  { let b = [], acc = 0; const target = totalW / bands;
    split.forEach((c, i) => { b.push(i); acc += span(i); if (acc >= target && bandCols.length < bands - 1) { bandCols.push(b); b = []; acc = 0; } });
    if (b.length) bandCols.push(b); }
  let y = 0, W = 0;
  const bandGap = gx;
  for (const b of bandCols) {
    const bh = Math.max(...b.map(i => colH[i]));
    let x = 0;
    for (const i of b) {
      const c = split[i];
      // distribute the free height evenly between the items of the column
      const free = bh - colH[i], step = free / (c.length + 1);
      let cy = y + step;
      x += gapBefore[i];
      for (const v of c) { const it = ch[v]; it.x = Math.round(x + (colW[i] - it.cw) / 2); it.y = Math.round(cy); cy += it.ch + colGy[i] + step; }
      x += colW[i] + gapAfter[i] + gx;
    }
    W = Math.max(W, x - gx);
    y += bh + bandGap;
  }
  return {w: W, h: y - bandGap};
}

// ---------------------------------------------------------------- routing

function routeModule(m) {
  const W = m.w, H = m.h, G = W * H;
  const blocked = new Uint8Array(G), owner = new Int32Array(G).fill(-1);
  const pins = []; // {cell, stub, nets, kid}
  const cell = (x, y) => y * W + x;
  for (const c of m.children) for (let y = c.y; y < c.y + c.ch; y++) blocked.fill(1, cell(c.x, y), cell(c.x + c.cw, y));
  const addPin = (x, y, nets, out, node) => {
    const id = pins.length, c = cell(x, y), sx = x + out[0], sy = y + out[1];
    const stub = sx >= 0 && sy >= 0 && sx < W && sy < H ? cell(sx, sy) : -1;
    pins.push({id, cell:c, stub, nets, node, x, y});
    owner[c] = id; if (stub >= 0 && owner[stub] < 0) owner[stub] = id;
    return id;
  };
  for (const c of m.children) for (const p of c.ppins) p.local = addPin(c.x + p.x, c.y + p.y, p.nets, p.out, c);
  for (const p of m.pins) p.inner = addPin(p.x, p.y, p.nets, [-p.out[0], -p.out[1]], m);
  // group nets by the exact set of pins they touch
  const touch = new Map();
  for (const p of pins) for (const n of p.nets) { if (isPower(n)) continue; let a = touch.get(n); if (!a) touch.set(n, a = new Set()); a.add(p.id); }
  const groups = new Map();
  for (const [n, set] of touch) {
    if (set.size < 2) continue;
    const ids = [...set].sort((a, b) => a - b), key = ids.join(',');
    let g = groups.get(key); if (!g) groups.set(key, g = {pins:ids, nets:[]});
    g.nets.push(n);
  }
  const list = [...groups.values()];
  list.forEach((g, i) => { g.idx = i; g.pinSet = new Set(g.pins); });
  // wires that share a pin may run together (a bus fanning out); others must not overlap
  const shares = (a, b) => { for (const p of a.pins) if (b.pinSet.has(p)) return true; return false; };
  const NS = G * 2;
  const usage = new Uint8Array(NS), occ = new Int32Array(NS).fill(-1), hist = new Float32Array(NS);
  const gS = new Float32Array(NS), par = new Int32Array(NS), seen = new Int32Array(NS), closed = new Int32Array(NS);
  const tgt = new Int32Array(G).fill(-1);
  let sid = 0, hS = new Int32Array(1024), hF = new Float32Array(1024), hn = 0;
  const hpush = (f, st) => {
    if (hn >= hS.length) { const a2 = new Int32Array(hS.length * 2), b2 = new Float32Array(hS.length * 2); a2.set(hS); b2.set(hF); hS = a2; hF = b2; }
    let i = hn++;
    while (i > 0) { const q = (i - 1) >> 1; if (hF[q] <= f) break; hS[i] = hS[q]; hF[i] = hF[q]; i = q; }
    hS[i] = st; hF[i] = f;
  };
  const hpop = () => {
    const top = hS[0], ls = hS[--hn], lf = hF[hn];
    let i = 0;
    for (;;) { let c = 2 * i + 1; if (c >= hn) break; if (c + 1 < hn && hF[c + 1] < hF[c]) c++; if (hF[c] >= lf) break; hS[i] = hS[c]; hF[i] = hF[c]; i = c; }
    hS[i] = ls; hF[i] = lf;
    return top;
  };

  function route(g, pres) {
    const ok = c => owner[c] >= 0 ? g.pinSet.has(owner[c]) : !blocked[c];
    const cost = st => !usage[st] ? hist[st] : (shares(g, list[occ[st]]) ? 0.3 : pres * usage[st]) + hist[st];
    g.inc = [];
    const terms = g.pins.map(id => pins[id]);
    const done = new Uint8Array(terms.length);
    terms.forEach((t, i) => { tgt[t.cell] = i; });
    const tree = new Set([terms[0].cell * 2, terms[0].cell * 2 + 1]);
    done[0] = 1;
    const paths = [];
    for (let left = terms.length - 1; left > 0; left--) {
      let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
      terms.forEach((t, i) => { if (!done[i]) { bx0 = Math.min(bx0, t.x); bx1 = Math.max(bx1, t.x); by0 = Math.min(by0, t.y); by1 = Math.max(by1, t.y); } });
      const h = c => { const x = c % W, y = (c / W) | 0; return (Math.max(0, bx0 - x, x - bx1) + Math.max(0, by0 - y, y - by1)) * 1.15; };
      sid++; hn = 0;
      for (const st of tree) { seen[st] = sid; gS[st] = 0; par[st] = -1; hpush(h(st >> 1), st); }
      let end = -1;
      while (hn) {
        const st = hpop();
        if (closed[st] === sid) continue;
        closed[st] = sid;
        const c = st >> 1, layer = st & 1;
        if (tgt[c] >= 0 && !done[tgt[c]]) { end = st; break; }
        const g0 = gS[st];
        const o = st ^ 1;
        if (closed[o] !== sid) { const ng = g0 + 2 + cost(o); if (seen[o] !== sid || ng < gS[o]) { seen[o] = sid; gS[o] = ng; par[o] = st; hpush(ng + h(c), o); } }
        const x = c % W, y = (c / W) | 0;
        for (let d = -1; d <= 1; d += 2) {
          const nx = layer ? x : x + d, ny = layer ? y + d : y;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const nc = ny * W + nx;
          if (!ok(nc)) continue;
          const ns = nc * 2 + layer;
          if (closed[ns] === sid) continue;
          const ng = g0 + 1 + cost(ns);
          if (seen[ns] !== sid || ng < gS[ns]) { seen[ns] = sid; gS[ns] = ng; par[ns] = st; hpush(ng + h(nc), ns); }
        }
      }
      if (end < 0) break;
      const p = [];
      for (let st = end; st >= 0; st = par[st]) { p.push(st); if (tree.has(st) && st !== end) break; }
      done[tgt[end >> 1]] = 1;
      for (const st of p) { if (!tree.has(st) && owner[st >> 1] < 0) { usage[st]++; occ[st] = g.idx; g.inc.push(st); } tree.add(st); }
      paths.push(p.reverse());
    }
    terms.forEach(t => { tgt[t.cell] = -1; });
    g.paths = paths;
  }
  // a state is in conflict if two groups without a common pin use it
  const conflicts = () => {
    const users = new Map();
    for (const g of list) for (const st of g.inc) { let a = users.get(st); if (!a) users.set(st, a = []); a.push(g); }
    const bad = new Set(), cells = [];
    for (const [st, a] of users) {
      if (a.length < 2) continue;
      let clash = false;
      for (let i = 0; i < a.length && !clash; i++) for (let j = i + 1; j < a.length; j++) if (!shares(a[i], a[j])) { clash = true; break; }
      if (clash) { cells.push(st); for (const g of a) bad.add(g); }
    }
    return {bad: [...bad], cells};
  };
  const rip = g => { for (const st of g.inc) usage[st]--; };
  list.sort((a, b) => a.pins.length - b.pins.length || b.nets.length - a.nets.length);
  for (const g of list) route(g, 8);
  let res = conflicts();
  for (let it = 0, best = Infinity, stall = 0; it < 10 && res.bad.length; it++) {
    if (res.cells.length < best * 0.9) { best = res.cells.length; stall = 0; } else if (++stall >= 2) break;
    for (const st of res.cells) hist[st] += 3;
    for (const g of res.bad) { rip(g); route(g, 16 << Math.min(it, 4)); }
    res = conflicts();
  }
  m.conflicts = res.cells.length;
  m.groups = list;
}

// ---------------------------------------------------------------- layout

const SMIN = 0.45; // smallest scale of a child box relative to its parent's grid
const isBox = c => c.kind === 'module' || c.kind === 'mem';
const sideOf = out => out[0] < 0 ? 'L' : out[0] > 0 ? 'R' : out[1] < 0 ? 'T' : 'B';

// footprint of a laid-out node inside its parent: boxes shrink to what their pins need
function footprint(c) {
  c.fx = c.fy = false;
  if (!isBox(c)) { c.s = 1; c.cw = c.w; c.ch = c.h; c.ppins = c.ppins0 = c.pins; return; }
  const n = side => c.pins.filter(p => p.side === side).length;
  const minH = 3 * Math.max(n('L'), n('R')) + 5, minW = Math.max(14, Math.ceil(c.name.length * 1.1) + 6, 3 * Math.max(n('T'), n('B')) + 6);
  c.s = Math.min(1, Math.max(minH / c.h, minW / c.w, SMIN));
  c.cw = Math.max(3, Math.ceil(c.w * c.s)); c.ch = Math.max(3, Math.ceil(c.h * c.s));
  const used = new Set(), scale = v => Math.round((v + 0.5) * c.s - 0.5);
  c.ppins = c.ppins0 = c.pins.map(p => {
    const vert = p.side === 'L' || p.side === 'R';
    let x = vert ? (p.side === 'L' ? 0 : c.cw - 1) : Math.min(c.cw - 2, Math.max(1, scale(p.x)));
    let y = vert ? Math.min(c.ch - 2, Math.max(1, scale(p.y))) : (p.side === 'T' ? 0 : c.ch - 1);
    const key = () => `${x},${y}`;
    if (vert) { while (used.has(key()) && y < c.ch - 2) y++; while (used.has(key()) && y > 1) y--; }
    else { while (used.has(key()) && x < c.cw - 2) x++; while (used.has(key()) && x > 1) x--; }
    used.add(key());
    return {...p, x, y, src: p};
  });
}

// mirror a placed child so that its pins face the things they connect to
function orient(c, fx, fy) {
  c.fx = fx; c.fy = fy;
  c.ppins = c.ppins0.map(p => ({...p, x: fx ? c.cw - 1 - p.x : p.x, y: fy ? c.ch - 1 - p.y : p.y, out: [fx ? -p.out[0] : p.out[0], fy ? -p.out[1] : p.out[1]]}));
}
function chooseOrientations(m) {
  const boxes = m.children.filter(c => isBox(c) && c.ppins0.length);
  if (!boxes.length) return;
  for (let round = 0; round < 3; round++) {
    const at = new Map();
    for (const c of m.children) for (const p of c.ppins) for (const n of p.nets) {
      if (isPower(n)) continue;
      let a = at.get(n); if (!a) at.set(n, a = []); a.push([c.x + p.x, c.y + p.y, c]);
    }
    let changed = false;
    for (const c of boxes) {
      // centroid of everything else each pin connects to
      const targets = c.ppins0.map(p => {
        let sx = 0, sy = 0, k = 0;
        for (const n of p.nets) for (const [x, y, o] of at.get(n) || []) if (o !== c) { sx += x; sy += y; k++; }
        return k ? [sx / k, sy / k] : null;
      });
      let best = null;
      // only left/right mirroring: flipping vertically would put NMOS above PMOS
      for (const [fx, fy] of [[false, false], [true, false]]) {
        let cost = 0;
        c.ppins0.forEach((p, i) => {
          const t = targets[i]; if (!t) return;
          const x = c.x + (fx ? c.cw - 1 - p.x : p.x), y = c.y + (fy ? c.ch - 1 - p.y : p.y);
          cost += Math.abs(x - t[0]) + Math.abs(y - t[1]);
        });
        cost += (fx ? 0.5 : 0) + (fy ? 0.5 : 0); // keep the natural orientation on ties
        if (!best || cost < best[0]) best = [cost, fx, fy];
      }
      if (best[1] !== c.fx || best[2] !== c.fy) { orient(c, best[1], best[2]); changed = true; }
    }
    if (!changed) break;
  }
}

function layout(m) {
  if (!isBox(m)) { leafShape(m); footprint(m); return; }
  for (const c of m.children) layout(c);
  // widen the spacing and lay out again while wires still overlap
  for (let attempt = 0; ; attempt++) {
    place(m);
    if (!m.children.length || !m.conflicts || attempt >= 3) break;
    m.spread = (m.spread || 1) * 1.35;
  }
  footprint(m);
}

// Inside its own drawing a module keeps inputs on the left and outputs on the right (the
// columns run in signal-flow order); the parent may mirror it, so on screen a block's inputs
// can just as well arrive from the right.  Along each edge the ports follow the vertical order
// of the logic they connect to inside, which avoids crossings at the edge.
// (Letting ports pick any edge by the position of their inside connections was measured to
// produce longer wires with more bends than this, because the columns already encode the flow.)
function assignSides(m) {
  const at = new Map();
  for (const c of m.children) for (const p of c.ppins) for (const n of p.nets) {
    if (isPower(n)) continue;
    let a = at.get(n); if (!a) at.set(n, a = []); a.push(c.y + p.y);
  }
  const bySide = {L: [], R: [], T: [], B: []};
  m.ports.forEach((p, i) => {
    let sy = 0, k = 0;
    for (const n of p.nets) for (const y of at.get(n) || []) { sy += y; k++; }
    bySide[p.dir === 'in' ? 'L' : 'R'].push({p, i, cy: k ? sy / k : Infinity});
  });
  for (const sd of 'LR') bySide[sd].sort((a, b) => a.cy - b.cy || a.i - b.i);
  return bySide;
}

function place(m) {
  let inner = {w:0, h:0};
  if (m.children.length) {
    for (const c of m.children) if (isBox(c)) orient(c, false, false);
    inner = m.children.every(c => c.kind === 'nmos' || c.kind === 'pmos' || c.kind === 'cap') ? placeCmos(m) : placeLayered(m);
    chooseOrientations(m);
  }
  const sides = assignSides(m);
  const ps = sd => sides[sd].map(q => q.p);
  const lw = list => list.length ? Math.ceil(Math.max(...list.map(p => (p.name + (p.nets.length > 1 ? `[${p.nets.length}]` : '')).length)) * CHAR) + 1 : 0;
  // margins hold the port labels plus tracks for buses that fan out to bits
  const fan = list => list.reduce((a, p) => a + (p.nets.length > 1 ? p.nets.filter(n => !isPower(n)).length : 0), 0);
  const sp = m.spread || 1;
  const vfan = Math.ceil((fan(ps('L')) + fan(ps('R'))) * 0.4 * sp), hfan = Math.ceil((fan(ps('T')) + fan(ps('B'))) * 0.4 * sp);
  const ML = 3 + lw(ps('L')) + Math.ceil(fan(ps('L')) * 0.8 * sp) + hfan, MR = 3 + lw(ps('R')) + Math.ceil(fan(ps('R')) * 0.8 * sp) + hfan;
  const MT = 3 + (sides.T.length ? 2 + Math.ceil(fan(ps('T')) * 0.8 * sp) : 0) + vfan, MB = 2 + (sides.B.length ? 2 + Math.ceil(fan(ps('B')) * 0.8 * sp) : 0) + vfan;
  m.margin = {L: ML, R: MR, T: MT, B: MB};
  const titleW = Math.ceil(m.name.length * CHAR * 1.3) + 4;
  m.w = Math.max(ML + inner.w + MR, titleW + 3 * sides.T.length + 3, 3 * sides.B.length + 5, 8);
  m.h = Math.max(MT + inner.h + MB, 2 * Math.max(sides.L.length, sides.R.length) + MT + 1, 6);
  // centre the content and spread the pins along their edges in the order of their connections
  const ox = Math.round(ML + (m.w - ML - MR - inner.w) / 2), oy = MT + Math.round((m.h - MT - MB - inner.h) / 2);
  for (const c of m.children) { c.x += ox; c.y += oy; }
  const along = (list, a, b) => list.map((q, i) => Math.round(a + (i + 0.5) * (b - a) / list.length));
  const pin = (q, x, y, side) => ({x, y, side, nets: q.p.nets, name: q.p.name, dir: q.p.dir, out: {L: [-1, 0], R: [1, 0], T: [0, -1], B: [0, 1]}[side]});
  m.pins = [
    ...along(sides.L, MT, m.h - 1).map((y, i) => pin(sides.L[i], 0, y, 'L')),
    ...along(sides.R, MT, m.h - 1).map((y, i) => pin(sides.R[i], m.w - 1, y, 'R')),
    ...along(sides.T, Math.min(titleW, m.w - 2 - sides.T.length), m.w - 1).map((x, i) => pin(sides.T[i], x, 0, 'T')),
    ...along(sides.B, 1, m.w - 1).map((x, i) => pin(sides.B[i], x, m.h - 1, 'B')),
  ];
  if (m.children.length) routeModule(m);
}

// ---------------------------------------------------------------- geometry

export function buildSchematic(circuit, opts = {}) {
  const t0 = Date.now();
  const root = buildTree(circuit);
  layout(root);
  let conflicts = 0;
  (function count(m) { conflicts += m.conflicts || 0; for (const c of m.children || []) count(c); })(root);
  const nets = circuit.netNames.length;
  const byLayer = SCH_LAYERS.map(() => []);
  const lodCode = size => Math.max(1, Math.min(255, Math.round(Math.log2(Math.max(2, size)) * 8)));
  let lod = 0;
  const R = (x, y, w, h, layer, net = -1, flags = 0) => byLayer[layer].push(Math.round(x), Math.round(y), Math.max(1, Math.round(w)), Math.max(1, Math.round(h)), layer | (flags << 8) | (lod << 16), net);
  const labels = [], texts = [];
  const label = (x, y, size, l, align, text) => { labels.push(Math.round(x), Math.round(y), Math.round(size), Math.round(l), align); texts.push(text); };
  const boxes = [];
  // bundles of more than one net get a virtual id, shared by equal net sets
  const bundles = new Map(), groups = [];
  const meta = circuit.netMeta;
  const bundleName = list => {
    const m0 = meta[list[0]];
    if (m0 && m0.local && list.every(n => meta[n]?.local === m0.local && meta[n]?.modulePath === m0.modulePath)) return `${m0.modulePath}.${m0.local}[${list.length}]`;
    return `${circuit.netNames[list[0]]} +${list.length - 1}`;
  };
  const idFor = list => {
    const real = list.filter(n => !isPower(n));
    if (real.length === 0) return list[0] ?? -1;
    if (real.length === 1) return real[0];
    const sorted = real.slice().sort((a, b) => (meta[a]?.index ?? 0) - (meta[b]?.index ?? 0) || a - b);
    const key = sorted.join(',');
    let id = bundles.get(key);
    if (id == null) { id = nets + groups.length; bundles.set(key, id); groups.push({l: bundleName(sorted), bits: sorted, seg: null}); }
    return id;
  };
  const widthOf = (k, cs) => (k > 1 ? 2.5 + 1.2 * Math.min(k, 8) : 2) * cs / 8;

  // smallest cell size in the tree decides the world scale of the top level
  let minProd = 1;
  (function scan(m, prod) { minProd = Math.min(minProd, prod); for (const c of m.children || []) scan(c, prod * c.s); })(root, 1);
  const topCell = Math.min(Math.max(8, Math.ceil(6 / minProd)), Math.floor(2e9 / Math.max(root.w, root.h)));

  // F: frame of a node = world origin, world units per cell and mirroring
  function emit(m, F, parentLod, depth) {
    const {ox, oy, cs, fx, fy} = F, k = cs / 8, ww = m.w * cs, wh = m.h * cs;
    const own = Math.max(ww, wh);
    // local (unmirrored) coordinates -> world
    const Rl = (x, y, w, h, layer, net = -1, flags = 0) => R(fx ? ox + ww - x - w : ox + x, fy ? oy + wh - y - h : oy + y, w, h, layer, net, flags);
    const Pt = (x, y) => [fx ? ox + ww - x : ox + x, fy ? oy + wh - y : oy + y];
    const Lbl = (x, y, size, l, align, text) => { const [px, py] = Pt(x, y); label(px, py, size, l, fx && align < 2 ? 1 - align : align, text); };
    const power = (px, py, out, net) => { // supply symbol pointing away from the pin (local coords)
      const [dx, dy] = out, L = 7 * k, t = 2 * k;
      const ex = px + dx * L, ey = py + dy * L;
      Rl(Math.min(px, ex) - (dx ? 0 : t / 2), Math.min(py, ey) - (dy ? 0 : t / 2), dx ? L : t, dy ? L : t, S.device, net);
      (net === 0 ? [12] : [12, 8, 4]).forEach((len, i) => {
        const bx = ex + dx * i * 3 * k, by = ey + dy * i * 3 * k;
        if (dx) Rl(bx - t / 2, by - len * k / 2, t, len * k, S.device, net); else Rl(bx - len * k / 2, by - t / 2, len * k, t, S.device, net);
      });
    };
    lod = lodCode(parentLod);
    if (m.kind === 'nmos' || m.kind === 'pmos') {
      const p = m.kind === 'pmos', f = p ? FLAG_PCH : FLAG_NCH;
      const D = (x, y, w, h, layer, net = -1, fl = 0) => Rl(x * k, y * k, w * k, h * k, layer, net, fl);
      D(4, 19, p ? 6 : 10, 2, S.device, m.g);
      if (p) { D(10, 17, 4, 6, S.device, m.g); D(11, 19, 2, 2, S.bubble); }
      D(14, 11, 2, 18, S.device, m.g);
      D(19, 10, 2, 20, S.device, m.g, f);
      D(19, 3, 2, 8, S.device, m.a);
      D(19, 29, 2, 8, S.device, m.b);
      D(21, 10, 4, 2, S.device, m.a); D(21, 28, 4, 2, S.device, m.b);
      for (const pn of m.pins) if (isPower(pn.nets[0])) power((pn.x + 0.5) * cs, (pn.y + 0.5) * cs, pn.out, pn.nets[0]);
      return;
    }
    if (m.kind === 'cap') {
      Rl(11 * k, 4 * k, 2 * k, 8 * k, S.device, m.net); Rl(4 * k, 12 * k, 16 * k, 2 * k, S.device, m.net); Rl(4 * k, 16 * k, 16 * k, 2 * k, S.device, 1);
      power(12 * k, 18 * k, [0, 1], 1);
      return;
    }
    if (m.kind === 'clk') {
      for (const [x, y, w, h] of [[2, 4, 2, 16], [2, 4, 34, 2], [2, 18, 34, 2], [36, 4, 2, 16]]) Rl(x * k, y * k, w * k, h * k, S.frame);
      for (const [x, y, w, h] of [[6, 14, 6, 2], [11, 8, 2, 8], [11, 8, 8, 2], [18, 8, 2, 8], [18, 14, 8, 2], [25, 8, 2, 8], [25, 8, 6, 2], [31, 11, 7, 2]]) Rl(x * k, y * k, w * k, h * k, S.device, m.net);
      Lbl(20 * k, 2 * k, 7 * k, parentLod, 2, m.name);
      return;
    }
    // module or memory box
    const fr = Math.max(1, 2 * k);
    Rl(0, 0, ww, wh, S.box);
    Rl(0, 0, ww, fr, S.frame); Rl(0, wh - fr, ww, fr, S.frame); Rl(0, 0, fr, wh, S.frame); Rl(ww - fr, 0, fr, wh, S.frame);
    boxes.push({p: m.path, m: m.name, r: [Math.round(ox), Math.round(oy), Math.round(ww), Math.round(wh)], d: depth, h: depth <= 1 ? 1 : 0});
    // labels as large as the box allows, so block names stay readable from far away; the
    // title stays at the top left of the box on screen even when the box is mirrored
    const titleSize = Math.max(11 * k, Math.min(0.16 * Math.min(ww, wh), ww * 0.8 / (m.name.length * 0.62 + 1)));
    label(ox + 4 * k + titleSize * 0.2, oy + titleSize * 1.05, titleSize, parentLod, 0, m.name);
    const count = sd => Math.max(1, m.pins.filter(p => p.side === sd).length);
    for (const pn of m.pins) {
      const id = idFor(pn.nets), real = pn.nets.filter(n => !isPower(n)).length;
      const px = (pn.x + 0.5) * cs, py = (pn.y + 0.5) * cs;
      lod = lodCode(parentLod);
      Rl(px - 3 * k, py - 3 * k, 6 * k, 6 * k, S.pin, id);
      if (!real && pn.nets.length) power(px, py, pn.out, pn.nets[0]);
      const text = pn.name + (pn.nets.length > 1 ? `[${pn.nets.length}]` : '');
      const vert = pn.side === 'L' || pn.side === 'R';
      const gap = (vert ? (m.h - m.margin.T - 1) / count(pn.side) : (m.w - 4) / count(pn.side)) * cs;
      const room = (vert ? m.margin[pn.side] * cs : gap * 0.9);
      const size = Math.max(8 * k, Math.min(gap * (vert ? 0.6 : 0.45), room / (text.length * 0.62 + 1.5), 16 * k));
      // label inside the box next to the pin, wherever the pin ended up after mirroring
      const [wx, wy] = Pt(px, py);
      if (vert) { const left = (pn.side === 'L') !== fx; label(left ? wx + 6 * k : wx - 6 * k, wy + size * 0.35, size, own, left ? 0 : 1, text); }
      else { const top = (pn.side === 'T') !== fy; label(wx, top ? wy + 6 * k + size * 0.9 : wy - 6 * k, size, own, 2, text); }
    }
    lod = lodCode(own);
    const cc = c => [((c % m.w) + 0.5) * cs, (((c / m.w) | 0) + 0.5) * cs];
    const seg = (ax, ay, bx, by, t, layer, id) => Rl(Math.min(ax, bx) - t / 2, Math.min(ay, by) - t / 2, Math.abs(ax - bx) + t, Math.abs(ay - by) + t, layer, id);
    for (const g of m.groups || []) {
      const id = idFor(g.nets), t = widthOf(g.nets.length, cs), layer = g.nets.length > 1 ? S.bus : S.wire;
      const deg = new Map();
      let best = null;
      for (const p of g.paths) {
        let run = 0;
        const flush = (i0, i1) => {
          if (i1 <= i0) return;
          const a = p[i0] >> 1, b = p[i1] >> 1, [ax, ay] = cc(a), [bx, by] = cc(b);
          seg(ax, ay, bx, by, t, layer, id);
          const len = Math.abs(ax - bx) + Math.abs(ay - by);
          if (!best || len > best[2]) best = [...Pt((ax + bx) / 2, (ay + by) / 2), len];
          for (const c of [a, b]) deg.set(c, (deg.get(c) || 0) + 1);
        };
        for (let i = 1; i < p.length; i++) {
          if ((p[i] >> 1) === (p[i - 1] >> 1)) { flush(run, i - 1); run = i; }
          else if (i > run + 1 && (p[i] >> 1) - (p[i - 1] >> 1) !== (p[i - 1] >> 1) - (p[i - 2] >> 1)) { flush(run, i - 1); run = i - 1; }
        }
        flush(run, p.length - 1);
      }
      for (const [c, d] of deg) if (d >= 3) { const [x, y] = cc(c); Rl(x - t / 2 - 2 * k, y - t / 2 - 2 * k, t + 4 * k, t + 4 * k, layer, id); }
      if (id >= nets && best && (!groups[id - nets].seg || best[2] > groups[id - nets].seg[2])) groups[id - nets].seg = [...best, own];
    }
    if (m.kind === 'mem') return;
    for (const c of m.children) {
      const ccs = cs * c.s, x0 = c.x * cs, y0 = c.y * cs, cw = c.w * ccs, chh = c.h * ccs;
      // a scaled child's pin is not exactly on the parent grid: short connector along the edge
      if (isBox(c)) for (const pp of c.ppins) {
        const id = idFor(pp.nets), t = widthOf(pp.nets.length, ccs), layer = pp.nets.length > 1 ? S.bus : S.wire;
        const ax = x0 + (pp.x + 0.5) * cs, ay = y0 + (pp.y + 0.5) * cs;
        const sx = (pp.src.x + 0.5) * ccs, sy = (pp.src.y + 0.5) * ccs;
        const bx = x0 + (c.fx ? cw - sx : sx), by = y0 + (c.fy ? chh - sy : sy);
        seg(ax, ay, bx, ay, t, layer, id); seg(bx, ay, bx, by, t, layer, id);
      }
      const [wx0, wy0] = [fx ? ox + ww - x0 - cw : ox + x0, fy ? oy + wh - y0 - chh : oy + y0];
      emit(c, {ox: wx0, oy: wy0, cs: ccs, fx: fx !== c.fx, fy: fy !== c.fy}, own, depth + 1);
      lod = lodCode(own);
    }
  }
  emit(root, {ox: 0, oy: 0, cs: topCell, fx: false, fy: false}, 1e12, 0);

  let total = 0;
  for (const a of byLayer) total += a.length;
  const rects = new Int32Array(total), layerRanges = [];
  let off = 0;
  byLayer.forEach(a => { layerRanges.push([off / 6, a.length / 6]); rects.set(a, off); off += a.length; });
  const header = {format:'fetloom-sch', version:SCH_VERSION, key:opts.key || null, top:circuit.topName, size:[root.w * topCell, root.h * topCell],
    layers:SCH_LAYERS.map(l => l.name), layerRanges, boxes, groups, labels, texts,
    stats:{nets, bundles:groups.length, rects:total / 6, conflicts, ms:Date.now() - t0}};
  return {header, rects};
}

// aggregate value of a bundle: 0/1 if all bits agree, 3 if any X, 2 if all Z, else 4 (mixed)
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
