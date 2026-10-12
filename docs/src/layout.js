function groupBy(arr,fn){const m=new Map();for(const x of arr){const k=fn(x);if(!m.has(k))m.set(k,[]);m.get(k).push(x);}return m;}

export function availableViews(circuit){
  const s=new Set([circuit.topName]);
  for(const h of circuit.hierarchy) {
    if(h.type==='module' && h.path.split('/').length<=4) s.add(h.path);
  }
  return [...s].sort((a,b)=>a.split('/').length-b.split('/').length || a.localeCompare(b));
}

export function makeLayout(circuit,parentPath,width=1100,height=700){
  const children=circuit.hierarchy.filter(h=>h.parentPath===parentPath);
  const topMod = parentPath===circuit.topName ? circuit.ast.modules.get(circuit.topName) : null;
  const externalIns=[], externalOuts=[];
  if(topMod){
    for(const p of circuit.topInputs) for(const n of p.nets) externalIns.push({net:n,label:circuit.netNames[n]});
    for(const p of circuit.topOutputs) for(const n of p.nets) externalOuts.push({net:n,label:circuit.netNames[n]});
  } else {
    const node=circuit.hierarchy.find(h=>h.path===parentPath);
    if(node){
      for(const n of node.inputs) externalIns.push({net:n,label:circuit.netNames[n]});
      for(const n of node.outputs) externalOuts.push({net:n,label:circuit.netNames[n]});
    }
  }
  const producers=new Map();
  children.forEach((c,i)=>c.outputs.forEach(n=>{if(!producers.has(n))producers.set(n,[]);producers.get(n).push(i);}));
  const levels=new Array(children.length).fill(0);
  for(let pass=0;pass<children.length+2;pass++){
    let changed=false;
    children.forEach((c,i)=>{
      let lv=0;
      for(const n of c.inputs){for(const p of producers.get(n)||[]) if(p!==i) lv=Math.max(lv,levels[p]+1);}
      lv=Math.min(lv,12);
      if(lv>levels[i]){levels[i]=lv;changed=true;}
    });
    if(!changed)break;
  }
  const byLevel=groupBy(children.map((c,i)=>({...c,_i:i,_level:levels[i]})),x=>x._level);
  const maxLevel=Math.max(0,...levels);
  const nodes=[];
  for(const [lv,items] of byLevel){
    const x=140 + (maxLevel? Number(lv)*(width-310)/maxLevel : (width-310)/2);
    items.forEach((c,j)=>{
      const y=70+(j+1)*(height-140)/(items.length+1);
      nodes.push({...c,x,y,w:c.type==='module'?140:112,h:c.type==='module'?58:46});
    });
  }
  const ports=[];
  externalIns.forEach((p,i)=>ports.push({...p,kind:'in',x:18,y:55+(i+1)*(height-110)/(externalIns.length+1)}));
  externalOuts.forEach((p,i)=>ports.push({...p,kind:'out',x:width-18,y:55+(i+1)*(height-110)/(externalOuts.length+1)}));
  return {width,height,nodes,ports};
}

function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}

export function renderSvg(container,circuit,layout,getValue,onProbe,onDrill){
  const ns='http://www.w3.org/2000/svg';
  container.innerHTML='';
  const svg=document.createElementNS(ns,'svg');
  svg.setAttribute('viewBox',`0 0 ${layout.width} ${layout.height}`); svg.classList.add('circuit-svg');
  const endpoint=new Map();
  for(const p of layout.ports) endpoint.set(`port:${p.net}:${p.kind}`,{x:p.x,y:p.y});
  for(const n of layout.nodes){
    for(const net of n.inputs){if(!endpoint.has(`in:${net}`))endpoint.set(`in:${net}`,[]);endpoint.get(`in:${net}`).push({x:n.x-n.w/2,y:n.y});}
    for(const net of n.outputs){if(!endpoint.has(`out:${net}`))endpoint.set(`out:${net}`,[]);endpoint.get(`out:${net}`).push({x:n.x+n.w/2,y:n.y});}
  }
  const nets=new Set(); layout.nodes.forEach(n=>[...n.inputs,...n.outputs].forEach(x=>nets.add(x)));layout.ports.forEach(p=>nets.add(p.net));
  for(const net of nets){
    let starts=[...(endpoint.get(`out:${net}`)||[])];
    const pin=layout.ports.find(p=>p.net===net&&p.kind==='in'); if(pin) starts.unshift({x:pin.x,y:pin.y});
    let ends=[...(endpoint.get(`in:${net}`)||[])];
    const pout=layout.ports.find(p=>p.net===net&&p.kind==='out'); if(pout) ends.push({x:pout.x,y:pout.y});
    if(!starts.length&&ends.length) starts=[ends[0]];
    if(starts.length){
      const s=starts[0];
      for(const e of ends){
        if(s.x===e.x&&s.y===e.y)continue;
        const path=document.createElementNS(ns,'path'); const mid=(s.x+e.x)/2;
        path.setAttribute('d',`M ${s.x} ${s.y} H ${mid} V ${e.y} H ${e.x}`);
        path.setAttribute('class',`wire logic-${getValue(net)}`); path.dataset.net=net; path.addEventListener('click',()=>onProbe(net));
        const title=document.createElementNS(ns,'title'); title.textContent=`${circuit.netNames[net]} = ${['0','1','Z','X'][getValue(net)]}`; path.appendChild(title); svg.appendChild(path);
      }
    }
  }
  for(const n of layout.nodes){
    const g=document.createElementNS(ns,'g'); g.classList.add('component');
    const r=document.createElementNS(ns,'rect'); r.setAttribute('x',n.x-n.w/2);r.setAttribute('y',n.y-n.h/2);r.setAttribute('width',n.w);r.setAttribute('height',n.h);r.setAttribute('rx','8');
    const t=document.createElementNS(ns,'text');t.setAttribute('x',n.x);t.setAttribute('y',n.y+4);t.setAttribute('text-anchor','middle');t.textContent=n.label;
    g.append(r,t); if(n.type==='module'){g.classList.add('drillable');g.addEventListener('dblclick',()=>onDrill(n.path));}
    svg.appendChild(g);
  }
  for(const p of layout.ports){
    const c=document.createElementNS(ns,'circle');c.setAttribute('cx',p.x);c.setAttribute('cy',p.y);c.setAttribute('r','5');c.setAttribute('class',`port logic-${getValue(p.net)}`);c.addEventListener('click',()=>onProbe(p.net));svg.appendChild(c);
    const t=document.createElementNS(ns,'text');t.setAttribute('x',p.kind==='in'?p.x+9:p.x-9);t.setAttribute('y',p.y-7);t.setAttribute('text-anchor',p.kind==='in'?'start':'end');t.setAttribute('class','port-label');t.textContent=p.label.split('.').pop();svg.appendChild(t);
  }
  container.appendChild(svg);
}
