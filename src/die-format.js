// Binary container for a computed die layout (works in browsers and Node).
//   "FDIE" | u32 version | u32 header bytes | header JSON (utf-8) | pad to 4 | Int32 rect records
// Prebuilt files are additionally gzip-compressed (*.fdie.gz).

import {DIE_VERSION} from './die.js';

const MAGIC = 0x45494446; // "FDIE" little-endian

export function encodeDie({header, rects}) {
  const json = new TextEncoder().encode(JSON.stringify(header));
  const headLen = 12 + json.length, pad = (4 - (headLen % 4)) % 4;
  const out = new Uint8Array(headLen + pad + rects.byteLength);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true); dv.setUint32(4, DIE_VERSION, true); dv.setUint32(8, json.length, true);
  out.set(json, 12);
  out.set(new Uint8Array(rects.buffer, rects.byteOffset, rects.byteLength), headLen + pad);
  return out;
}

export function decodeDie(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (u8.byteLength < 12 || dv.getUint32(0, true) !== MAGIC) throw new Error('not a FetLoom die layout');
  const version = dv.getUint32(4, true);
  if (version !== DIE_VERSION) throw new Error(`die layout version ${version}, expected ${DIE_VERSION}`);
  const len = dv.getUint32(8, true);
  const header = JSON.parse(new TextDecoder().decode(u8.subarray(12, 12 + len)));
  const start = 12 + len + ((4 - ((12 + len) % 4)) % 4);
  const body = new Uint8Array(u8.byteLength - start); // copy -> aligned buffer (Buffer#slice would not copy)
  body.set(u8.subarray(start));
  return {header, rects: new Int32Array(body.buffer, 0, body.byteLength >> 2)};
}

async function pipe(bytes, stream) {
  const res = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await res.arrayBuffer());
}
export const gunzip = bytes => pipe(bytes, new DecompressionStream('gzip'));
export const gzip = bytes => pipe(bytes, new CompressionStream('gzip'));
