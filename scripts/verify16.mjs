// F17 E2E: Auto-wire turns the open sketch into a wired circuit.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';
const PORT = 9344;
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
check('toolbar has the Auto-wire button', await cdp.eval(`[...document.querySelectorAll('.toolbar .btn')].some(b => b.textContent.includes('Auto-wire'))`));
// a sketch mixing aliases, bare GPIO numbers, a servo and a DHT
await cdp.eval(`window.__emu.setSketch(\`
  #define LED D4
  const int KEY = D3;
  void setup() { servoAttach(D0); }
  void loop() {
    if (digitalRead(KEY)) digitalWrite(LED, HIGH); else digitalWrite(LED, LOW);
    analogWrite(5, 200);
    Serial.println(dhtReadTemperature(12));
    delay(200);
  }\`); true`);
await cdp.eval(`window.__emu.autowire(); true`);
await sleep(400);
const types = await cdp.eval(`(() => {
  const t = {};
  for (const c of window.__emu.schematic.components.values()) t[c.type] = (t[c.type] ?? 0) + 1;
  return JSON.stringify(t);
})()`);
const t = JSON.parse(types);
check('board generated', t.board === 1, types);
check('LED chains for D4 (alias) and D1 (GPIO 5)', t.led === 2 && t.resistor >= 2, types);
check('button for KEY=D3', t.button === 1, types);
check('servo on D0', t.servo === 1, types);
check('DHT on GPIO12=D6', t.dht === 1, types);
// the generated circuit actually runs: D4 goes HIGH, the LED lights
await cdp.eval(`(() => { const b = [...document.querySelectorAll('button')].find(x => /Run/.test(x.textContent)); b.click(); return true; })()`);
await sleep(900);
const run = await cdp.eval(`(() => {
  const c = window.__emu.machine.circuit();
  return JSON.stringify({ leds: [...c.leds.values()].filter(l => l.on).length, faults: c.faults.length });
})()`);
const r = JSON.parse(run);
// KEY floats LOW -> sketch takes the else-branch -> only the PWM LED (D1) glows
check('generated circuit runs: PWM LED glows, fault-free', r.leds === 1 && r.faults === 0, run);
console.log(fails.length ? `${fails.length} FAILED` : 'ALL OK');
chrome.kill('SIGKILL');
process.exit(fails.length ? 1 : 0);
