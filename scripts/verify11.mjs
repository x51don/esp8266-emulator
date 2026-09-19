/**
 * F13 E2E: the sketch travels as a real .ino file.
 *  - save: clicking "⤓ .ino" must hand the exact editor text to a blob
 *    download named after the active device;
 *  - open: picking a .ino file (DOM.setFileInputFiles) replaces the sketch
 *    on the active device - proven electrically by running it.
 * (port 9328)
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';

const URL_ = process.argv[2] ?? 'http://127.0.0.1:8090/';
const PORT = 9328;

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
// headless has no gesture for blob downloads -> capture at createObjectURL level
await cdp.eval(`window.__noConfirm = true;
window.__dl = [];
const ocu = URL.createObjectURL.bind(URL);
URL.createObjectURL = function (b) { const u = ocu(b); window.__dl.push({ blob: b }); return u; };
const oclick = HTMLAnchorElement.prototype.click;
HTMLAnchorElement.prototype.click = function () {
  if (this.download) window.__dl[window.__dl.length - 1].name = this.download;
  else oclick.call(this);
};
true`);

const editorText = await cdp.eval(`window.__emu.sketch()`);
check('editor holds the default sketch', typeof editorText === 'string' && editorText.includes('setup'));

// ---- save ----
await cdp.eval(`(() => {
  const b = [...document.querySelectorAll('button')].find(b => b.title === 'download the sketch as a .ino file');
  if (!b) throw new Error('save .ino button missing');
  b.click();
})()`);
const cap = await cdp.eval(`(async () => {
  const e = window.__dl[0]; if (!e) return null;
  return { name: e.name, text: await e.blob.text() };
})()`);
check('save offers "<device>.ino"', cap?.name === 'esp-1.ino', String(cap?.name));
check('downloaded bytes match the editor', cap?.text === editorText);

// ---- open: a .ino picked from disk replaces the active sketch ----
mkdirSync('scripts/.tmp', { recursive: true });
const probe = resolve('scripts/.tmp/probe.ino');
writeFileSync(probe, 'void setup() {\n  Serial.begin(115200);\n  Serial.println("ino-file-loaded-ok");\n}\nvoid loop() { delay(100); }\n');
// display:none inputs refuse setFileInputFiles in headless; reveal it first
await cdp.eval(`document.querySelector('input[type=file][accept*=".ino"]').style.display = 'block'; true`);
const doc = await cdp.send('DOM.getDocument');
const q = await cdp.send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: 'input[type=file][accept*=".ino"]' });
await cdp.send('DOM.setFileInputFiles', { nodeId: q.result.nodeId, files: [probe] });
await sleep(600);
const loaded = await cdp.eval(`window.__emu.sketch()`);
check('picked .ino replaced the editor text', String(loaded).includes('ino-file-loaded-ok'));

// run it: the loaded sketch must own the active device
await cdp.eval(`(() => {
  const b = [...document.querySelectorAll('button')].find(b => /run/i.test(b.textContent));
  b.click();
})()`);
await sleep(900);
const serial = await cdp.eval(`window.__emu.machine.serial.map(l => l.text).join('\\n')`);
check('the opened sketch runs on the active device', /ino-file-loaded-ok/.test(serial), JSON.stringify(serial).slice(0, 80));

rmSync('scripts/.tmp', { recursive: true, force: true });
chrome.kill('SIGKILL');
console.log(fail ? `${fail} FAILED` : 'ALL OK');
process.exit(fail ? 1 : 0);
