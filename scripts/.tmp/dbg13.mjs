import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';
const PORT = 9339;
class Cdp { constructor(ws){this.ws=ws;this.id=0;this.pending=new Map();
  ws.addEventListener('message',ev=>{const m=JSON.parse(ev.data); if(m.id&&this.pending.has(m.id)){this.pending.get(m.id)(m);this.pending.delete(m.id);}});}
  send(method,params={}){const id=++this.id;this.ws.send(JSON.stringify({id,method,params}));return new Promise(r=>this.pending.set(id,r));}
  async eval(e){const r=await this.send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true});
    if(r.result.exceptionDetails) console.log('ERR', r.result.exceptionDetails.exception?.description?.slice(0,200)); return r.result.result.value;}}
const chrome=spawn('chromium-browser',['--headless=new','--no-sandbox',`--remote-debugging-port=${PORT}`,'about:blank']);
await sleep(1200);
const list=await(await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const ws=new WebSocket(list.find(t=>t.type==='page').webSocketDebuggerUrl);
await new Promise(r=>ws.addEventListener('open',r));
const cdp=new Cdp(ws);
await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
await cdp.send('Page.navigate',{url:'http://127.0.0.1:8090/'});
await sleep(2500);
console.log(await cdp.eval(`(() => {
  const sc = window.__emu.schematic;
  for (const k of [...sc.components.keys()]) sc.components.delete(k);
  sc.wires.clear();
  sc.addBoard('wemos-d1-mini', 60, 60, 'b1');
  const q1 = sc.add('transistor', 460, 140, { polarity: 'npn' }).id;
  const d1 = sc.add('diode', 460, 420, {}).id;
  window.__bench = { q1, d1 };
  const sc2 = (()=>{ const p = sc.pinWorld({comp:q1,pin:'b'}); const q = window.__emu.viewport.worldToScreen(p.x+10,p.y); const cv=document.querySelector('.canvas-host canvas'); const r=cv.getBoundingClientRect();
    return { p, q, rect:{l:r.left,t:r.top,w:r.width,h:r.height}, cvw:cv.width, cvh:cv.height, dpr:window.devicePixelRatio }; })();
  return JSON.stringify(sc2);
})()`));
await sleep(500);
// dump a strip of pixels along y of the base lead
console.log(await cdp.eval(`(() => {
  const cv = document.querySelector('.canvas-host canvas');
  const ctx = cv.getContext('2d');
  const p = window.__emu.schematic.pinWorld({ comp: window.__bench.q1, pin: 'b' });
  const q = window.__emu.viewport.worldToScreen(p.x + 10, p.y);
  const out = [];
  for (let dx = -10; dx <= 10; dx++) { const px = ctx.getImageData(Math.round(q.x)+dx, Math.round(q.y), 1, 1).data; out.push(px[0]+','+px[1]+','+px[2]+','+px[3]); }
  return JSON.stringify({q, out});
})()`));
chrome.kill('SIGKILL'); process.exit(0);
