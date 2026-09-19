/**
 * E2E for the P1.3 render gating and the P2 canvas interactions:
 * idle + stop performs zero canvas redraws, hovering a wire repaints and
 * marks the pointer, Delete removes the hovered wire.
 *
 *   node scripts/verify4.mjs [url]   (needs a served dist/ and port 9337 free)
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';

const URL_ = process.argv[2] ?? 'http://127.0.0.1:8090/';
const PORT = 9337;

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
// count canvas strokes from the very first script of the page
await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `window.__strokes = 0;
    const o = CanvasRenderingContext2D.prototype.stroke;
    CanvasRenderingContext2D.prototype.stroke = function (...a) { window.__strokes++; return o.apply(this, a); };
    window.__noConfirm = true;`,
});
await cdp.send('Page.navigate', { url: URL_ });
await sleep(2200);

await cdp.eval(`window.__emu.loadExample('blink.ino'); true`);
await sleep(500);

// 1) idle + stop: the render gate must skip every frame
const a = await cdp.eval('window.__strokes');
await sleep(1500);
const b = await cdp.eval('window.__strokes');
check('idle + stop draws zero canvas strokes in 1.5 s', b === a, `delta=${b - a}`);

// 2) hover the middle of a wire: halo repaint + pointer cursor
const mid = await cdp.eval(`(() => {
  const s = window.__emu.schematic;
  const id = [...s.wires.keys()][0];
  const path = window.__emu.wirePath(id);
  const p = path[Math.floor(path.length / 2)];
  const q = path[Math.floor(path.length / 2) - 1];
  const m = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
  const sp = window.__emu.viewport.worldToScreen(m.x, m.y);
  const r = document.querySelector('canvas').getBoundingClientRect();
  return { x: r.left + sp.x, y: r.top + sp.y };
})()`);
const c = await cdp.eval('window.__strokes');
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: mid.x, y: mid.y });
await sleep(250);
const d = await cdp.eval('window.__strokes');
check('hover over a wire triggers a repaint', d > c, `delta=${d - c}`);
const cur = await cdp.eval(`document.querySelector('canvas').style.cursor`);
check('hover over a wire shows the pointer cursor', cur === 'pointer', `cursor=${cur}`);

// 3) Delete removes the hovered wire (no component is selected)
const n1 = await cdp.eval('window.__emu.schematic.wires.size');
await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
await sleep(400);
const n2 = await cdp.eval('window.__emu.schematic.wires.size');
check('Delete removes the hovered wire', n2 === n1 - 1, `${n1} -> ${n2}`);

// 4) back to idle: the gate closes again
const e1 = await cdp.eval('window.__strokes');
await sleep(1200);
const e2 = await cdp.eval('window.__strokes');
check('gate closes after the last change (idle again = 0 strokes)', e2 === e1, `delta=${e2 - e1}`);

// 5) running the machine forces a redraw every frame
await cdp.eval(`document.querySelector('.btn-run').click(); true`);
await sleep(300);
const f1 = await cdp.eval('window.__strokes');
await sleep(600);
const f2 = await cdp.eval('window.__strokes');
check('running machine repaints continuously', f2 > f1, `delta=${f2 - f1}`);
await cdp.eval(`document.querySelector('.btn-stop').click(); true`);
await sleep(200);

// 6) P3.1 ADC dock: enable + slide -> analogRead follows, uncheck releases
await cdp.eval(`document.querySelector('.adc-dock input[type=checkbox]').click(); true`);
await sleep(150);
await cdp.eval(`(() => {
  const el = document.querySelector('.adc-dock input[type=range]');
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  set.call(el, '2.5');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(250);
const adc = await cdp.eval('window.__emu.machine.analogRead(17)');
check('A0 force dock drives analogRead', Math.abs(adc - 775) <= 6, `adc=${adc}`);
await cdp.eval(`document.querySelector('.adc-dock input[type=checkbox]').click(); true`);
await sleep(250);
const adc0 = await cdp.eval('window.__emu.machine.analogRead(17)');
check('unchecking the dock floats A0 again', adc0 === 0, `adc=${adc0}`);

console.log(fail ? `\n${fail} check(s) failed` : '\nall checks passed');
ws.close();
chrome.kill();
process.exit(fail ? 1 : 0);
