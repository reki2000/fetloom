// Group members are ordered least-significant bit first.
export function resolveProbeNets(circuit, expression) {
  const tokens=expression.split(',').map(s=>s.trim()).filter(Boolean);
  if(!tokens.length) throw new Error('Enter wire names or a bus such as main.q[*].');
  const nets=[];
  for(const token of tokens){
    let matches=[];
    if(token.endsWith('[*]')){
      const prefix=token.slice(0,-3)+'[';
      matches=circuit.netNames.map((name,id)=>({name,id})).filter(({name})=>name.startsWith(prefix)&&/^\d+\]$/.test(name.slice(prefix.length)))
        .sort((a,b)=>Number(a.name.slice(prefix.length,-1))-Number(b.name.slice(prefix.length,-1))).map(x=>x.id);
    }else if(circuit.nameToNet.has(token)) matches=[circuit.nameToNet.get(token)];
    if(!matches.length) throw new Error(`Wire or bus not found: ${token}`);
    for(const net of matches) if(!nets.includes(net)) nets.push(net);
  }
  return nets;
}

export function formatProbeValue(nets, getValue, base='hex') {
  const bits=nets.map(getValue).reverse();
  const binary=bits.map(v=>['0','1','Z','X'][v]??'X').join('');
  if(base==='bin') return '0b'+binary;
  if(bits.some(v=>v!==0&&v!==1)) return binary.includes('X')?'X':'Z';
  const value=BigInt('0b'+binary);
  if(base==='dec') return value.toString(10);
  return '0x'+value.toString(16).toUpperCase().padStart(Math.ceil(nets.length/4),'0');
}

export function initializeDemo(sim, preset) {
  for(const [name,value] of Object.entries(preset?.inputs??{})) if(sim.circuit.topInputs.some(p=>p.name===name))sim.setInputPort(name,value);
  const resetTicks=sim.circuit.topInputs.some(p=>p.name==='reset')?(preset?.resetTicks??0):0;
  if(resetTicks) sim.setInputPort('reset',1);
  sim.reset();
  if(resetTicks){
    for(let i=1;i<resetTicks;i++) sim.step();
    sim.setInputPort('reset',0);
    sim.step();
  }
}
