/**
 * E2E pass #2: the round-2 features - examples with preset wiring,
 * obstacle-aware routing, wire double-click delete, board re-add via the
 * palette, delete confirmation, project chrome. Run against a served dist/.
 *
 *   node scripts/verify2.mjs [url]
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';
import WebSocket from 'ws';

const URL_ = process.argv[2] ?? 'http://127.0.0.1:8090/';
const PORT = 9334;
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  :: ' + detail : ''}`);
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.on('message', (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async eval(expression, awaitPromise = false) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval error');
    return r.result.value;
  }
}

const chrome = spawn('chromium-browser', [
  '--headless=new',
  '--no-sandbox',
  `--remote-debugging-port=${PORT}`,
  '--window-size=1600,900',
  'about:blank',
]);
process.on('exit', () => chrome.kill('SIGKILL'));

let ws;
for (let i = 0; i < 40; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (page) {
      ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
      await new Promise((res, rej) => {
        ws.once('open', res);
        ws.once('error', rej);
      });
      break;
    }
  } catch {
    /* not up yet */
  }
  await sleep(250);
}
if (!ws) throw new Error('chromium CDP endpoint never appeared');

const cdp = new Cdp(ws);
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
await cdp.send('Page.navigate', { url: URL_ });
await sleep(2500);

await cdp.eval(`window.__noConfirm = true; window.__emu.loadExample('button.ino'); true`);
await sleep(500);
await cdp.eval(`document.querySelector('.btn-run').click(); true`);
await sleep(600);
const box = await cdp.eval(`(() => {
  const s = window.__emu.schematic;
  const r = [...s.components.values()].find(c => c.type === 'resistor');
  const b = s.bodyRect(r);
  const rect = document.querySelector('.canvas-host canvas').getBoundingClientRect();
  const sc = window.__emu.viewport.worldToScreen(b.x + b.w / 2, b.y + b.h / 2);
  return { id: r.id, x: rect.left + sc.x, y: rect.top + sc.y };
})()`);
for (const [cc, type] of [[1,'mousePressed'],[1,'mouseReleased'],[2,'mousePressed'],[2,'mouseReleased']]) {
  await cdp.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: cc });
}
await sleep(400);
const open1 = await cdp.eval(`!!document.querySelector('.dialog')`);
console.log('DIALOG OPEN WHILE RUNNING:', open1);
if (open1) {
  await cdp.eval(`(() => { const i = document.querySelector('.dialog input'); i.focus(); i.select(); })()`);
  for (const ch of '12000') {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch, code: 'Digit' + ch, windowsVirtualKeyCode: ch.charCodeAt(0) });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: 'Digit' + ch, windowsVirtualKeyCode: ch.charCodeAt(0) });
  }
  const bb = await cdp.eval(`(() => { const b = [...document.querySelectorAll('.dialog button')].find(x => /apply/i.test(x.textContent)); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: bb.x, y: bb.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: bb.x, y: bb.y, button: 'left', clickCount: 1 });
  await sleep(400);
  console.log('WHILE RUNNING:', JSON.stringify(await cdp.eval(`(() => ({
    res: window.__emu.schematic.component('${box.id}').params.resistance,
    net: window.__emu.machine.netlist.comps.get('${box.id}')?.params?.resistance,
  }))()`)));
}
chrome.kill('SIGKILL'); ws.close(); process.exit(0);
