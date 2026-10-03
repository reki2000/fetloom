import {parseFetLoom, elaborate, listModules} from './dsl.js';
import {loadWasm, FetLoomSimulator, logicChar} from './sim.js';
import {availableViews, makeLayout, renderSvg} from './layout.js';
import {EXAMPLES} from './examples.js';
import {DieView} from './die-view.js';
import {obtainDie, cancelDie} from './die-cache.js';

const $=s=>document.querySelector(s);
const els={source:$('#source'),example:$('#example'),loadExample:$('#loadExample'),file:$('#file'),compile:$('#compile'),top:$('#topModule'),errors:$('#errors'),status:$('#status'),inputs:$('#inputs'),reset:$('#reset'),step:$('#step'),run:$('#run'),speed:$('#speed'),tick:$('#tick'),view:$('#view'),schematic:$('#schematic'),probeSearch:$('#probeSearch'),probeNet:$('#probeNet'),addProbe:$('#addProbe'),clearProbe:$('#clearProbe'),probeLabels:$('#probeLabels'),wave:$('#wave'),tabSchematic:$('#tabSchematic'),tabDie:$('#tabDie'),die:$('#die'),viewHint:$('#viewHint')};
for(const {name,file} of EXAMPLES){const o=document.createElement('option');o.value=file;o.textContent=name;els.example.append(o);}
let wasm,ast,circuit,sim,running=false,raf=0,currentView='',tab='schematic',dieView=null,dieFor=null,compiledSource='';

function err(e){els.errors.textContent=e?String(e.stack||e):'';if(e)els.status.textContent='error';}
async function loadText(url){const r=await fetch(url);if(!r.ok)throw new Error(`${url}: ${r.status}`);return r.text();}
async function loadExample(){try{els.source.value=await loadText(els.example.value);err();refreshModuleChoices();}catch(e){err(e)}}
function refreshModuleChoices(){try{const a=parseFetLoom(els.source.value);const names=listModules(a);els.top.innerHTML='';for(const n of names){const o=document.createElement('option');o.value=n;o.textContent=n;els.top.append(o);}const pref=names.includes('main')?'main':names[names.length-1];if(pref)els.top.value=pref;}catch(e){/* compile shows it */}}

async function compile(){
  try{
    running=false;els.run.textContent='Run';err();ast=parseFetLoom(els.source.value);
    const top=els.top.value||listModules(ast).at(-1); circuit=elaborate(ast,top); compiledSource=els.source.value; dieFor=null; cancelDie(); sim=new FetLoomSimulator(circuit,wasm); await sim.loadMemories(); sim.reset();
    buildInputs();buildViewSelect();buildProbeSelect();drawAll();if(tab==='die')loadDie();els.status.textContent=`${circuit.netNames.length} nets / ${circuit.devices.length} MOS`; 
  }catch(e){err(e)}
}
function buildInputs(){els.inputs.innerHTML='';for(const p of circuit.topInputs){const d=document.createElement('label');d.className='input-chip';d.textContent=p.name+(p.width>1?`[${p.width}]`:'');const inp=document.createElement('input');inp.type=p.width===1?'checkbox':'number';if(p.width>1){inp.min=0;inp.max=(2**Math.min(p.width,30))-1;inp.value=0;}inp.addEventListener('input',()=>{const v=p.width===1?(inp.checked?1:0):Number(inp.value)||0;sim.setInputPort(p.name,v);sim.step();drawAll();});d.append(inp);els.inputs.append(d)}}
function buildViewSelect(){els.view.innerHTML='';for(const v of availableViews(circuit)){const o=document.createElement('option');o.value=v;o.textContent=v;els.view.append(o);}currentView=circuit.topName;els.view.value=currentView;}
function buildProbeSelect(){const q=els.probeSearch.value.toLowerCase();els.probeNet.innerHTML='';circuit.netNames.forEach((n,i)=>{if(!q||n.toLowerCase().includes(q)){const o=document.createElement('option');o.value=i;o.textContent=n;els.probeNet.append(o);}})}
function drawSchematic(){if(!sim)return;const lay=makeLayout(circuit,currentView,1100,650);renderSvg(els.schematic,circuit,lay,n=>sim.getValue(n),n=>{sim.toggleProbe(n);drawProbe();},p=>{currentView=p;if(![...els.view.options].some(o=>o.value===p)){const o=document.createElement('option');o.value=p;o.textContent=p;els.view.append(o);}els.view.value=p;drawSchematic();});}
function drawProbe(){if(!sim)return;els.probeLabels.innerHTML='';for(const n of sim.probes){const d=document.createElement('span');d.className='probe-row';d.textContent=`${circuit.netNames[n]}=${logicChar(sim.getValue(n))}`;const b=document.createElement('button');b.textContent='×';b.addEventListener('click',()=>{sim.removeProbe(n);drawProbe();});d.append(b);els.probeLabels.append(d);}drawWave();}
function drawWave(){const c=els.wave,ctx=c.getContext('2d');const w=c.width,h=c.height;ctx.clearRect(0,0,w,h);ctx.fillStyle='#0f141a';ctx.fillRect(0,0,w,h);ctx.font='14px ui-monospace';ctx.textBaseline='middle';const rows=Math.max(1,sim.probes.length),rh=h/rows;const left=180;for(let r=0;r<sim.probes.length;r++){const n=sim.probes[r],a=sim.trace.get(n)||[],y0=r*rh;ctx.fillStyle='#cbd5df';ctx.fillText(circuit.netNames[n].slice(-24),8,y0+rh/2);ctx.strokeStyle='#303944';ctx.beginPath();ctx.moveTo(left,y0+rh-1);ctx.lineTo(w,y0+rh-1);ctx.stroke();if(!a.length)continue;const dx=(w-left)/Math.max(1,sim.maxTrace-1);let last=null;ctx.lineWidth=2;for(let i=0;i<a.length;i++){const v=a[i];let y=v===1?y0+rh*.25:v===0?y0+rh*.75:y0+rh*.5;ctx.strokeStyle=v===1?'#ff735d':v===0?'#aeb8c3':v===3?'#e57bea':'#727b86';if(last===null){ctx.beginPath();ctx.moveTo(left+i*dx,y);}else{ctx.lineTo(left+i*dx,last);ctx.lineTo(left+i*dx,y);}last=y;}ctx.stroke();}}
function drawAll(){if(!sim)return;els.tick.textContent=`tick ${sim.tickCount}`;if(tab==='die')dieView?.render();else drawSchematic();drawProbe();}

// ---- die layout view
function ensureDieView(){
  if(!dieView) dieView=new DieView(els.die,{onProbe:n=>{sim?.toggleProbe(n);drawProbe();},getNetName:n=>circuit?.netNames[n]??String(n)});
  return dieView;
}
async function loadDie(){
  if(!circuit||dieFor===circuit)return;
  const c=circuit, view=ensureDieView(); dieFor=c;
  view.statusEl.textContent='preparing layout…';
  try{
    const {die,from}=await obtainDie(compiledSource,c.topName,{onStatus:m=>{if(dieFor===c)view.statusEl.textContent=m;}});
    if(dieFor!==c)return;
    if(die.header.stats.nets!==c.netNames.length) throw new Error('cached layout does not match the compiled circuit');
    const st=die.header.stats;
    view.setDie(die,`${from} · ${st.transistors} MOS · ${st.hardBlocks} blocks · wire ${st.wirelength} tracks · ${st.tunedNets} length-matched nets`+(st.overflowCells?` · ${st.overflowCells} congested cells`:''));
    view.setValueSource(n=>sim?sim.getValue(n):2);
    if(currentView&&currentView!==c.topName)view.zoomToPath(currentView);
  }catch(e){if(dieFor===c){dieFor=null;view.statusEl.textContent='layout failed';err(e);}}
}
function setTab(t){
  tab=t; els.tabSchematic.classList.toggle('active',t==='schematic'); els.tabDie.classList.toggle('active',t==='die');
  els.schematic.hidden=t!=='schematic'; els.die.hidden=t!=='die';
  els.viewHint.textContent=t==='die'?'wheel: zoom · drag: pan · double-click: zoom to block · click a wire: probe':'double-click a module to drill in; click a wire/port to probe';
  if(t==='die'){ensureDieView();loadDie();dieView.render();} else drawSchematic();
}
els.tabSchematic.addEventListener('click',()=>setTab('schematic'));els.tabDie.addEventListener('click',()=>setTab('die'));
function animate(){if(!running)return;const n=Math.max(1,Math.min(1000,Number(els.speed.value)||1));for(let i=0;i<n;i++)sim.step();drawAll();raf=requestAnimationFrame(animate);}

els.loadExample.addEventListener('click',loadExample);els.example.addEventListener('change',loadExample);els.source.addEventListener('input',refreshModuleChoices);els.compile.addEventListener('click',compile);els.top.addEventListener('change',compile);els.file.addEventListener('change',async()=>{const f=els.file.files[0];if(f){els.source.value=await f.text();refreshModuleChoices();}});els.reset.addEventListener('click',()=>{if(sim){sim.reset();drawAll();}});els.step.addEventListener('click',()=>{if(sim){sim.step();drawAll();}});els.run.addEventListener('click',()=>{if(!sim)return;running=!running;els.run.textContent=running?'Pause':'Run';if(running)animate();else cancelAnimationFrame(raf);});els.view.addEventListener('change',()=>{currentView=els.view.value;if(tab==='die')dieView?.zoomToPath(currentView);else drawSchematic();});els.probeSearch.addEventListener('input',buildProbeSelect);els.addProbe.addEventListener('click',()=>{if(sim&&els.probeNet.value!==''){sim.addProbe(Number(els.probeNet.value));drawProbe();}});els.clearProbe.addEventListener('click',()=>{if(sim){for(const n of [...sim.probes])sim.removeProbe(n);drawProbe();}});

try{wasm=await loadWasm();els.status.textContent='WASM ready';await loadExample();refreshModuleChoices();await compile();}catch(e){err(e)}
// handle for debugging from the browser console
window.fetloom={get circuit(){return circuit},get sim(){return sim},get dieView(){return dieView}};
