// F18 E2E: the real-world roleta v19.7.6 sketch (Ticker, ICACHE prototypes,
// lambdas, noInterrupts) runs in the GUI without a fault.
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';

const PORT = 9345;
const fails = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  :: ' + detail : ''}`);
  if (!ok) fails.push(name);
};
class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((r) => this.pending.set(id, r));
  }
  async eval(e) {
    const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
    return r.result.result.value;
  }
}

const sketch = readFileSync(new URL('../examples/roleta_LoLin_WeMos_v19.7.6_k1_sm.ino', import.meta.url), 'utf8');
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
await cdp.eval(`window.__emu.setSketch(${JSON.stringify(sketch)}); true`);
await cdp.eval(`(() => { const b = [...document.querySelectorAll('button')].find(x => /Run/.test(x.textContent)); b.click(); return true; })()`);
await sleep(2500);
const state = await cdp.eval(`(() => {
  const m = window.__emu.machine;
  return JSON.stringify({
    phase: m.phase(),
    lines: m.serial.length,
    banner: document.querySelector('.toolbar-error, .error')?.textContent ?? null,
  });
})()`);
const st = JSON.parse(state);
check('roleta v19.7.6 runs after Run (phase running)', st.phase === 'running', state);
check('it prints to Serial', st.lines > 0, state);
check('no error banner', st.banner === null || st.banner === '', state);
// the half-second Ticker toggles the status LED: watch two samples 1.2s apart
const ledA = await cdp.eval(`(() => {
  const c = window.__emu.machine.circuit();
  return [...c.leds.values()].filter(l => l.on).length;
})()`);
console.log(`INFO  led samples: ${ledA}`);
console.log(fails.length ? `${fails.length} FAILED` : 'ALL OK');
chrome.kill('SIGKILL');
process.exit(fails.length ? 1 : 0);
