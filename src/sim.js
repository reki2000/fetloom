export const LOGIC = Object.freeze({ZERO:0, ONE:1, Z:2, X:3});
export const logicChar = v => ['0','1','Z','X'][v] ?? '?';

async function loadHex(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ROM load failed: ${url} (${res.status})`);
  const text = await res.text();
  const bytes=[];
  for (const line of text.split(/\r?\n/)) {
    const clean=line.replace(/#.*/,'').replace(/\/\/.*/,'').trim();
    if(!clean) continue;
    for(const tok of clean.split(/[\s,]+/)) {
      if(!tok) continue;
      const v=parseInt(tok.replace(/^0x/i,''),16);
      if(Number.isNaN(v)||v<0||v>255) throw new Error(`bad ROM byte '${tok}' in ${url}`);
      bytes.push(v);
    }
  }
  return Uint8Array.from(bytes);
}

function bitsToInt(nets,getValue) {
  let v=0;
  for(let i=0;i<nets.length;i++) if(getValue(nets[i])===1) v |= (1<<i);
  return v >>> 0;
}
function intToBits(v,nets,drive) { for(let i=0;i<nets.length;i++) drive(nets[i],(v>>i)&1); }

export class FetLoomSimulator {
  constructor(circuit, wasmExports) {
    this.circuit=circuit;
    this.w=wasmExports;
    this.tickCount=0;
    this.inputs=new Map();
    this.probes=[];
    this.trace=new Map();
    this.maxTrace=512;
    this.romData=new Map();
    this.ramState=[];
    this.clockLast=new Map();
    this.lastChanged=[];
    if(!this.w.init_core(circuit.netNames.length,circuit.devices.length)) throw new Error('circuit exceeds WASM limits');
    circuit.devices.forEach((d,i)=>this.w.set_device(i,d.type==='Nmos'?0:1,d.gate,d.a,d.b));
    circuit.caps.forEach(n=>this.w.set_cap(n,1));
    for (const p of circuit.topInputs) for(const n of p.nets) this.inputs.set(n,0);
    this.ramState=circuit.rams.map(r=>({mem:new Uint32Array(Math.max(1,1<<Math.min(20,r.addrNets.length))),lastClk:0}));
  }

  async loadMemories() {
    for(const r of this.circuit.roms) {
      if(!this.romData.has(r.file)) this.romData.set(r.file,await loadHex(r.file));
    }
  }

  setInputNet(net,val){ this.inputs.set(net,val); }
  setInputPort(name,value){
    const p=this.circuit.topInputs.find(x=>x.name===name); if(!p) throw new Error(`input ${name} not found`);
    for(let i=0;i<p.nets.length;i++) this.inputs.set(p.nets[i],(value>>i)&1);
  }
  getValue(net){ return this.w.get_value(net); }
  getBus(nets){ return bitsToInt(nets,n=>this.getValue(n)); }
  reset(){
    this.w.init_core(this.circuit.netNames.length,this.circuit.devices.length);
    this.circuit.devices.forEach((d,i)=>this.w.set_device(i,d.type==='Nmos'?0:1,d.gate,d.a,d.b));
    this.circuit.caps.forEach(n=>this.w.set_cap(n,1));
    this.tickCount=0; this.trace.clear(); this.clockLast.clear();
    for(const rs of this.ramState){rs.mem.fill(0);rs.lastClk=0;}
    this.step();
  }
  addProbe(net){ if(!this.probes.includes(net)){this.probes.push(net);this.trace.set(net,[]);} }
  removeProbe(net){this.probes=this.probes.filter(n=>n!==net);this.trace.delete(net);}
  toggleProbe(net){this.probes.includes(net)?this.removeProbe(net):this.addProbe(net);}

  _driveSpecial() {
    const w=this.w; w.clear_drives(); w.drive(0,1); w.drive(1,0);
    for(const [n,v] of this.inputs) w.drive(n,v);
    for(const c of this.circuit.clocks) {
      const v=(Math.floor(this.tickCount/c.period)&1); w.drive(c.net,v);
    }
    for(const r of this.circuit.roms) {
      const mem=this.romData.get(r.file) || new Uint8Array(0);
      const addr=bitsToInt(r.addrNets,n=>w.get_value(n));
      const val=addr<mem.length?mem[addr]:0;
      intToBits(val,r.dataNets,(n,v)=>w.drive(n,v));
    }
    this.circuit.rams.forEach((r,idx)=>{
      const st=this.ramState[idx]; const addr=bitsToInt(r.addrNets,n=>w.get_value(n)) % st.mem.length;
      intToBits(st.mem[addr],r.doutNets,(n,v)=>w.drive(n,v));
    });
  }

  step() {
    this._driveSpecial();
    this.w.solve();
    this.circuit.rams.forEach((r,idx)=>{
      const st=this.ramState[idx]; const clk=this.w.get_value(r.clk)===1?1:0;
      if(!st.lastClk && clk && this.w.get_value(r.we)===1) {
        const addr=bitsToInt(r.addrNets,n=>this.w.get_value(n)) % st.mem.length;
        st.mem[addr]=bitsToInt(r.dinNets,n=>this.w.get_value(n));
      }
      st.lastClk=clk;
    });
    const count=this.w.get_changed_count(); this.lastChanged=[];
    for(let i=0;i<count;i++) this.lastChanged.push([this.w.get_changed_net(i),this.w.get_changed_value(i)]);
    for(const n of this.probes){
      let a=this.trace.get(n); if(!a){a=[];this.trace.set(n,a);} a.push(this.w.get_value(n)); if(a.length>this.maxTrace)a.shift();
    }
    this.tickCount++;
    return this.lastChanged;
  }
}

export async function loadWasm(url='wasm/fetloom_core.wasm') {
  const res=await fetch(url); if(!res.ok) throw new Error(`cannot load ${url}`);
  const bytes=await res.arrayBuffer();
  const {instance}=await WebAssembly.instantiate(bytes,{});
  return instance.exports;
}
