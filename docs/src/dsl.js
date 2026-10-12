const BUILTINS = new Set(['Nmos','Pmos','Cap','Clk','Rom','Ram']);

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/#.*$/gm, '');
}

function tokenize(src) {
  src = stripComments(src);
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (src.startsWith('->', i)) { out.push({t:'sym',v:'->'}); i += 2; continue; }
    if ('(){}[],;'.includes(c)) { out.push({t:'sym',v:c}); i++; continue; }
    if (c === '"') {
      let j = i + 1, s = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const n = src[j+1];
          s += n === 'n' ? '\n' : n === 't' ? '\t' : n;
          j += 2;
        } else { s += src[j++]; }
      }
      if (j >= src.length) throw new Error('unterminated string literal');
      out.push({t:'str',v:s}); i = j + 1; continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1; while (j < src.length && /[0-9A-Fa-f_xX]/.test(src[j])) j++;
      const raw = src.slice(i,j).replaceAll('_','');
      let v;
      if (/^0x/i.test(raw)) v = parseInt(raw,16); else v = parseInt(raw,10);
      if (!Number.isFinite(v)) throw new Error(`bad number ${raw}`);
      out.push({t:'num',v}); i=j; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1; while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      out.push({t:'id',v:src.slice(i,j)}); i=j; continue;
    }
    throw new Error(`unexpected character '${c}' at ${i}`);
  }
  out.push({t:'eof',v:''});
  return out;
}

export function parseFetLoom(source) {
  const toks = tokenize(source); let p = 0;
  const peek = () => toks[p];
  const eat = (v) => {
    const x = toks[p];
    if (v && x.v !== v) throw new Error(`expected '${v}', got '${x.v}'`);
    p++; return x;
  };
  const needId = () => { const x=eat(); if(x.t!=='id') throw new Error(`expected identifier, got '${x.v}'`); return x.v; };

  function portDecl() {
    const name = needId(); let width = 1;
    if (peek().v === '[') { eat('['); width = eat().v; if (!Number.isInteger(width) || width < 1) throw new Error('bus width must be >= 1'); eat(']'); }
    return {name,width};
  }
  function portList(untilArrowOrParen=false) {
    const a=[];
    while (peek().v !== ')' && (!untilArrowOrParen || peek().v !== '->')) {
      a.push(portDecl());
      if (peek().v === ',') eat(','); else break;
    }
    return a;
  }
  function arg() {
    const x = peek();
    if (x.t === 'str') return {kind:'string', value:eat().v};
    if (x.t === 'num') return {kind:'number', value:eat().v};
    if (x.t !== 'id') throw new Error(`expected signal/string/number, got '${x.v}'`);
    const name = eat().v; let index = null;
    if (peek().v === '[') { eat('['); const n=eat(); if(n.t!=='num') throw new Error('only numeric bit indexes are supported'); index=n.v; eat(']'); }
    return {kind:'signal', name, index};
  }
  function statement() {
    const callee = needId();
    eat('('); const args=[];
    while (peek().v !== ')') { args.push(arg()); if(peek().v===',') eat(','); else break; }
    eat(')'); if (peek().v === ';') eat(';');
    return {type:'call', callee, args};
  }
  const modules = new Map();
  while (peek().t !== 'eof') {
    const kw = needId(); if (kw !== 'module') throw new Error(`expected module, got ${kw}`);
    const name = needId();
    if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`user module '${name}' must be lowercase/snake_case`);
    eat('('); const inputs = portList(true); let outputs=[]; if(peek().v==='->'){ eat('->'); outputs=portList(false); } eat(')');
    eat('{'); const body=[]; while(peek().v!=='}') body.push(statement()); eat('}');
    if (modules.has(name)) throw new Error(`duplicate module ${name}`);
    modules.set(name,{name,inputs,outputs,ports:[...inputs,...outputs],body});
  }
  return {modules};
}

function sigWidth(ref, symbols) {
  if (ref.kind !== 'signal') return null;
  if (ref.name === 'Vcc' || ref.name === 'Gnd') return 1;
  const s = symbols.get(ref.name);
  if (!s) return null;
  return ref.index == null ? s.length : 1;
}

export function elaborate(ast, topName) {
  const top = ast.modules.get(topName); if(!top) throw new Error(`top module '${topName}' not found`);
  const netNames = ['Vcc','Gnd'];
  const netMeta = [{path:'Vcc',local:'Vcc'},{path:'Gnd',local:'Gnd'}];
  const nameToNet = new Map([['Vcc',0],['Gnd',1]]);
  const devices=[], caps=new Set(), clocks=[], roms=[], rams=[], hierarchy=[];
  const topInputs=[], topOutputs=[];
  let autoId=0;
  const newNet = (name, meta={}) => { const id=netNames.length; netNames.push(name); netMeta.push({path:name,...meta}); nameToNet.set(name,id); return id; };
  const allocBus = (path,name,width,meta={}) => Array.from({length:width},(_,i)=>newNet(width===1?`${path}.${name}`:`${path}.${name}[${i}]`,{modulePath:path,local:name,index:i,width,...meta}));

  function makeSymbols(mod,path,bindings,isTop=false) {
    const sy = new Map();
    for (const port of mod.ports) {
      let nets = bindings?.get(port.name);
      if (!nets) nets = allocBus(path,port.name,port.width,{port:true});
      if (nets.length !== port.width) throw new Error(`${path}.${port.name}: width ${nets.length}, expected ${port.width}`);
      sy.set(port.name,nets);
      if (isTop) {
        const rec={name:port.name,width:port.width,nets};
        if(mod.inputs.some(x=>x.name===port.name)) topInputs.push(rec); else topOutputs.push(rec);
      }
    }
    return sy;
  }

  function ensureLocal(ref, symbols, path, expectedWidth) {
    if (ref.name === 'Vcc') return [0]; if (ref.name === 'Gnd') return [1];
    let nets = symbols.get(ref.name);
    if (!nets) {
      if (!ref.name.startsWith('_')) throw new Error(`${path}: unknown symbol '${ref.name}'. Local wires must start with '_'`);
      const width = expectedWidth ?? (ref.index != null ? ref.index+1 : 1);
      nets = allocBus(path,ref.name,width,{localWire:true}); symbols.set(ref.name,nets);
    } else if (expectedWidth && ref.index == null && nets.length !== expectedWidth) {
      if (ref.name.startsWith('_') && nets.length === 1 && netMeta[nets[0]]?.localWire) {
        throw new Error(`${path}: local bus ${ref.name} was inferred as width 1 before width ${expectedWidth}`);
      }
      throw new Error(`${path}: width mismatch on ${ref.name}: ${nets.length} vs ${expectedWidth}`);
    }
    if (ref.index != null) {
      if (ref.index >= nets.length) {
        if (ref.name.startsWith('_')) {
          while (nets.length <= ref.index) nets.push(newNet(`${path}.${ref.name}[${nets.length}]`,{modulePath:path,local:ref.name,index:nets.length,localWire:true}));
        } else throw new Error(`${path}: bit ${ref.name}[${ref.index}] out of range`);
      }
      return [nets[ref.index]];
    }
    return nets;
  }

  function resolveSignal(ref, symbols, path, expectedWidth) {
    if (ref.kind !== 'signal') throw new Error(`${path}: expected signal`);
    return ensureLocal(ref,symbols,path,expectedWidth);
  }

  function childRec(parentPath, path, type, label, inputs, outputs, extra={}) {
    hierarchy.push({id:autoId++,parentPath,path,type,label,inputs:[...new Set(inputs)],outputs:[...new Set(outputs)],...extra});
  }

  function expandModule(mod,path,bindings=null,isTop=false) {
    const symbols=makeSymbols(mod,path,bindings,isTop);
    let seq=0;
    for (const st of mod.body) {
      const c=st.callee, childPath=`${path}/${c}#${seq++}`;
      if (c==='Nmos' || c==='Pmos') {
        if(st.args.length!==3) throw new Error(`${childPath}: ${c} expects 3 args`);
        const g=resolveSignal(st.args[0],symbols,path,1)[0], a=resolveSignal(st.args[1],symbols,path,1)[0], b=resolveSignal(st.args[2],symbols,path,1)[0];
        devices.push({type:c,gate:g,a,b,path:childPath,parentPath:path});
        childRec(path,childPath,c,c,[g,a],[b],{builtin:true,nets:[g,a,b]});
      } else if (c==='Cap') {
        if(st.args.length!==1) throw new Error(`${childPath}: Cap expects 1 arg`);
        const n=resolveSignal(st.args[0],symbols,path,1)[0]; caps.add(n); childRec(path,childPath,c,c,[n],[n],{builtin:true,nets:[n]});
      } else if (c==='Clk') {
        if(st.args.length!==2 || st.args[0].kind!=='number') throw new Error(`${childPath}: Clk(periodTicks, out)`);
        const n=resolveSignal(st.args[1],symbols,path,1)[0]; clocks.push({period:Math.max(1,st.args[0].value),net:n,path:childPath});
        childRec(path,childPath,c,`Clk/${Math.max(1,st.args[0].value)}` ,[],[n],{builtin:true,nets:[n]});
      } else if (c==='Rom') {
        if(st.args.length!==3 || st.args[0].kind!=='string') throw new Error(`${childPath}: Rom("file.hex", addr, data)`);
        const addr=resolveSignal(st.args[1],symbols,path,null), data=resolveSignal(st.args[2],symbols,path,null);
        roms.push({file:st.args[0].value,addrNets:addr,dataNets:data,path:childPath});
        childRec(path,childPath,c,`Rom ${st.args[0].value}` ,addr,data,{builtin:true,nets:[...addr,...data]});
      } else if (c==='Ram') {
        if(st.args.length!==5) throw new Error(`${childPath}: Ram(addr, din, dout, we, clk)`);
        const addr=resolveSignal(st.args[0],symbols,path,null), din=resolveSignal(st.args[1],symbols,path,null), dout=resolveSignal(st.args[2],symbols,path,din.length), we=resolveSignal(st.args[3],symbols,path,1)[0], clk=resolveSignal(st.args[4],symbols,path,1)[0];
        rams.push({addrNets:addr,dinNets:din,doutNets:dout,we,clk,path:childPath});
        childRec(path,childPath,c,'Ram',[...addr,...din,we,clk],dout,{builtin:true,nets:[...addr,...din,...dout,we,clk]});
      } else {
        if (/^[A-Z]/.test(c)) throw new Error(`${childPath}: unknown builtin '${c}'`);
        const child=ast.modules.get(c); if(!child) throw new Error(`${childPath}: unknown module '${c}'`);
        if(st.args.length!==child.ports.length) throw new Error(`${childPath}: ${c} expects ${child.ports.length} args, got ${st.args.length}`);
        const b=new Map(), ins=[], outs=[], ports=[];
        child.ports.forEach((port,idx)=>{
          const nets=resolveSignal(st.args[idx],symbols,path,port.width); b.set(port.name,nets);
          const input=child.inputs.some(x=>x.name===port.name);
          if(input) ins.push(...nets); else outs.push(...nets);
          ports.push({name:port.name,dir:input?'in':'out',nets:[...nets]});
        });
        childRec(path,childPath,'module',c,ins,outs,{moduleName:c,builtin:false,nets:[...ins,...outs],ports});
        expandModule(child,childPath,b,false);
      }
    }
  }

  expandModule(top,topName,null,true);
  return {topName,netNames,netMeta,devices,caps:[...caps],clocks,roms,rams,hierarchy,topInputs,topOutputs,nameToNet,ast};
}

export function listModules(ast) { return [...ast.modules.keys()]; }
export {BUILTINS};
