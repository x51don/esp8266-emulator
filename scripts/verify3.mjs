import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); } }); }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((r) => this.pending.set(id, r)); }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
    return r.result.result.value; }
}
const chrome = spawn('chromium-browser', ['--headless=new', '--no-sandbox', '--remote-debugging-port=9335', 'about:blank']);
await sleep(1200);
const list = await (await fetch('http://127.0.0.1:9335/json/list')).json();
const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
const cdp = new Cdp(ws);
await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
await cdp.send('Page.navigate', { url: 'http://127.0.0.1:8090/' });
await sleep(2200);
let fail = 0;
for (const [ex, probe] of [
  ['servo-pot.ino', `(() => { const s = window.__emu.machine.strips ? null : null; const a = [...window.__emu.machine.servoAngles().values()]; return a.length > 0 && a[0] >= 0 && a[0] <= 180; })()`],
  ['relay-pump.ino', `window.__emu.machine.serial.map(l=>l.text).join(' ').includes('pump')`],
  ['hcsr-serial.ino', `window.__emu.machine.serial.map(l=>l.text).join(' ').includes('distance: 20 cm')`],
  ['ldr-led.ino', `window.__emu.machine.serial.map(l=>l.text).join(' ').includes('dark adc')`],
]) {
  await cdp.eval(`window.__emu.machine.stop(); window.__emu.loadExample('${ex}'); true`);
  await sleep(400);
  await cdp.eval(`document.querySelector('.btn-run').click(); true`);
  await sleep(1300);
  const ok = await cdp.eval(probe);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${ex}`);
  if (!ok) fail++;
}
// canvas still rendering (no renderScene exception killed the loop)
const alive = await cdp.eval(`window.__emu.machine.timeMs() > 0`);
console.log(`${alive ? 'PASS' : 'FAIL'}  render loop alive after all part draws`);
ws.close(); chrome.kill();
process.exit(fail || !alive ? 1 : 0);
