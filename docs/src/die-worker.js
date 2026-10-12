// Computes a die layout or a schematic layout off the UI thread.
import {parseFetLoom, elaborate} from './dsl.js';
import {buildDie} from './die.js';
import {buildSchematic} from './schematic.js';
import {encodeDie} from './die-format.js';

self.onmessage = e => {
  const {kind, source, top, key} = e.data;
  try {
    const circuit = elaborate(parseFetLoom(source), top);
    const opts = {key, onProgress: msg => self.postMessage({progress: msg})};
    const result = kind === 'sch' ? buildSchematic(circuit, opts) : buildDie(circuit, opts);
    const bytes = encodeDie(result);
    self.postMessage({bytes}, [bytes.buffer]);
  } catch (err) {
    self.postMessage({error: String(err?.stack || err)});
  }
};
