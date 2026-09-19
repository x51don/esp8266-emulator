/**
 * F11 E2E: EEPROM commits autosave the open project and a reload restores
 * the whole bench - both devices, both sketches, both flashes.
 * Screenshot: /tmp/emu-autosave.png.   node scripts/verify9.mjs [url] (port 9336)
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';

const URL_ = process.argv[2] ?? 'http://127.0.0.1:8090/';
const PORT = 9336;

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
await cdp.eval(`window.confirm = () => true; window.prompt = () => 'autotest'; true`);

const COUNTER = `
void setup() {
  EEPROM.begin(512);
  int n = EEPROM.read(0);
  n = n < 0 || n > 100 ? 1 : n + 1;
  EEPROM.write(0, n);
  EEPROM.commit();
  Serial.begin(115200);
  Serial.print("BOOT=");
  Serial.println(n);
}
void loop() { delay(500); }
`;
const press = (label) => `(() => {
  const b = [...document.querySelectorAll('button')].find((b) => ${label}.test(b.textContent));
  if (b) b.click();
  return !!b;
})()`;

// primary boots once (Run is a toggle), the bench goes to 'autotest'
await cdp.eval(`window.__emu.setSketch(${JSON.stringify(COUNTER)}); true`);
await sleep(300);
await cdp.eval(press('/run|start/i'));
await sleep(900);
await cdp.eval(press('/save/i'));
await sleep(600);

// second device runs the same firmware; its flash must ride along autosave
await cdp.eval(`(() => { window.__emu.addDevice(); return true; })()`);
await sleep(600);
await cdp.eval(`window.__emu.setSketch(${JSON.stringify(COUNTER)}); true`);
await sleep(300);
await cdp.eval(press('/run|start/i'));
await sleep(2600); // eepromDirty -> the 1 s autosave tick

// reload from scratch and reload the project through the toolbar select
await cdp.send('Page.navigate', { url: URL_ });
await sleep(2500);
await cdp.eval(`window.confirm = () => true; window.prompt = () => 'autotest'; true`);
await cdp.eval(`(() => {
  const sel = document.querySelector('select[title="load a saved project"]');
  const set = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
  set.call(sel, 'autotest');
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return !!sel.querySelector('option[value="autotest"]');
})()`);
await sleep(1200);
const bench = await cdp.eval(`window.__emu.devices()`);
check('both devices are back from the project', bench.length === 2, JSON.stringify(bench));
// primary flash survived: its next boot is #4, the second device's is #2
const aLog = await cdp.eval(`window.__emu.machine.serial.map(l => l.text).join('\\n')`);
await cdp.eval(press('/run|start/i'));
await sleep(900);
const aLog2 = await cdp.eval(`window.__emu.machine.serial.map(l => l.text).join('\\n')`);
check('primary flash persisted across the reload', /BOOT=2/.test(aLog2), JSON.stringify(aLog2));

await cdp.eval(`window.__emu.switchDevice(2)`);
await sleep(700);
const bOk = await cdp.eval(`(() => { return document.querySelector('.cm-content')?.textContent ?? ''; })()`);
check('device 2 restored its sketch', /BOOT=/.test(bOk), JSON.stringify(bOk.slice(0, 40)));
await cdp.eval(press('/run|start/i'));
await sleep(900);
const bLog = await cdp.eval(`window.__emu.machine.serial.map(l => l.text).join('\\n')`);
check('device 2 flash persisted (BOOT=2)', /BOOT=2/.test(bLog), JSON.stringify(bLog));

const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
writeFileSync('/tmp/emu-autosave.png', Buffer.from(shot.result.data, 'base64'));
chrome.kill('SIGKILL');
console.log(fail ? `${fail} FAILED` : 'ALL OK');
process.exit(fail ? 1 : 0);
