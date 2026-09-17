/**
 * Visual demo: wires D4 -> 220R -> LED -> GND, runs blink at 4x, screenshots
 * the canvas mid-blink (LED glow visible). Requires dist/ served on :8090.
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';
import WebSocket from 'ws';

const PORT = 9335;
const chrome = spawn('chromium-browser', ['--headless=new', '--no-sandbox', `--remote-debugging-port=${PORT}`, 'about:blank']);
process.on('exit', () => chrome.kill('SIGKILL'));
let ws;
for (let i = 0; i < 40; i++) {
  try {
    const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const p = l.find((t) => t.type === 'page');
    if (p) { ws = new WebSocket(p.webSocketDebuggerUrl, { perMessageDeflate: false }); await new Promise((r, j) => (ws.once('open', r), ws.once('error', j))); break; }
  } catch { /* retry */ }
  await sleep(250);
}
let id = 0; const pending = new Map();
ws.on('message', (b) => { const m = JSON.parse(b); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true }); if (r.error) throw new Error(JSON.stringify(r.error)); const res = r.result; if (res?.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails)); return res?.result?.value; };
await send('Runtime.enable'); await send('Page.enable');
await send('Page.navigate', { url: 'http://127.0.0.1:8090/' });
await sleep(2200);
await ev(`(() => {
  const { schematic: s } = window.__emu;
  const r = s.add('resistor', 320, 120, { resistance: 220 });
  const led = s.add('led', 320, 60, { forwardV: 2, color: 'red' });
  s.wire({ comp: 'board', pin: 'D4' }, { comp: 'board', pin: '5V' }.__proto__ && { comp: r.id, pin: 'p1' });
  s.wire({ comp: r.id, pin: 'p2' }, { comp: led.id, pin: 'a' });
  s.wire({ comp: led.id, pin: 'k' }, { comp: 'board', pin: 'GND' });
  s.syncNetlist(window.__emu.machine.netlist);
  return true;
})()`);
await ev(`window.__emu.setSketch(${JSON.stringify(`void setup(){ pinMode(D4, OUTPUT); } void loop(){ digitalWrite(D4, HIGH); delay(500); digitalWrite(D4, LOW); delay(500); }`)}); true`);
await sleep(300);
await ev(`(()=>{ const sel=[...document.querySelectorAll('.toolbar select')]; sel[1].value='4'; sel[1].dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);
await ev(`document.querySelector('.btn-run').click(); true`);
// grab a frame shortly after an LED-on edge: blink at 4x -> 125ms wall per phase
for (let i = 0; i < 20; i++) {
  const on = await ev(`!!window.__emu.machine.circuit().leds.get([...window.__emu.schematic.components.values()].find(c=>c.type==='led').id)?.on`);
  if (on) break;
  await sleep(60);
}
const shot = await send('Page.captureScreenshot', { format: 'png' });
if (!shot || !shot.result) { console.error('screenshot failed:', JSON.stringify(shot)); process.exit(1); }
writeFileSync('/home/donpedro/shot-gui-led.png', Buffer.from(shot.result.data, 'base64'));
console.log('saved /home/donpedro/shot-gui-led.png');
ws.close();
process.exit(0);
