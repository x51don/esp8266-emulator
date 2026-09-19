// F15 E2E part 2: the transistor-switch example loads wired and runs.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';
const PORT = 9341;
const fails = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  :: ' + detail : ''}`);
  if (!ok) fails.push(name);
};
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); } }); }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((r) => this.pending.set(id, r)); }
  async eval(e) { const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
    return r.result.result.value; }
}
const chrome = spawn('chromium-browser', ['--headless=new', '--no-sandbox', `--remote-debugging-port=${PORT}`, 'about:blank']);
await sleep(1200);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
const cdp = new Cdp(ws);
await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await cdp.send('Page.navigate', { url: 'http://127.0.0.1:8090/' });
await sleep(2500);
await cdp.eval(`window.__noConfirm = true; true`);
await cdp.eval(`window.__emu.loadExample('transistor-switch.ino', 'wemos-d1-mini'); true`);
await sleep(300);
const counts = await cdp.eval(`(() => {
  const t = [...window.__emu.schematic.components.values()].map(c => c.type);
  return { q: t.filter(x => x === 'transistor').length, z: t.filter(x => x === 'zener').length, led: t.filter(x => x === 'led').length };
})()`);
check('preset wires a transistor + zener + LED', counts.q === 1 && counts.z === 1 && counts.led === 1, JSON.stringify(counts));
await cdp.eval(`(() => { const b = [...document.querySelectorAll('button')].find(x => /Run/.test(x.textContent)); b.click(); return true; })()`);
// sample the circuit over one blink period (700 ms each way at 1x)
const seen = new Set();
for (let i = 0; i < 14; i++) {
  const st = await cdp.eval(`(() => {
    const c = window.__emu.machine.circuit();
    const led = [...c.leds.values()][0];
    const z = [...c.semis.values()].find(s => s.mode === 'rev');
    return { led: !!led?.on, zener: !!z, serial: document.body.innerText.includes('transistor saturated') };
  })()`);
  if (st.led) seen.add('led-on');
  if (!st.led && i > 1) seen.add('led-off');
  if (st.zener) seen.add('zener-breakdown');
  if (st.serial) seen.add('serial-msg');
  await sleep(220);
}
check('LED blinks through the transistor', seen.has('led-on') && seen.has('led-off'), [...seen].join(','));
check('Zener sits in reverse breakdown while running', seen.has('zener-breakdown'));
check('sketch prints to the serial monitor', seen.has('serial-msg'));
console.log(fails.length ? `${fails.length} FAILED` : 'ALL OK');
chrome.kill('SIGKILL');
process.exit(fails.length ? 1 : 0);
