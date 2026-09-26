import fs from 'node:fs';
import assert from 'node:assert/strict';
import {parseFetLoom, elaborate} from '../src/dsl.js';
import {FetLoomSimulator} from '../src/sim.js';

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

for(const f of ['inverter','logic','fulladder','latch','memory','i4004']){
  const ast=parseFetLoom(read(`examples/${f}.fetl`));
  const c=elaborate(ast,'main');
  assert.ok(c.netNames.length>2,`${f}: nets`);
  console.log(`${f}: ${c.netNames.length} nets, ${c.devices.length} MOS`);
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

console.log('all tests passed');
