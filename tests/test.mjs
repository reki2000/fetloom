import fs from 'node:fs';
import assert from 'node:assert/strict';
import {parseFetLoom, elaborate} from '../src/dsl.js';
import zlib from 'node:zlib';
import {FetLoomSimulator} from '../src/sim.js';
import {buildDie, layoutKey, LAYERS} from '../src/die.js';
import {encodeDie, decodeDie} from '../src/die-format.js';
import {EXAMPLES} from '../src/examples.js';
import {buildSchematic, schematicKey, busValue, busText, SCH_LAYERS} from '../src/schematic.js';

const root=new URL('../',import.meta.url);
function read(rel){return fs.readFileSync(new URL(rel,root),'utf8');}
const wasmBytes=fs.readFileSync(new URL('wasm/fetloom_core.wasm',root));
const {instance}=await WebAssembly.instantiate(wasmBytes,{});
const w=instance.exports;

function coreFor(c){
  assert.equal(w.init_core(c.netNames.length,c.devices.length),1);
  c.devices.forEach((d,i)=>assert.equal(w.set_device(i,d.type==='Nmos'?0:1,d.gate,d.a,d.b),1));
  c.caps.forEach(n=>w.set_cap(n,1));
  return {
    solve(drivers){w.clear_drives();w.drive(0,1);w.drive(1,0);for(const [n,v] of drivers)w.drive(n,v);w.solve();},
    val(n){return w.get_value(n)}
  };
}

for(const {file} of EXAMPLES){
  const ast=parseFetLoom(read(file));
  const c=elaborate(ast,'main');
  assert.ok(c.netNames.length>2,`${file}: nets`);
  console.log(`${file}: ${c.netNames.length} nets, ${c.devices.length} MOS`);
}

async function simFor(file){
  const c=elaborate(parseFetLoom(read(file)),'main');
  const {instance:inst}=await WebAssembly.instantiate(wasmBytes,{});
  const sim=new FetLoomSimulator(c,inst.exports);
  const out=name=>sim.getBus(c.topOutputs.find(p=>p.name===name).nets);
  const run=n=>{for(let i=0;i<n;i++)sim.step();};
  return {c,sim,out,run};
}

{
  const c=elaborate(parseFetLoom(read('examples/inverter.fetl')),'main');
  const core=coreFor(c); const a=c.topInputs[0].nets[0], y=c.topOutputs[0].nets[0];
  core.solve([[a,0]]); assert.equal(core.val(y),1,'inv(0)=1');
  core.solve([[a,1]]); assert.equal(core.val(y),0,'inv(1)=0');
}

{
  const c=elaborate(parseFetLoom(read('examples/fulladder.fetl')),'main');
  const core=coreFor(c);
  const [a,b,cin]=c.topInputs.map(p=>p.nets[0]); const [sum,cout]=c.topOutputs.map(p=>p.nets[0]);
  for(let x=0;x<8;x++){
    const av=x&1,bv=(x>>1)&1,cv=(x>>2)&1;
    core.solve([[a,av],[b,bv],[cin,cv]]);
    assert.equal(core.val(sum),(av+bv+cv)&1,`sum ${x}`);
    assert.equal(core.val(cout),(av+bv+cv)>=2?1:0,`cout ${x}`);
  }
}

{
  const c=elaborate(parseFetLoom(read('examples/i4004.fetl')),'main');
  const {instance:inst}=await WebAssembly.instantiate(wasmBytes,{});
  const sim=new FetLoomSimulator(c,inst.exports);
  sim.romData.set('examples/i4004_demo.hex',Uint8Array.from([0xD1,0xB0,0xD5,0xB1,0xA0,0x81,0xE2,0x60,0x40,0x04]));
  sim.setInputPort('reset',1); sim.setInputPort('test',1);
  for(let i=0;i<20;i++) sim.step();
  sim.setInputPort('reset',0);
  for(let i=0;i<120;i++) sim.step();
  const port=c.topOutputs.find(p=>p.name==='rom_port');
  const v=sim.getBus(port.nets);
  assert.ok(v===6 || v===7,`4004 demo ROM port expected 6/7, got ${v}`);
}

{
  const {sim,out,run}=await simFor('examples/counter4.fetl');
  sim.setInputPort('reset',1); run(16); sim.setInputPort('reset',0); sim.setInputPort('en',1);
  const seen=[]; for(let i=0;i<160;i++){sim.step(); if(seen.at(-1)!==out('q'))seen.push(out('q'));}
  assert.deepEqual(seen.slice(0,17),[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,0],'counter4 counts and wraps');
}

{
  const c=elaborate(parseFetLoom(read('examples/alu4.fetl')),'main');
  const core=coreFor(c);
  const port=n=>c.topInputs.concat(c.topOutputs).find(p=>p.name===n).nets;
  const bus=(nets)=>nets.reduce((v,n,i)=>v|(core.val(n)===1?1<<i:0),0);
  for(let a=0;a<16;a++)for(let b=0;b<16;b++)for(let op=0;op<4;op++){
    const drv=[];
    port('a').forEach((n,i)=>drv.push([n,(a>>i)&1])); port('b').forEach((n,i)=>drv.push([n,(b>>i)&1])); port('op').forEach((n,i)=>drv.push([n,(op>>i)&1]));
    core.solve(drv);
    const y=[(a+b)&15,(a-b)&15,a&b,a^b][op], cy=op===0?+(a+b>15):op===1?+(a>=b):0;
    assert.equal(bus(port('y')),y,`alu4 y op${op} ${a},${b}`);
    assert.equal(bus(port('carry')),cy,`alu4 carry op${op} ${a},${b}`);
    assert.equal(bus(port('zero')),+(y===0),`alu4 zero op${op} ${a},${b}`);
  }
}

{
  const {sim,out,run}=await simFor('examples/regfile4.fetl');
  sim.setInputPort('reset',1); run(16); sim.setInputPort('reset',0); sim.setInputPort('we',1);
  const vals=[5,10,3,12];
  vals.forEach((v,r)=>{sim.setInputPort('waddr',r); sim.setInputPort('din',v); run(8);});
  sim.setInputPort('we',0);
  vals.forEach((v,r)=>{sim.setInputPort('raddr',r); run(2); assert.equal(out('dout'),v,`regfile4 r${r}`);});
}

{
  const {sim,out,run}=await simFor('examples/td4.fetl');
  sim.romData.set('examples/td4_demo.hex',Uint8Array.from([0x01,0x40,0x90,0xF0]));
  sim.setInputPort('reset',1); run(16); sim.setInputPort('reset',0);
  const seen=[]; for(let i=0;i<300;i++){sim.step(); if(seen.at(-1)!==out('out'))seen.push(out('out'));}
  assert.deepEqual(seen.slice(0,6),[0,1,2,3,4,5],'td4 demo program counts on OUT');
}

// ---- die layout
function checkDie(name,c,die){
  const {header,rects}=die, [W,H]=header.size, n=rects.length/6;
  assert.equal(header.layerRanges.length,LAYERS.length);
  let expect=0;
  header.layerRanges.forEach(([first,count],l)=>{
    assert.equal(first,expect,`${name}: layer ranges contiguous`); expect+=count;
    for(let i=first;i<first+count;i++){
      const o=i*6;
      assert.equal(rects[o+4]&255,l,`${name}: rect ${i} sorted by layer`);
      assert.ok(rects[o]>=-8&&rects[o+1]>=-8&&rects[o]+rects[o+2]<=W+8&&rects[o+1]+rects[o+3]<=H+8,`${name}: rect ${i} inside die`);
      assert.ok(rects[o+5]<c.netNames.length,`${name}: rect ${i} net id`);
    }
  });
  assert.equal(expect,n);
  assert.equal(header.stats.transistors,c.devices.length);
  assert.equal(header.stats.failedNets,0,`${name}: all nets routed`);
  assert.equal(Math.abs(header.size[0]-header.size[1]),0,`${name}: square die`);
}
for(const f of ['inverter','fulladder','memory','counter4']){
  const src=read(`examples/${f}.fetl`), c=elaborate(parseFetLoom(src),'main');
  const die=buildDie(c,{key:layoutKey(src,'main')});
  checkDie(f,c,die);
  const again=buildDie(elaborate(parseFetLoom(src),'main'),{key:layoutKey(src,'main')});
  assert.deepEqual(again.rects,die.rects,`${f}: deterministic layout`);
  const round=decodeDie(encodeDie(die));
  assert.deepEqual(round.rects,die.rects); assert.equal(round.header.key,die.header.key);
  console.log(`${f}: die ${die.header.grid.join('x')} cells, ${die.header.stats.rects} rects, ${die.header.stats.overflowCells} conflicts, ${die.header.stats.tunedNets} length-matched`);
}
{
  const c=elaborate(parseFetLoom(read('examples/memory.fetl')),'main');
  assert.ok(buildDie(c).header.stats.tunedNets>0,'bus nets are length matched');
  assert.notEqual(layoutKey('module main(a -> y) {}','main'),layoutKey('module main(a -> y) { }','main'),'cache key depends on source');
}

// prebuilt layout cache must match the current examples
{
  const manifest=JSON.parse(read('layouts/manifest.json'));
  for(const {file} of EXAMPLES){
    const src=read(file), key=layoutKey(src,'main'), e=manifest.entries[key];
    assert.ok(e,`${file}: prebuilt layout is stale or missing (run npm run layouts)`);
    const die=decodeDie(zlib.gunzipSync(fs.readFileSync(new URL(`layouts/${e.file}`,root))));
    const c=elaborate(parseFetLoom(src),'main');
    assert.equal(die.header.key,key); assert.equal(die.header.stats.nets,c.netNames.length);
    checkDie(file,c,die);
  }
}

// schematic layout: independent of the die, nested boxes, buses as single thick lines
{
  for(const f of ['inverter','fulladder','memory','counter4','td4']){
    const src=read(`examples/${f}.fetl`), c=elaborate(parseFetLoom(src),'main');
    const sch=buildSchematic(c,{key:schematicKey(src,'main')}), {header,rects}=sch;
    assert.equal(header.layerRanges.length,SCH_LAYERS.length);
    assert.equal(header.stats.conflicts,0,`${f}: schematic wires do not overlap`);
    const n=c.netNames.length;
    for(let i=0;i<rects.length;i+=6){ const id=rects[i+5]; assert.ok(id<n+header.groups.length,`${f}: net id in range`); }
    // sibling boxes never overlap
    const boxes=header.boxes;
    const kids=new Map();
    for(const b of boxes){ const parent=b.p.slice(0,b.p.lastIndexOf('/')); if(!kids.has(parent))kids.set(parent,[]); kids.get(parent).push(b); }
    for(const list of kids.values()) for(let i=0;i<list.length;i++) for(let j=i+1;j<list.length;j++){
      const [a,b]=[list[i].r,list[j].r];
      assert.ok(a[0]+a[2]<=b[0]||b[0]+b[2]<=a[0]||a[1]+a[3]<=b[1]||b[1]+b[3]<=a[1],`${f}: ${list[i].p} overlaps ${list[j].p}`);
    }
    assert.deepEqual(buildSchematic(elaborate(parseFetLoom(src),'main')).rects,rects,`${f}: deterministic schematic`);
    console.log(`${f}: schematic ${header.size.join('x')}, ${header.stats.rects} rects, ${header.groups.length} bundles`);
  }
  const c=elaborate(parseFetLoom(read('examples/td4.fetl')),'main'), sch=buildSchematic(c);
  const pc=sch.header.groups.find(g=>g.l==='main.pc[4]');
  assert.ok(pc&&pc.bits.length===4,'td4: pc[4] is one bundle');
  assert.ok(sch.header.boxes.some(b=>b.m==='reg4e')&&sch.header.boxes.some(b=>b.m==='td4_decode'),'td4: module boxes');
  assert.equal(busValue(pc,()=>1),1); assert.equal(busValue(pc,n=>n===pc.bits[0]?1:0),4);
  assert.equal(busText(pc,n=>n===pc.bits[1]?1:0),'0x2');
  const keyA=schematicKey('module main(a -> y) {}','main');
  assert.notEqual(keyA,layoutKey('module main(a -> y) {}','main'),'schematic and die keys differ');
}

// prebuilt schematic cache must match too
{
  const manifest=JSON.parse(read('layouts/manifest.json'));
  for(const {file} of EXAMPLES){
    const src=read(file), e=manifest.entries[schematicKey(src,'main')];
    assert.ok(e&&e.kind==='sch',`${file}: prebuilt schematic is stale or missing (run npm run layouts)`);
    const sch=decodeDie(zlib.gunzipSync(fs.readFileSync(new URL(`layouts/${e.file}`,root))));
    assert.equal(sch.header.format,'fetloom-sch');
    assert.equal(sch.header.stats.nets,elaborate(parseFetLoom(src),'main').netNames.length);
  }
}

console.log('all tests passed');
