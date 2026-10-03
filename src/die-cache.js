// Two-level die layout cache:
//   1. layouts/manifest.json + layouts/*.fdie.gz, prebuilt by `npm run layouts`
//   2. IndexedDB in the browser for layouts computed on demand (Web Worker)
// Entries are keyed by layoutKey(source, top), so any edit of the source misses the cache.

import {layoutKey} from './die.js';
import {decodeDie, gzip, gunzip} from './die-format.js';

let manifest = null;
async function loadManifest() {
  manifest ||= fetch('layouts/manifest.json').then(r => r.ok ? r.json() : {entries:{}}).catch(() => ({entries:{}}));
  return manifest;
}

const isGzip = b => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;
const inflate = async b => isGzip(b) ? gunzip(b) : b; // some servers already strip Content-Encoding

function idb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('no IndexedDB'));
    const rq = indexedDB.open('fetloom', 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore('die');
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
}
async function idbGet(key) {
  try {
    const db = await idb();
    return await new Promise((res, rej) => { const rq = db.transaction('die').objectStore('die').get(key); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });
  } catch { return undefined; }
}
async function idbPut(key, value) {
  try {
    const db = await idb();
    await new Promise((res, rej) => { const tx = db.transaction('die', 'readwrite'); tx.objectStore('die').put(value, key); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  } catch { /* cache is best effort */ }
}

let worker = null;
function compute(source, top, key, onStatus) {
  worker?.terminate();
  const w = worker = new Worker(new URL('./die-worker.js', import.meta.url), {type:'module'});
  return new Promise((resolve, reject) => {
    w.onmessage = e => {
      if (e.data.progress) { onStatus?.(`computing layout: ${e.data.progress}`); return; }
      w.terminate(); if (worker === w) worker = null;
      if (e.data.error) reject(new Error(e.data.error)); else resolve(e.data.bytes);
    };
    w.onerror = e => { w.terminate(); reject(new Error(e.message || 'layout worker failed')); };
    w.postMessage({source, top, key});
  });
}

export function cancelDie() { worker?.terminate(); worker = null; }

export async function obtainDie(source, top, {onStatus} = {}) {
  const key = layoutKey(source, top);
  const entry = (await loadManifest()).entries?.[key];
  if (entry) {
    try {
      onStatus?.('loading prebuilt layout…');
      const r = await fetch(`layouts/${entry.file}`);
      if (r.ok) return {die: decodeDie(await inflate(new Uint8Array(await r.arrayBuffer()))), from:'prebuilt cache', key};
    } catch { /* fall through */ }
  }
  const cached = await idbGet(key);
  if (cached) {
    try { return {die: decodeDie(await inflate(new Uint8Array(cached))), from:'browser cache', key}; } catch { /* recompute */ }
  }
  onStatus?.('computing layout…');
  const t0 = performance.now();
  const bytes = await compute(source, top, key, onStatus);
  const die = decodeDie(bytes);
  gzip(bytes).then(gz => idbPut(key, gz.buffer));
  return {die, from:`computed in ${((performance.now() - t0) / 1000).toFixed(1)} s, saved to browser cache`, key};
}
