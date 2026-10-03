#!/usr/bin/env node
// Precomputes die layouts and schematic layouts for the bundled examples into layouts/ (gzip + manifest).
// Usage: node tools/build-layouts.mjs [--force] [example-basename ...]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {parseFetLoom, elaborate} from '../src/dsl.js';
import {buildDie, layoutKey} from '../src/die.js';
import {encodeDie} from '../src/die-format.js';
import {buildSchematic, schematicKey} from '../src/schematic.js';
import {EXAMPLES} from '../src/examples.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'layouts');
const manifestPath = path.join(outDir, 'manifest.json');
const args = process.argv.slice(2), force = args.includes('--force');
const only = args.filter(a => !a.startsWith('--'));

fs.mkdirSync(outDir, {recursive: true});
const old = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {entries:{}};
const entries = {};
const top = 'main';
const kinds = [
  {kind:'die', ext:'fdie', key:layoutKey, build:buildDie, summary: h => `${h.stats.transistors} MOS, ${h.stats.rects} rects`},
  {kind:'sch', ext:'fsch', key:schematicKey, build:buildSchematic, summary: h => `schematic ${h.stats.rects} rects, ${h.stats.bundles} buses`},
];
for (const ex of EXAMPLES) for (const K of kinds) {
  const base = path.basename(ex.file, '.fetl');
  const source = fs.readFileSync(path.join(root, ex.file), 'utf8');
  const key = K.key(source, top);
  const file = `${base}.${top}.${K.ext}.gz`;
  const prev = Object.entries(old.entries).find(([k, e]) => k === key && e.file === file);
  const skip = only.length ? !only.includes(base) : (!force && prev && fs.existsSync(path.join(outDir, file)));
  if (skip && prev) { entries[key] = prev[1]; console.log(`${base} ${K.kind}: up to date`); continue; }
  if (skip) { console.log(`${base} ${K.kind}: skipped (no layout)`); continue; }
  const t0 = Date.now();
  const circuit = elaborate(parseFetLoom(source), top);
  const out = K.build(circuit, {key, onProgress: m => process.stdout.isTTY && process.stdout.write(`\r${base}: ${m}`.padEnd(70).slice(0, 70))});
  const gz = zlib.gzipSync(encodeDie(out), {level: 9});
  fs.writeFileSync(path.join(outDir, file), gz);
  entries[key] = {file, kind: K.kind, example: ex.file, top, bytes: gz.length, stats: out.header.stats};
  if (process.stdout.isTTY) process.stdout.write('\r'.padEnd(72) + '\r');
  console.log(`${base} ${K.kind}: ${K.summary(out.header)}, ${(gz.length / 1024).toFixed(0)} KiB, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
// keep entries of examples that were not rebuilt in a partial run
if (only.length) for (const [k, e] of Object.entries(old.entries)) if (!Object.values(entries).some(x => x.file === e.file)) entries[k] = e;
for (const f of fs.readdirSync(outDir)) if (/\.f(die|sch)\.gz$/.test(f) && !Object.values(entries).some(e => e.file === f)) fs.unlinkSync(path.join(outDir, f));
fs.writeFileSync(manifestPath, JSON.stringify({format:'fetloom-die-manifest', entries}, null, 1) + '\n');
