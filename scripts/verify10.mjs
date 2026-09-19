/**
 * F12 E2E: the shipped example pair really talks - lan-server.ino on the
 * primary chip, lan-client.ino on the added device, both via the Examples
 * dropdown. Screenshot: /tmp/emu-lan-examples.png. (port 9334)
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';

const URL_ = process.argv[2] ?? 'http://127.0.0.1:8090/';
const PORT = 9334;

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
await cdp.eval(`window.confirm = () => true; true`);

const loadExample = (name) => `(() => {
  const sel = [...document.querySelectorAll('select')].find((s) => s.textContent.includes('Examples'));
  const set = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
  set.call(sel, ${JSON.stringify(name)});
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return !!sel;
})()`;
const press = (label) => `(() => {
  const b = [...document.querySelectorAll('button')].find((b) => ${label}.test(b.textContent));
  if (b) b.click();
  return !!b;
})()`;

await cdp.eval(loadExample('lan-server.ino'));
await sleep(400);
await cdp.eval(press('/run|start/i'));
await sleep(800);
const sLog = await cdp.eval(`window.__emu.machine.serial.map(l => l.text).join('\\n')`);
check('lan-server boots and announces itself', /192\.168\.1\.150/.test(sLog), JSON.stringify(sLog));

await cdp.eval(`(() => { window.__emu.addDevice(); return true; })()`);
await sleep(600);
// loading an example is a whole-doc swap (it would retire the bench), so the
// second chip gets the shipped example text through the editor instead
const clientSrc = readFileSync(new URL('../examples/lan-client.ino', import.meta.url), 'utf8');
await cdp.eval(`window.__emu.setSketch(${JSON.stringify(clientSrc)}); true`);
await sleep(400);
await cdp.eval(press('/run|start/i'));
await sleep(4200); // client: 2 s head start + first poll round

const bLog = await cdp.eval(`window.__emu.machine.serial.map(l => l.text).join('\\n')`);
check('lan-client reaches the peer by mDNS name', /server #0 answered: 192\.168\.1\.150/.test(bLog), JSON.stringify(bLog));
check('lan-client toggles the peer LED', /its LED says: led on/.test(bLog), JSON.stringify(bLog));
const aFault = await cdp.eval(`window.__emu.machine.faultReason`);
check('client runs fault-free', aFault === null, String(aFault));

const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
writeFileSync('/tmp/emu-lan-examples.png', Buffer.from(shot.result.data, 'base64'));
chrome.kill('SIGKILL');
console.log(fail ? `${fail} FAILED` : 'ALL OK');
process.exit(fail ? 1 : 0);
