// FetLoom die layout generator.
//
// Turns an elaborated circuit into a mask-level physical layout:
//   1. floorplan  - large modules ("hard blocks": ALU, register file, decoder, ...) become
//                   rectangular macros; small modules are flattened into their parent's
//                   transistor field.  Items are split by area-balanced min-cut bisection and
//                   packed with slicing shape functions, then stretched top-down so that the
//                   core is a square with uniform transistor density.  Blocks whose estimated
//                   routing demand is too high get wider channels and are floorplanned again.
//   2. pads/power - bonding pads around the core, metal3 Vcc/Gnd comb, local power taps.
//   3. routing    - per hard block, a two-layer grid A* maze router (metal1 preferred
//                   horizontal, metal2 preferred vertical) with negotiated congestion; nets
//                   that cross a block boundary get pins on the block edge chosen by the parent.
//   4. tuning     - bits of the same bus are length-matched with serpentine (zigzag) detours.
//   5. geometry   - every shape is emitted as a rectangle on one of the CMOS process masks.
//
// The result is plain data ({header, rects}) so it can be computed offline, cached and
// shipped as a file.  rects is an Int32Array of [x, y, w, h, layer|flags<<8, net] records
// in lambda units, sorted by layer.

export const DIE_VERSION = 1;
export const CELL = 8; // lambda per routing grid cell

export const LAYERS = [
  {name:'nwell',   label:'N-well',            color:'#b9a447', alpha:.22, conductive:false},
  {name:'pselect', label:'P+ select',         color:'#d98f52', alpha:.14, conductive:false},
  {name:'nselect', label:'N+ select',         color:'#4fa58f', alpha:.14, conductive:false},
  {name:'active',  label:'Active (diffusion)',color:'#3a9d47', alpha:.62, conductive:true},
  {name:'poly',    label:'Poly-Si gate',      color:'#d4372e', alpha:.66, conductive:true},
  {name:'contact', label:'Contact',           color:'#1d1d1d', alpha:.9,  conductive:true},
  {name:'metal1',  label:'Metal 1',           color:'#3f7ee8', alpha:.52, conductive:true},
  {name:'via1',    label:'Via 1',             color:'#14254a', alpha:.9,  conductive:true},
  {name:'metal2',  label:'Metal 2',           color:'#a95bd1', alpha:.48, conductive:true},
  {name:'via2',    label:'Via 2',             color:'#4b2a12', alpha:.9,  conductive:true},
  {name:'metal3',  label:'Metal 3 (power)',   color:'#d9a23a', alpha:.24, conductive:true},
  {name:'glass',   label:'Overglass opening', color:'#8a96a3', alpha:.55, conductive:false},
];
export const L = Object.fromEntries(LAYERS.map((l,i)=>[l.name,i]));
export const FLAG_NCH = 1, FLAG_PCH = 2; // transistor channel: net = gate, on/off derived from gate

const PAD = 6;          // bonding pad size in cells
const PAD_PITCH = PAD + 3;
const RING = PAD + 7;   // pad ring width around the core
const STRIPE = 12;      // metal3 power stripe pitch in cells
const WIRE = 4;         // routed wire width in lambda
const CONGESTION = 0.3; // target estimated routing demand / capacity of a block
const VIA_COST = 2, WRONG_WAY = 2, PRES_COST = 4, HIST_COST = 2, HW = 1.2; // HW: A* heuristic weight (slightly greedy)

function cyrb53(str, seed) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8,'0') + (h1 >>> 0).toString(16).padStart(8,'0');
}

// Cache key of a layout: algorithm version + top module + normalized source text.
export function layoutKey(source, top) {
  const s = `fetloom-die/${DIE_VERSION}\n${top}\n${source.replace(/\r\n?/g,'\n')}`;
  return cyrb53(s, 1) + cyrb53(s, 2);
}

const uniq = a => [...new Set(a)];
const isPower = n => n === 0 || n === 1;

// ---------------------------------------------------------------- hierarchy

function buildTree(circuit) {
  const top = circuit.topName;
  const root = {kind:'module', name:top, path:top, children:[], parent:null,
    ports: uniq([...circuit.topInputs, ...circuit.topOutputs].flatMap(p => p.nets)).filter(n => !isPower(n))};
  const byPath = new Map([[top, root]]);
  for (const h of circuit.hierarchy) {
    const parent = byPath.get(h.parentPath);
    if (!parent) continue;
    let node;
    if (h.type === 'module') node = {kind:'module', name:h.moduleName, children:[], ports: uniq([...h.inputs, ...h.outputs]).filter(n => !isPower(n))};
    else if (h.type === 'Nmos' || h.type === 'Pmos') node = {kind: h.type === 'Nmos' ? 'nmos' : 'pmos', g:h.nets[0], a:h.nets[1], b:h.nets[2], w:3, h:3};
    else if (h.type === 'Cap') node = {kind:'cap', net:h.nets[0], w:3, h:3};
    else if (h.type === 'Clk') node = {kind:'clk', net:h.nets[0], w:3, h:3};
    else if (h.type === 'Rom' || h.type === 'Ram') {
      const nets = uniq(h.nets);
      const addrBits = h.type === 'Rom' ? h.inputs.length : (h.nets.length - h.outputs.length * 2 - 2);
      const bits = 2 ** Math.min(16, Math.max(1, addrBits)) * Math.max(1, h.outputs.length);
      const side = Math.max(Math.ceil(Math.sqrt(bits / (h.type === 'Rom' ? 12 : 6))), Math.ceil((nets.length + 4) / 4) + 3, 6);
      node = {kind: h.type === 'Rom' ? 'rom' : 'ram', nets, w:side, h:side, label:h.label};
    } else continue;
    node.path = h.path; node.parent = parent;
    parent.children.push(node); byPath.set(h.path, node);
  }
  return root;
}

function weight(node) {
  if (node.kind === 'module') return node.tcount;
  if (node.kind === 'rom' || node.kind === 'ram') return node.w * node.h / 9;
  return node.kind === 'clk' ? 3 : 1;
}

function countTransistors(node) {
  if (node.kind !== 'module') return weight(node);
  let t = 0;
  for (const c of node.children) t += countTransistors(c);
  node.tcount = t;
  return t;
}

function childNets(c) {
  switch (c.kind) {
    case 'module': return c.ports;
    case 'nmos': case 'pmos': return uniq([c.g, c.a, c.b]).filter(n => !isPower(n));
    case 'cap': case 'clk': return isPower(c.net) ? [] : [c.net];
    default: return c.nets.filter(n => !isPower(n));
  }
}

// Greedy connectivity ordering: each next child is the one most strongly connected to
// the recently placed ones (source order breaks ties).  Contiguous runs end up adjacent
// in the slicing floorplan, so connected logic is placed close together.
function orderChildren(children) {
  const n = children.length;
  if (n <= 2) return children.slice();
  const nets = children.map(childNets);
  const idx = new Map();
  nets.forEach((ns, i) => ns.forEach(nt => { let a = idx.get(nt); if (!a) idx.set(nt, a = []); a.push(i); }));
  const score = new Float64Array(n), placed = new Uint8Array(n), out = [];
  let factor = 1, firstFree = 0, cur = 0;
  for (let k = 0; k < n; k++) {
    if (k > 0) {
      let best = -1, bs = 0;
      for (let i = 0; i < n; i++) if (!placed[i] && score[i] > bs) { bs = score[i]; best = i; }
      if (best < 0) { while (placed[firstFree]) firstFree++; best = firstFree; }
      cur = best;
    }
    placed[cur] = 1; out.push(children[cur]);
    factor /= 0.6;
    if (factor > 1e100) { for (let i = 0; i < n; i++) score[i] /= factor; factor = 1; }
    for (const nt of nets[cur]) {
      const a = idx.get(nt);
      if (a.length > 48) continue;
      const w = factor / Math.max(1, a.length - 1);
      for (const j of a) if (!placed[j]) score[j] += w;
    }
  }
  return out;
}

// ---------------------------------------------------------------- floorplan

// Every floorplan node carries a shape function: a small Pareto set of feasible
// (w, h) outlines.  Combining two nodes side by side or stacked follows Stockmeyer's
// algorithm, so mixed-size macros and transistor fields pack without large voids.
const SHAPES = 12;
const area = p => p.w * p.h;
function prune(pts) {
  pts.sort((p, q) => p.w - q.w || p.h - q.h);
  let par = [], bestH = Infinity;
  for (const p of pts) if (p.h < bestH) { par.push(p); bestH = p.h; }
  const sane = par.filter(p => p.w <= 5 * p.h && p.h <= 5 * p.w);
  if (sane.length) par = sane;
  if (par.length <= SHAPES) return par;
  let mi = 0;
  par.forEach((p, i) => { if (area(p) < area(par[mi])) mi = i; });
  const keep = new Set([0, par.length - 1, mi]);
  for (let k = 1; keep.size < SHAPES && k < SHAPES; k++) keep.add(Math.round(k * (par.length - 1) / SHAPES));
  return [...keep].sort((x, y) => x - y).map(i => par[i]);
}
let spread = 1; // channel widening factor of the block being floorplanned
// channel between two floorplan parts: wider for big parts and for many nets crossing it
function gapFor(a, b) {
  let shared = 0;
  const [small, big] = a.nets.size < b.nets.size ? [a.nets, b.nets] : [b.nets, a.nets];
  for (const n of small) if (big.has(n)) shared++;
  return Math.round((2 + Math.floor(Math.sqrt(Math.min(area(a.pts[0]), area(b.pts[0]))) / 20) + Math.max(0, shared - 3) * 0.5) * spread);
}

// Area-balanced min-cut bipartition (Fiduccia-Mattheyses) of an ordered item list.
// The ordered split is the starting point; FM passes then move items across the cut
// to reduce the number of nets that span both halves.  Relative order is preserved.
function bisect(list) {
  const n = list.length, areas = list.map(s => Math.min(...s.pts.map(area)));
  const total = areas.reduce((x, y) => x + y, 0);
  let cum = 0, k = 1, bestD = Infinity;
  for (let i = 0; i < n - 1; i++) {
    cum += areas[i];
    const d = Math.abs(cum - total / 2);
    if (d < bestD) { bestD = d; k = i + 1; }
  }
  const side = new Uint8Array(n);
  for (let i = k; i < n; i++) side[i] = 1;
  if (n > 3) {
    const netMap = new Map();
    list.forEach((s, i) => { for (const nt of s.nets) { let a = netMap.get(nt); if (!a) netMap.set(nt, a = []); a.push(i); } });
    const nets = [...netMap.values()].filter(a => a.length >= 2 && a.length <= 64);
    if (nets.length) {
      const itemNets = list.map(() => []);
      nets.forEach((a, e) => { for (const i of a) itemNets[i].push(e); });
      const slack = total * 0.08;
      const lo = total / 2 - slack, hi = total / 2 + slack;
      for (let pass = 0; pass < 4; pass++) {
        const cnt = nets.map(a => { let c = 0; for (const i of a) c += side[i]; return [a.length - c, c]; });
        const gain = new Float64Array(n), locked = new Uint8Array(n), ver = new Int32Array(n);
        for (let i = 0; i < n; i++) for (const e of itemNets[i]) {
          const f = side[i], c = cnt[e];
          if (c[f] === 1) gain[i]++;
          if (c[1 - f] === 0) gain[i]--;
        }
        const heaps = [[], []];
        const hpush = (h, it) => { h.push(it); let j = h.length - 1; while (j > 0) { const q = (j - 1) >> 1; if (h[q][0] >= it[0]) break; h[j] = h[q]; h[q] = it; j = q; } };
        const hpop = h => { const top = h[0], last = h.pop(); if (h.length) { h[0] = last; let j = 0; for (;;) { let c = 2 * j + 1; if (c >= h.length) break; if (c + 1 < h.length && h[c + 1][0] > h[c][0]) c++; if (h[c][0] <= h[j][0]) break; [h[c], h[j]] = [h[j], h[c]]; j = c; } } return top; };
        for (let i = 0; i < n; i++) hpush(heaps[side[i]], [gain[i], i, 0]);
        let sA = [0, 0]; for (let i = 0; i < n; i++) sA[side[i]] += areas[i];
        const moves = []; let run = 0, best = 0, bestAt = 0;
        const bump = (j, d) => { if (locked[j]) return; gain[j] += d; ver[j]++; hpush(heaps[side[j]], [gain[j], j, ver[j]]); };
        for (;;) {
          let pickIt = null;
          for (const f of [0, 1]) {
            const h = heaps[f];
            while (h.length && (locked[h[0][1]] || h[0][2] !== ver[h[0][1]] || sA[f] - areas[h[0][1]] < lo || sA[1 - f] + areas[h[0][1]] > hi)) hpop(h);
            if (h.length && (!pickIt || h[0][0] > pickIt[0])) pickIt = h[0];
          }
          if (!pickIt) break;
          const i = pickIt[1], f = side[i], t = 1 - f;
          hpop(heaps[f]); locked[i] = 1;
          for (const e of itemNets[i]) {
            const c = cnt[e], a = nets[e];
            if (c[t] === 0) for (const j of a) bump(j, 1);
            else if (c[t] === 1) for (const j of a) if (side[j] === t) bump(j, -1);
            c[f]--; c[t]++;
            if (c[f] === 0) for (const j of a) bump(j, -1);
            else if (c[f] === 1) for (const j of a) if (side[j] === f && j !== i) bump(j, 1);
          }
          side[i] = t; sA[f] -= areas[i]; sA[t] += areas[i];
          run += gain[i]; moves.push(i);
          if (run > best) { best = run; bestAt = moves.length; }
        }
        for (let m = moves.length - 1; m >= bestAt; m--) side[moves[m]] ^= 1;
        if (best <= 0) break;
      }
    }
  }
  const A = [], B = [];
  list.forEach((s, i) => (side[i] ? B : A).push(s));
  if (!A.length) A.push(B.shift()); else if (!B.length) B.unshift(A.pop());
  return [A, B];
}

function combine(list) {
  if (!list.length) return {pts:[{w:1, h:1}], empty:true, nets:new Set()};
  if (list.length === 1) return list[0];
  const [la, lb] = bisect(list);
  const a = combine(la), b = combine(lb);
  const gap = gapFor(a, b), A = a.pts, B = b.pts, out = [];
  const nets = new Set(a.nets);
  for (const n of b.nets) nets.add(n);
  // side by side: start from the tallest outlines, always shrink the taller one
  for (let i = 0, j = 0; i < A.length && j < B.length;) {
    out.push({w:A[i].w + gap + B[j].w, h:Math.max(A[i].h, B[j].h), dir:'h', ia:i, ib:j});
    if (A[i].h > B[j].h) i++; else if (A[i].h < B[j].h) j++; else { i++; j++; }
  }
  // stacked: start from the widest outlines, always shrink the wider one
  for (let i = A.length - 1, j = B.length - 1; i >= 0 && j >= 0;) {
    out.push({w:Math.max(A[i].w, B[j].w), h:A[i].h + gap + B[j].h, dir:'v', ia:i, ib:j});
    if (A[i].w > B[j].w) i--; else if (A[i].w < B[j].w) j--; else { i--; j--; }
  }
  return {a, b, gap, nets, pts:prune(out)};
}

// fix the chosen outline of every node, top-down
function pick(t, k) {
  const p = t.pts[k];
  t.w = p.w; t.h = p.h;
  if (t.leaf) { if (t.leaf.kind === 'module') pick(t.leaf.tree, p.inner); return; }
  if (t.empty) return;
  t.dir = p.dir;
  pick(t.a, p.ia); pick(t.b, p.ib);
}

// ---------------------------------------------------------------- main entry

export function buildDie(circuit, opts = {}) {
  const t0 = Date.now();
  const progress = opts.onProgress || (() => {});
  const root = buildTree(circuit);
  const totalT = countTransistors(root);
  const hardT = Math.max(64, Math.round(totalT / 150));
  const hards = [];

  const isHard = node => node.kind === 'module' && (node === root || node.tcount >= hardT);
  // leaf items of a hard block: soft submodules are flattened (DFS of the connectivity
  // ordering keeps each of them contiguous), hard submodules stay single macro items
  const itemsOf = node => orderChildren(node.children).flatMap(ch => ch.kind === 'module' && !isHard(ch) ? itemsOf(ch) : [ch]);
  const shapeOf = node => {
    if (node.kind !== 'module') return {leaf:node, pts:[{w:node.w, h:node.h}], nets:new Set(childNets(node))};
    hardShape(node);
    return {leaf:node, pts:node.pts, nets:new Set(node.ports)};
  };
  function hardShape(m) {
    m.hard = true;
    const shapes = itemsOf(m).map(shapeOf);
    spread = m.spread || 1;
    m.tree = combine(shapes);
    m.ring = Math.round((2 + Math.ceil(m.ports.length / 8)) * Math.sqrt(m.spread || 1));
    const need = Math.ceil(m.ports.length * 1.5) + 8;
    m.pts = m.tree.pts.map((p, inner) => {
      let w = p.w + 2 * m.ring, h = p.h + 2 * m.ring;
      while (2 * (w + h) - 8 < need) { w++; h++; }
      return {w, h, inner};
    });
  }
  progress('floorplan');
  // pads
  const padIn = [], padOut = [];
  for (const p of circuit.topInputs) p.nets.forEach((n, i) => padIn.push({net:n, label: p.width > 1 ? `${p.name}[${i}]` : p.name}));
  for (const p of circuit.topOutputs) p.nets.forEach((n, i) => padOut.push({net:n, label: p.width > 1 ? `${p.name}[${i}]` : p.name}));
  const perSide = Math.max(Math.ceil((padIn.length + 1) / 2), Math.ceil((padOut.length + 1) / 2), 1);
  let S, GW, GH, G, blocks;
  function assign(t, x, y, W, H, owner) {
    if (t.leaf) {
      const it = t.leaf;
      if (it.kind === 'module') { it.rect = [x, y, W, H]; layoutHard(it); }
      else { it.x = x + ((W - it.w) >> 1); it.y = y + ((H - it.h) >> 1); owner.leaves.push(it); }
      return;
    }
    if (t.empty) return;
    if (t.dir === 'h') {
      const tot = t.a.w + t.gap + t.b.w, aw = Math.floor(t.a.w * W / tot), bw = Math.floor(t.b.w * W / tot);
      assign(t.a, x, y, aw, H, owner); assign(t.b, x + W - bw, y, bw, H, owner);
    } else {
      const tot = t.a.h + t.gap + t.b.h, ah = Math.floor(t.a.h * H / tot), bh = Math.floor(t.b.h * H / tot);
      assign(t.a, x, y, W, ah, owner); assign(t.b, x, y + H - bh, W, bh, owner);
    }
  }
  function layoutHard(m) {
    m.idx = hards.length; hards.push(m);
    m.leaves = []; m.kids = []; m.portPins = new Map();
    if (m.parent) { let p = m.parent; while (!p.hard) p = p.parent; p.kids.push(m); }
    blocks.push(m);
    const [x, y, W, H] = m.rect, r = m.ring;
    assign(m.tree, x + r, y + r, W - 2 * r, H - 2 * r, m);
  }

  // estimated routing demand (half-perimeter wirelength) over free track capacity
  function congestion(m) {
    let free = m.rect[2] * m.rect[3];
    const box = new Map();
    const at = (n, x, y) => { const b = box.get(n); if (!b) box.set(n, [x, y, x, y, 1]); else { b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y); b[4]++; } };
    for (const lf of m.leaves) { free -= lf.w * lf.h; for (const n of childNets(lf)) at(n, lf.x + lf.w / 2, lf.y + lf.h / 2); }
    for (const k of m.kids) { free -= k.rect[2] * k.rect[3]; for (const n of k.ports) at(n, k.rect[0] + k.rect[2] / 2, k.rect[1] + k.rect[3] / 2); }
    let dem = 0;
    for (const b of box.values()) if (b[4] >= 2) dem += (b[2] - b[0] + b[3] - b[1]) * (1 + 0.1 * (b[4] - 2)) + 2;
    return dem / Math.max(1, 2 * free);
  }
  for (let iter = 0; ; iter++) {
    hards.length = 0; blocks = [];
    hardShape(root);
    let rootPick = 0;
    root.pts.forEach((p, i) => { const q = root.pts[rootPick]; if (Math.max(p.w, p.h) < Math.max(q.w, q.h)) rootPick = i; });
    pick({leaf:root, pts:root.pts}, rootPick);
    const rootP = root.pts[rootPick];
    S = Math.max(rootP.w, rootP.h, perSide * PAD_PITCH + PAD_PITCH);
    GW = S + 2 * RING; GH = GW; G = GW * GH;
    root.rect = [RING, RING, S, S];
    layoutHard(root);
    if (iter >= 4) break;
    // spread congested blocks (wider channels and transistor gaps), then floorplan again
    let changed = false;
    for (const m of hards) {
      const c = congestion(m);
      if (c > CONGESTION) { m.spread = (m.spread || 1) * Math.min(1.5, (c / CONGESTION) ** 0.7); changed = true; }
    }
    if (!changed) break;
  }
  const PADREG = hards.length;
  // soft modules: bounding box of their placed contents (for labels / zoom targets)
  (function bbox(node) {
    if (node.kind !== 'module') return node.rect || [node.x, node.y, node.w, node.h];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const c of node.children) {
      const r = bbox(c);
      if (!r) continue;
      x0 = Math.min(x0, r[0]); y0 = Math.min(y0, r[1]); x1 = Math.max(x1, r[0] + r[2]); y1 = Math.max(y1, r[1] + r[3]);
    }
    if (!node.hard) {
      if (x0 === Infinity) return null;
      node.rect = [x0, y0, x1 - x0, y1 - y0]; blocks.push(node);
    }
    return node.rect;
  })(root);

  // ------------------------------------------------------------ grid state
  progress('grid');
  const region = new Int32Array(G).fill(PADREG);
  const pinNet = new Int32Array(G).fill(-1);
  const pinUsed = new Uint8Array(G);
  const fill = (x, y, w, h, v) => { for (let j = y; j < y + h; j++) region.fill(v, j * GW + x, j * GW + x + w); };
  for (const m of hards) {
    fill(...m.rect, m.idx);
    for (const lf of m.leaves) fill(lf.x, lf.y, lf.w, lf.h, -1);
  }
  const cellOf = (x, y) => y * GW + x;
  const taps = []; // {cell, net}

  // fixed terminals of leaf cells
  for (const m of hards) for (const lf of m.leaves) {
    const {x, y} = lf;
    lf.terms = [];
    const addTerm = (net, cells) => {
      if (isPower(net)) { taps.push({cell:cells[0], net}); pinUsed[cells[0]] = 1; return; }
      for (const c of cells) pinNet[c] = net;
      lf.terms.push({net, cells});
    };
    if (lf.kind === 'nmos' || lf.kind === 'pmos') {
      addTerm(lf.g, [cellOf(x + 1, y), cellOf(x + 1, y + 2)]);
      addTerm(lf.a, [cellOf(x, y + 1)]);
      addTerm(lf.b, [cellOf(x + 2, y + 1)]);
    } else if (lf.kind === 'cap' || lf.kind === 'clk') {
      addTerm(lf.net, [cellOf(x + 1, y), cellOf(x, y + 1), cellOf(x + 2, y + 1), cellOf(x + 1, y + 2)]);
    }
  }

  // pads
  const pads = [];
  {
    const place = (list, side, from, n) => list.forEach((p, i) => {
      const off = RING + Math.round((from + i + 0.5) * S / n) - (PAD >> 1);
      const m = 2;
      let x, y;
      if (side === 'L') { x = m; y = off; } else if (side === 'R') { x = GW - m - PAD; y = off; }
      else if (side === 'T') { x = off; y = m; } else { x = off; y = GH - m - PAD; }
      pads.push({...p, side, x, y});
    });
    const left = [{net:0, label:'Vcc'}, ...padIn], right = [{net:1, label:'Gnd'}, ...padOut];
    const cap = Math.max(1, Math.floor(S / PAD_PITCH));
    const nl = Math.min(left.length, cap), nr = Math.min(right.length, cap);
    place(left.slice(0, nl), 'L', 0, nl); place(left.slice(nl), 'T', 0, left.length - nl);
    place(right.slice(0, nr), 'R', 0, nr); place(right.slice(nr), 'B', 0, right.length - nr);
    for (const p of pads) {
      fill(p.x, p.y, PAD, PAD, -1);
      const h = PAD >> 1;
      p.pin = p.side === 'L' ? cellOf(p.x + PAD - 1, p.y + h) : p.side === 'R' ? cellOf(p.x, p.y + h)
            : p.side === 'T' ? cellOf(p.x + h, p.y + PAD - 1) : cellOf(p.x + h, p.y);
      if (!isPower(p.net)) pinNet[p.pin] = p.net;
    }
  }

  // ------------------------------------------------------------ flexible pins
  const cx = c => c % GW, cy = c => (c / GW) | 0;
  function boundaryPin(rect, tx, ty, net) {
    const [x, y, w, h] = rect;
    let best = -1, bd = Infinity;
    const taken = c => pinNet[c] >= 0 || pinUsed[c];
    const tryCell = (px, py) => {
      const c = cellOf(px, py);
      if (taken(c)) return;
      // keep a free cell between pins so each one gets its own access track
      const horiz = py === y || py === y + h - 1;
      const crowd = horiz ? taken(c - 1) + taken(c + 1) : taken(c - GW) + taken(c + GW);
      const d = Math.abs(px - tx) + Math.abs(py - ty) + crowd * 4;
      if (d < bd) { bd = d; best = c; }
    };
    for (let i = 1; i < w - 1; i++) { tryCell(x + i, y); tryCell(x + i, y + h - 1); }
    for (let j = 1; j < h - 1; j++) { tryCell(x, y + j); tryCell(x + w - 1, y + j); }
    if (best >= 0) { if (net >= 0) pinNet[best] = net; pinUsed[best] = 1; }
    return best;
  }
  const rectCenter = r => [r[0] + r[2] / 2, r[1] + r[3] / 2];

  // centroid of the terminals of each port net inside a hard block: block pins are put
  // between the outside and the inside connection so neither side has to detour
  for (const m of hards) {
    const acc = new Map(), ports = new Set(m.ports);
    const at = (n, x, y) => { if (!ports.has(n)) return; const a = acc.get(n); if (a) { a[0] += x; a[1] += y; a[2]++; } else acc.set(n, [x, y, 1]); };
    for (const lf of m.leaves) for (const n of childNets(lf)) at(n, lf.x + lf.w / 2, lf.y + lf.h / 2);
    for (const k of m.kids) for (const n of k.ports) at(n, ...rectCenter(k.rect));
    m.inner = acc;
  }
  const pinTarget = (blk, net, ex, ey) => {
    const a = blk.inner?.get(net);
    return a ? [(ex + a[0] / a[2]) / 2, (ey + a[1] / a[2]) / 2] : [ex, ey];
  };

  // top-level ports: pin on the core edge facing the pad
  for (const p of pads) {
    if (isPower(p.net)) continue;
    const c = boundaryPin(root.rect, ...pinTarget(root, p.net, cx(p.pin), cy(p.pin)), p.net);
    if (c >= 0) root.portPins.set(p.net, c);
  }

  // ------------------------------------------------------------ router
  const NS = G * 2;
  const usage = new Uint8Array(NS), hist = new Float32Array(NS), own = new Int32Array(NS);
  const gScore = new Float32Array(NS), parent = new Int32Array(NS), seen = new Int32Array(NS), closed = new Int32Array(NS);
  const tgtTag = new Int32Array(G), tgtIdx = new Int32Array(G);
  let tag = 0, searchId = 0, pres = PRES_COST, hw = HW;
  let heapS = new Int32Array(1 << 16), heapF = new Float32Array(1 << 16), heapN = 0;
  const push = (s, f) => {
    if (heapN >= heapS.length) { const ns = new Int32Array(heapS.length * 2), nf = new Float32Array(heapS.length * 2); ns.set(heapS); nf.set(heapF); heapS = ns; heapF = nf; }
    let i = heapN++;
    while (i > 0) { const p = (i - 1) >> 1; if (heapF[p] <= f) break; heapS[i] = heapS[p]; heapF[i] = heapF[p]; i = p; }
    heapS[i] = s; heapF[i] = f;
  };
  const pop = () => {
    const top = heapS[0], ls = heapS[--heapN], lf = heapF[heapN];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1; if (c >= heapN) break;
      if (c + 1 < heapN && heapF[c + 1] < heapF[c]) c++;
      if (heapF[c] >= lf) break;
      heapS[i] = heapS[c]; heapF[i] = heapF[c]; i = c;
    }
    heapS[i] = ls; heapF[i] = lf;
    return top;
  };

  // A* from the current tree to the nearest unfinished terminal of `net`.
  function search(sources, net, reg, box, tb, done, curTag) {
    const sid = ++searchId; heapN = 0;
    const [x0, y0, x1, y1] = box;
    const h = c => { const x = c % GW, y = (c / GW) | 0; return Math.max(0, tb[0] - x, x - tb[2]) + Math.max(0, tb[1] - y, y - tb[3]); };
    for (const s of sources) { seen[s] = sid; gScore[s] = 0; parent[s] = -1; push(s, h(s >> 1) * hw); }
    const relax = (ns, ng) => {
      if (seen[ns] === sid && gScore[ns] <= ng) return;
      seen[ns] = sid; gScore[ns] = ng; push(ns, ng + h(ns >> 1) * hw);
      return true;
    };
    while (heapN) {
      const s = pop();
      if (closed[s] === sid) continue;
      closed[s] = sid;
      const c = s >> 1, layer = s & 1;
      if (tgtTag[c] === curTag && !done[tgtIdx[c]]) return s;
      const g = gScore[s];
      const o = s ^ 1;
      if (closed[o] !== sid) { const ng = g + VIA_COST + (usage[o] && own[o] !== curTag ? pres * usage[o] : 0) + hist[o] * HIST_COST; if (relax(o, ng)) parent[o] = s; }
      const x = c % GW, y = (c / GW) | 0;
      for (let d = 0; d < 4; d++) {
        let nx = x, ny = y;
        if (d === 0) nx--; else if (d === 1) nx++; else if (d === 2) ny--; else ny++;
        const wrong = (d < 2) === (layer === 1) ? WRONG_WAY : 0;
        if (nx < x0 || nx > x1 || ny < y0 || ny > y1) continue;
        const nc = ny * GW + nx, pn = pinNet[nc];
        if (pn !== net && (pn >= 0 || region[nc] !== reg)) continue;
        const ns = nc * 2 + layer;
        if (closed[ns] === sid) continue;
        const ng = g + 1 + wrong + (usage[ns] && own[ns] !== curTag ? pres * usage[ns] : 0) + hist[ns] * HIST_COST;
        if (relax(ns, ng)) parent[ns] = s;
      }
    }
    return -1;
  }

  const routes = []; // {net, reg, paths:[Int32Array]}
  let failed = 0;
  function routeNet(net, terms, reg, limit, wide = false) {
    const curTag = ++tag;
    const done = new Uint8Array(terms.length);
    terms.forEach((t, i) => { for (const c of t.cells) { tgtTag[c] = curTag; tgtIdx[c] = i; } });
    // start from the terminal nearest to the centroid
    let mx = 0, my = 0;
    for (const t of terms) { mx += cx(t.cells[0]); my += cy(t.cells[0]); }
    mx /= terms.length; my /= terms.length;
    let start = 0, sd = Infinity;
    terms.forEach((t, i) => { const d = Math.abs(cx(t.cells[0]) - mx) + Math.abs(cy(t.cells[0]) - my); if (d < sd) { sd = d; start = i; } });
    done[start] = 1;
    const sources = [];
    for (const c of terms[start].cells.slice(0, 1)) sources.push(c * 2, c * 2 + 1);
    const tree = new Set(sources);
    const paths = [];
    let ok = true;
    for (let left = terms.length - 1; left > 0; left--) {
      const tb = [Infinity, Infinity, -Infinity, -Infinity];
      for (let i = 0; i < terms.length; i++) if (!done[i]) for (const c of terms[i].cells) {
        const x = cx(c), y = cy(c);
        if (x < tb[0]) tb[0] = x; if (y < tb[1]) tb[1] = y; if (x > tb[2]) tb[2] = x; if (y > tb[3]) tb[3] = y;
      }
      let bx0 = tb[0], by0 = tb[1], bx1 = tb[2], by1 = tb[3];
      for (const s of tree) { const x = cx(s >> 1), y = cy(s >> 1); if (x < bx0) bx0 = x; if (y < by0) by0 = y; if (x > bx1) bx1 = x; if (y > by1) by1 = y; }
      const mg = 6 + ((bx1 - bx0 + by1 - by0) >> 2);
      const box = [Math.max(limit[0], bx0 - mg), Math.max(limit[1], by0 - mg), Math.min(limit[2], bx1 + mg), Math.min(limit[3], by1 + mg)];
      let end = wide ? -1 : search(tree, net, reg, box, tb, done, curTag);
      if (end < 0) end = search(tree, net, reg, limit, tb, done, curTag);
      if (end < 0) { ok = false; break; }
      const p = [];
      for (let s = end; s >= 0; s = parent[s]) { p.push(s); if (tree.has(s) && s !== end) break; }
      p.reverse();
      done[tgtIdx[end >> 1]] = 1;
      for (const s of p) {
        // pin cells are reserved for their net and shared by parent/child routes
        if (own[s] !== curTag && pinNet[s >> 1] !== net) { own[s] = curTag; if (usage[s] < 255) usage[s]++; }
        tree.add(s);
      }
      paths.push(Int32Array.from(p));
    }
    // other candidate cells of the terminals are no longer targets
    terms.forEach(t => { for (const c of t.cells) tgtTag[c] = 0; });
    if (!ok) failed++;
    return {net, reg, paths, tag:curTag, terms};
  }
  function ripUp(r) {
    const t = ++tag;
    for (const p of r.paths) for (const s of p) if (own[s] !== t && pinNet[s >> 1] !== r.net) { own[s] = t; usage[s]--; }
  }
  const overflowed = r => r.paths.some(p => p.some(s => usage[s] > 1 && pinNet[s >> 1] !== r.net));

  function routeRegion(reg, netTerms, limit) {
    const list = [...netTerms].filter(([, t]) => t.length >= 2).map(([net, terms]) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const t of terms) { const x = cx(t.cells[0]), y = cy(t.cells[0]); x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      return {net, terms, hp: x1 - x0 + y1 - y0};
    }).sort((a, b) => a.hp - b.hp || a.net - b.net);
    pres = PRES_COST; hw = HW;
    let rs = list.map(n => routeNet(n.net, n.terms, reg, limit));
    hw = 1.6; // rip-up rounds: greedier search, the congestion costs dominate anyway
    for (let it = 0, best = Infinity, stall = 0; it < 12; it++) {
      pres = PRES_COST * 2 ** Math.min(it + 1, 5);
      const bad = rs.filter(overflowed);
      if (!bad.length) break;
      if (bad.length < best * 0.9) { best = bad.length; stall = 0; } else if (++stall >= 2) break;
      for (const r of bad) for (const p of r.paths) for (const s of p) if (usage[s] > 1) hist[s] += 1;
      for (const r of bad) ripUp(r);
      const fresh = new Map();
      for (const r of bad) { failed -= r.paths.length < r.terms.length - 1 ? 1 : 0; fresh.set(r, routeNet(r.net, r.terms, reg, limit)); }
      rs = rs.map(r => fresh.get(r) || r);
    }
    // last resort for the few remaining conflicts: whole-block search, steep penalty
    pres = PRES_COST * 256; hw = 2;
    for (let k = 0; k < rs.length; k++) {
      const r = rs[k];
      if (!overflowed(r)) continue;
      ripUp(r);
      failed -= r.paths.length < r.terms.length - 1 ? 1 : 0;
      rs[k] = routeNet(r.net, r.terms, reg, limit, true);
    }
    for (const r of rs) routes.push(r);
    return rs;
  }

  // ------------------------------------------------------------ bus length matching
  let tunedNets = 0, tunedGroups = 0;
  const pathLen = p => { let n = 0; for (let i = 1; i < p.length; i++) if ((p[i] >> 1) !== (p[i - 1] >> 1)) n++; return n; };
  function free(c, layer, reg, net) {
    if (c < 0 || c >= G) return false;
    if (region[c] !== reg) return false;
    if (pinNet[c] >= 0 && pinNet[c] !== net) return false;
    return usage[c * 2 + layer] === 0;
  }
  function meander(r, extra, reg) {
    const p = r.paths[0], out = [];
    let need = extra, flip = 1, skip = false;
    out.push(p[0]);
    for (let i = 1; i < p.length; i++) {
      const s0 = p[i - 1], s1 = p[i], c0 = s0 >> 1, c1 = s1 >> 1, layer = s0 & 1;
      if (!skip && need >= 2 && c0 !== c1 && (s1 & 1) === layer && i > 1 && i < p.length - 1) {
        // serpentine bump perpendicular to the step, on the same layer (no vias)
        const horiz = Math.abs(c1 - c0) === 1, off = horiz ? GW : 1;
        let applied = 0;
        for (let k = Math.min(6, need >> 1); k >= 1 && !applied; k--) {
          for (const dir of [flip, -flip]) {
            const d = dir * off;
            if (horiz ? (cy(c0) + dir * k < 0 || cy(c0) + dir * k >= GH) : (cx(c0) + dir * k < 0 || cx(c0) + dir * k >= GW)) continue;
            let okb = true;
            for (let j = 1; j <= k && okb; j++) okb = free(c0 + d * j, layer, reg, r.net) && free(c1 + d * j, layer, reg, r.net);
            if (!okb) continue;
            const seg = [];
            for (let j = 1; j <= k; j++) seg.push((c0 + d * j) * 2 + layer);
            for (let j = k; j >= 1; j--) seg.push((c1 + d * j) * 2 + layer);
            for (const st of seg) usage[st]++;
            out.push(...seg);
            need -= 2 * k; applied = k; flip = -dir;
            break;
          }
        }
        if (applied) { out.push(s1); skip = true; continue; }
      }
      skip = false;
      out.push(s1);
    }
    r.paths[0] = Int32Array.from(out);
    return extra - need;
  }
  function tuneBuses(rs, reg) {
    const groups = new Map();
    for (const r of rs) {
      if (r.terms.length !== 2 || r.paths.length !== 1) continue;
      const meta = circuit.netMeta[r.net];
      if (!meta || meta.index == null || !meta.local) continue;
      const k = `${meta.modulePath}.${meta.local}`;
      let g = groups.get(k); if (!g) groups.set(k, g = []); g.push(r);
    }
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      const lens = g.map(r => pathLen(r.paths[0]));
      const target = Math.max(...lens);
      let any = false;
      g.forEach((r, i) => {
        const extra = target - lens[i];
        if (extra < 2 || extra > 4 * lens[i] + 48) return;
        if (meander(r, extra, reg) > 0) { tunedNets++; any = true; }
      });
      if (any) tunedGroups++;
    }
  }

  // ------------------------------------------------------------ route everything
  {
    progress('routing pads');
    const nt = new Map();
    for (const p of pads) {
      if (isPower(p.net)) continue;
      const rp = root.portPins.get(p.net);
      if (rp == null) continue;
      nt.set(p.net, [{cells:[p.pin]}, {cells:[rp]}]);
    }
    routeRegion(PADREG, nt, [0, 0, GW - 1, GH - 1]);
  }
  hards.forEach((m, hi) => {
    progress(`routing ${m.path} (${hi + 1}/${hards.length})`);
    const nt = new Map();
    const add = (net, t) => { let a = nt.get(net); if (!a) nt.set(net, a = []); a.push(t); };
    for (const [net, c] of m.portPins) add(net, {cells:[c]});
    for (const lf of m.leaves) {
      if (lf.terms) for (const t of lf.terms) add(t.net, t);
      if (lf.kind === 'rom' || lf.kind === 'ram') for (const n of lf.nets) add(n, {flex:lf});
    }
    for (const k of m.kids) for (const n of k.ports) add(n, {flex:k});
    // place flexible pins next to the centroid of the other terminals of the net
    for (const [net, terms] of nt) {
      if (isPower(net)) {
        for (const t of terms) {
          const r = t.flex.rect || [t.flex.x, t.flex.y, t.flex.w, t.flex.h];
          const c = boundaryPin(r, r[0], r[1], -1);
          if (c >= 0) taps.push({cell:c, net});
        }
        nt.delete(net);
        continue;
      }
      if (terms.length < 2) { nt.delete(net); continue; }
      const pos = terms.map(t => t.cells ? [cx(t.cells[0]), cy(t.cells[0])] : rectCenter(t.flex.rect || [t.flex.x, t.flex.y, t.flex.w, t.flex.h]));
      terms.forEach((t, i) => {
        if (!t.flex) return;
        let sx = 0, sy = 0;
        pos.forEach((p, j) => { if (j !== i) { sx += p[0]; sy += p[1]; } });
        const n = pos.length - 1;
        const r = t.flex.rect || [t.flex.x, t.flex.y, t.flex.w, t.flex.h];
        const c = boundaryPin(r, ...pinTarget(t.flex, net, sx / n, sy / n), net);
        if (c < 0) { t.cells = null; return; }
        t.cells = [c];
        pos[i] = [cx(c), cy(c)];
        if (t.flex.kind === 'module') t.flex.portPins.set(net, c);
        else (t.flex.pins ||= []).push({cell:c, net});
      });
      const ok = terms.filter(t => t.cells);
      if (ok.length < 2) nt.delete(net); else nt.set(net, ok);
    }
    const [x, y, w, h] = m.rect;
    const rs = routeRegion(m.idx, nt, [x, y, x + w - 1, y + h - 1]);
    tuneBuses(rs, m.idx);
  });

  // ------------------------------------------------------------ geometry
  progress('geometry');
  const byLayer = LAYERS.map(() => []);
  const R = (x, y, w, h, layer, net = -1, flags = 0) => { byLayer[layer].push(x, y, w, h, layer | (flags << 8), net); };
  const C = CELL, half = C >> 1;
  const ctr = c => [cx(c) * C + half, cy(c) * C + half];
  const square = (c, size, layer, net) => { const [px, py] = ctr(c); R(px - (size >> 1), py - (size >> 1), size, size, layer, net); };

  for (const r of routes) {
    for (const s of r.paths.flatMap(p => [...p])) pinUsed[s >> 1] = 1;
    for (const p of r.paths) {
      let runStart = 0;
      const flush = (i0, i1) => {
        if (i1 <= i0) return;
        const a = p[i0] >> 1, b = p[i1] >> 1, layer = p[i0] & 1;
        const [ax, ay] = ctr(a), [bx, by] = ctr(b);
        const x0 = Math.min(ax, bx) - WIRE / 2, y0 = Math.min(ay, by) - WIRE / 2;
        R(x0, y0, Math.abs(ax - bx) + WIRE, Math.abs(ay - by) + WIRE, layer ? L.metal2 : L.metal1, r.net);
      };
      for (let i = 1; i < p.length; i++) {
        if ((p[i] >> 1) === (p[i - 1] >> 1)) { // via
          flush(runStart, i - 1); runStart = i;
          square(p[i] >> 1, 4, L.via1, r.net);
          square(p[i] >> 1, 6, L.metal1, r.net); square(p[i] >> 1, 6, L.metal2, r.net);
        } else if (i > runStart + 1) {
          const d0 = (p[i - 1] >> 1) - (p[i - 2] >> 1), d1 = (p[i] >> 1) - (p[i - 1] >> 1);
          if (d0 !== d1) { flush(runStart, i - 1); runStart = i - 1; }
        }
      }
      flush(runStart, p.length - 1);
      // a metal2 arrival at a pin needs a via down to the metal1 pin pad
      for (const i of [0, p.length - 1]) {
        if ((p[i] & 1) === 1 && pinNet[p[i] >> 1] === r.net) { square(p[i] >> 1, 4, L.via1, r.net); square(p[i] >> 1, 6, L.metal1, r.net); }
      }
    }
  }

  // module pins (hard block edges)
  for (const m of hards) for (const [net, c] of m.portPins) { square(c, 6, L.metal1, net); square(c, 6, L.metal2, net); square(c, 4, L.via1, net); }

  // transistors and leaf cells
  for (const m of hards) for (const lf of m.leaves) {
    const X = lf.x * C, Y = lf.y * C;
    if (lf.kind === 'nmos' || lf.kind === 'pmos') {
      const p = lf.kind === 'pmos';
      if (p) R(X - 4, Y - 4, 32, 32, L.nwell);
      R(X, Y + 4, 24, 16, p ? L.pselect : L.nselect);
      R(X + 1, Y + 6, 9, 12, L.active, lf.a);
      R(X + 14, Y + 6, 9, 12, L.active, lf.b);
      R(X + 10, Y + 6, 4, 12, L.active, lf.g, p ? FLAG_PCH : FLAG_NCH);
      R(X + 10, Y + 1, 4, 22, L.poly, lf.g);
      R(X + 2, Y + 10, 4, 4, L.contact, lf.a); R(X + 1, Y + 9, 6, 6, L.metal1, lf.a);
      R(X + 18, Y + 10, 4, 4, L.contact, lf.b); R(X + 17, Y + 9, 6, 6, L.metal1, lf.b);
      const top = cellOf(lf.x + 1, lf.y), bot = cellOf(lf.x + 1, lf.y + 2);
      const useBot = pinUsed[bot] && !pinUsed[top];
      const gy = useBot ? Y + 17 : Y + 1;
      R(X + 9, gy, 6, 6, L.poly, lf.g); R(X + 10, gy + 1, 4, 4, L.contact, lf.g); R(X + 9, gy, 6, 6, L.metal1, lf.g);
      if (pinUsed[top] && pinUsed[bot]) { R(X + 9, Y + 17, 6, 6, L.poly, lf.g); R(X + 10, Y + 18, 4, 4, L.contact, lf.g); R(X + 9, Y + 17, 6, 6, L.metal1, lf.g); }
    } else if (lf.kind === 'cap') {
      R(X + 1, Y + 1, 22, 22, L.active, 1);
      R(X + 1, Y + 1, 22, 22, L.nselect);
      R(X + 2, Y + 2, 20, 20, L.poly, lf.net);
      for (const c of lf.terms[0]?.cells || []) if (pinUsed[c]) { square(c, 4, L.contact, lf.net); square(c, 6, L.metal1, lf.net); }
    } else if (lf.kind === 'clk') {
      R(X + 1, Y + 5, 22, 14, L.active, -1);
      R(X + 1, Y + 5, 22, 14, L.nselect);
      for (const fx of [4, 10, 16]) R(X + fx, Y + 2, 3, 20, L.poly, lf.net);
      R(X + 2, Y + 2, 20, 3, L.poly, lf.net);
      for (const c of lf.terms[0]?.cells || []) if (pinUsed[c]) { square(c, 4, L.contact, lf.net); square(c, 6, L.metal1, lf.net); }
    } else { // rom / ram array
      const W = lf.w * C, H = lf.h * C, rom = lf.kind === 'rom';
      R(X, Y, W, H, L.nselect);
      for (let j = 1; j < lf.h - 1; j++) R(X + C, Y + j * C + 3, W - 2 * C, 2, L.poly);
      for (let i = 1; i < lf.w - 1; i++) R(X + i * C + 3, Y + C, 2, H - 2 * C, L.metal1);
      for (let j = 1; j < lf.h - 1; j++) for (let i = 1; i < lf.w - 1; i++) {
        const hsh = Math.imul(i * 73856093 ^ j * 19349663 ^ lf.w, 2654435761) >>> 28;
        if (rom ? (hsh & 1) : true) R(X + i * C + (rom ? 1 : 0), Y + j * C + (rom ? 1 : 0), rom ? 6 : 7, rom ? 6 : 3, L.active);
        if (rom && (hsh & 1)) R(X + i * C + 3, Y + j * C + 3, 2, 2, L.contact);
      }
      for (const pn of lf.pins || []) { square(pn.cell, 6, L.metal1, pn.net); square(pn.cell, 4, L.via1, pn.net); }
    }
  }

  // pads, power comb and taps
  const spineL = [PAD + 3, RING - 3], spineR = [GW - RING + 1, GW - PAD - 2]; // [x0,x1) cells
  const coreX0 = RING, coreX1 = RING + S;
  const stripes = [];
  for (let y = RING + 2, k = 0; y < RING + S - 2; y += STRIPE, k++) stripes.push({y, net: k & 1});
  for (const st of stripes) {
    const x0 = st.net === 0 ? spineL[0] : coreX0, x1 = st.net === 0 ? coreX1 : spineR[1];
    R(x0 * C, st.y * C + 3, (x1 - x0) * C, 10, L.metal3, st.net);
  }
  R(spineL[0] * C, RING * C, (spineL[1] - spineL[0]) * C, S * C, L.metal3, 0);
  R(spineR[0] * C, RING * C, (spineR[1] - spineR[0]) * C, S * C, L.metal3, 1);
  for (const p of pads) {
    const X = p.x * C, Y = p.y * C, Z = PAD * C;
    R(X, Y, Z, Z, L.metal1, p.net); R(X, Y, Z, Z, L.metal2, p.net); R(X, Y, Z, Z, L.metal3, p.net);
    for (let i = 1; i < 4; i++) R(X + i * Z / 4 - 3, Y + 6, 6, Z - 12, L.via1, p.net);
    R(X + C, Y + C, Z - 2 * C, Z - 2 * C, L.glass);
    if (p.net === 0) R(X + Z, Y + Z / 2 - 2 * C, spineL[0] * C - X - Z + C, 4 * C, L.metal3, 0);
    if (p.net === 1) R(spineR[1] * C - C, Y + Z / 2 - 2 * C, X - spineR[1] * C + C, 4 * C, L.metal3, 1);
  }
  {
    // taps reach the nearest stripe of their own net; fingers must not cross a tap of the other net
    const stripeY = stripes.map(s => s.y * C + 8);
    const fingers = new Map();
    for (const t of taps) {
      const [px, py] = ctr(t.cell);
      square(t.cell, 4, L.via2, t.net); square(t.cell, 6, L.metal1, t.net);
      let bi = -1, bd = Infinity;
      stripes.forEach((s, i) => { if (s.net === t.net) { const d = Math.abs(stripeY[i] - py); if (d < bd) { bd = d; bi = i; } } });
      if (bi < 0) continue;
      const y0 = Math.min(py, stripeY[bi]), y1 = Math.max(py, stripeY[bi]);
      let col = fingers.get(px); if (!col) fingers.set(px, col = []);
      if (col.some(f => f.net !== t.net && f.y0 < y1 + 4 && y0 < f.y1 + 4)) continue;
      col.push({net:t.net, y0, y1});
      R(px - 2, y0, 4, y1 - y0, L.metal3, t.net);
    }
  }

  // ------------------------------------------------------------ output
  let total = 0;
  for (const a of byLayer) total += a.length;
  const rects = new Int32Array(total);
  const layerRanges = [];
  let off = 0;
  byLayer.forEach(a => { layerRanges.push([off / 6, a.length / 6]); rects.set(a, off); off += a.length; });

  let overflow = 0, wire = 0;
  const shorts = []; // cells where two nets overlap on the same layer (reported, drawn as markers)
  for (let s = 0; s < NS; s++) if (usage[s] > 1 && pinNet[s >> 1] < 0) { overflow++; if (shorts.length < 2000) shorts.push(cx(s >> 1) * C + half, cy(s >> 1) * C + half); }
  for (const r of routes) for (const p of r.paths) wire += pathLen(p);
  const depthOf = p => p.split('/').length - 1;
  const header = {
    format: 'fetloom-die', version: DIE_VERSION, key: opts.key || null, top: circuit.topName,
    cell: CELL, size: [GW * C, GH * C], grid: [GW, GH], core: root.rect.map(v => v * C),
    layers: LAYERS.map(l => l.name), layerRanges,
    blocks: blocks.filter(b => b.hard || b.tcount >= 12).map(b => ({p:b.path, m:b.name, r:b.rect.map(v => v * C), d:depthOf(b.path), h:b.hard ? 1 : 0, t:b.tcount}))
      .concat(hards.flatMap(m => m.leaves.filter(l => l.kind === 'rom' || l.kind === 'ram').map(l => ({p:l.path, m:l.kind === 'rom' ? 'ROM' : 'RAM', r:[l.x * C, l.y * C, l.w * C, l.h * C], d:depthOf(l.path), h:1, t:0})))),
    pads: pads.map(p => ({n:p.net, l:p.label, r:[p.x * C, p.y * C, PAD * C, PAD * C]})),
    shorts,
    stats: {transistors: circuit.devices.length, nets: circuit.netNames.length, hardBlocks: hards.length, routedNets: routes.length,
      failedNets: failed, overflowCells: overflow, wirelength: wire, tunedNets, tunedGroups, rects: total / 6, ms: Date.now() - t0},
  };
  progress('done');
  return {header, rects};
}
