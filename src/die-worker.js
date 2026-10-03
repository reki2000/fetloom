// Computes a die layout off the UI thread.
import {parseFetLoom, elaborate} from './dsl.js';
import {buildDie} from './die.js';
import {encodeDie} from './die-format.js';

self.onmessage = e => {
  const {source, top, key} = e.data;
  try {
    const circuit = elaborate(parseFetLoom(source), top);
    const die = buildDie(circuit, {key, onProgress: msg => self.postMessage({progress: msg})});
    const bytes = encodeDie(die);
    self.postMessage({bytes}, [bytes.buffer]);
  } catch (err) {
    self.postMessage({error: String(err?.stack || err)});
  }
};
