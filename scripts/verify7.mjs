/**
 * E2E for F6 EEPROM: a boot-counter sketch with ESP.restart() runs in the
 * browser; the counter must climb across reboots and stay readable through
 * machine.eepromBytes(). Screenshot: /tmp/emu-eeprom.png.
 *
 *   node scripts/verify7.mjs [url]   (needs a served dist/ and port 9338 free)
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';

const URL_ = process.argv[2] ?? 'http://127.0.0.1:8090/';
const PORT = 9338;

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

let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  :: ' + detail : ''}`);
  if (!ok) fail++;
};

const chrome = spawn('chromium-browser', ['--headless=new', '--no-sandbox', `--remote-debugging-port=${PORT}`, 'about:blank']);
await sleep(1200);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
const cdp = new Cdp(ws);
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await cdp.send('Page.navigate', { url: URL_ });
await sleep(2500);

const SKETCH = `
void setup() {
  Serial.begin(115200);
  EEPROM.begin(512);
  int n = EEPROM.read(0);
  n = n == 255 ? 1 : n + 1;
  EEPROM.write(0, n);
  EEPROM.commit();
  Serial.print("N=");
  Serial.println(n);
  delay(50);
  ESP.restart();
}
void loop() { delay(100); }
`;

await cdp.eval(`window.__emu.setSketch(${JSON.stringify(SKETCH)}); true`);
await sleep(400);
const pressed = await cdp.eval(`(() => {
  const b = [...document.querySelectorAll('button')].find((b) => /run|start/i.test(b.textContent));
  if (b) b.click();
  return !!b;
})()`);
check('Run button found', pressed);
await sleep(3000);

const state = await cdp.eval(`(() => {
  const m = window.__emu.machine;
  return { n: m.eepromBytes()[0], serial: m.serial.map(l => l.text).join('\\n') };
})()`);
check('EEPROM survived repeated ESP.restart reboots', state.n >= 3, 'N=' + state.n);
check('serial shows the boot counter', /N=\d+/.test(state.serial), state.serial.split('\n').pop());

const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
writeFileSync('/tmp/emu-eeprom.png', Buffer.from(shot.result.data, 'base64'));
chrome.kill('SIGKILL');
console.log(fail ? `${fail} FAILED` : 'ALL OK');
process.exit(fail ? 1 : 0);
