#!/usr/bin/env node
// Assemble the static site for GitHub Pages (main branch, /docs).
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.join(root,'docs');
const files=['index.html','styles.css','src','examples','layouts','documentation','wasm/fetloom_core.wasm'];
// Check inputs before replacing the previous build.
for(const file of files)fs.accessSync(path.join(root,file));
fs.rmSync(output,{recursive:true,force:true});
fs.mkdirSync(output,{recursive:true});
for(const file of files){
  const destination=path.join(output,file);
  fs.mkdirSync(path.dirname(destination),{recursive:true});
  fs.cpSync(path.join(root,file),destination,{recursive:true});
}
fs.writeFileSync(path.join(output,'.nojekyll'),'');
console.log('Static site built in docs/');
