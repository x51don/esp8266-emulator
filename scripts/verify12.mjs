/**
 * F14 E2E: wire colours reach the pixels and the picker works.
 *  - auto roles: a wire from the 3V3 rail paints power-red, from GND white,
 *    from a GPIO green (sampled from the canvas bitmap);
 *  - right-click on a wire opens the palette, picking a swatch stores the
 *    colour on the wire and it survives the document round trip.
 * (port 9335)
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';

const URL_ = process.argv[2] ?? 'http://127.0.0.1:8090/';
const PORT = 9335;

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
await cdp.eval(`window.__noConfirm = true; true`);

// bench: board + resistor fed from 3V3, pulled to GND, plus a GPIO signal wire
await cdp.eval(`(() => {
  const sc = window.__emu.schematic;
  for (const k of [...sc.components.keys()]) sc.components.delete(k);
  sc.wires.clear();
  sc.addBoard('wemos-d1-mini', 60, 60, 'b1');
  const r1 = sc.add('resistor', 500, 100);
  const r2 = sc.add('resistor', 500, 300);
  const led = sc.add('led', 500, 500);
  const wp = sc.wire({ comp: 'b1', pin: '3V3' }, { comp: r1.id, pin: 'p1' });   // power
  const wg = sc.wire({ comp: 'b1', pin: 'GND' }, { comp: r2.id, pin: 'p1' });   // gnd
  const ws = sc.wire({ comp: 'b1', pin: 'D1' }, { comp: led.id, pin: 'a' });    // signal
  window.__bench = { wp: wp.id, wg: wg.id, ws: ws.id };
  return true;
})()`);
await sleep(300);

// first point of the routed path that is actually inside the canvas box
await cdp.eval(`window.__routePoint = (id, frac) => {
  const sc = window.__emu.schematic;
  const path = sc.wireRoutes().get(id);
  const cv = document.querySelector('.canvas-host canvas');
  const r = cv.getBoundingClientRect();
  let total = 0;
  for (let i = 0; i + 1 < path.length; i++) total += Math.hypot(path[i+1].x - path[i].x, path[i+1].y - path[i].y);
  let acc = 0;
  for (let i = 0; i + 1 < path.length; i++) {
    const seg = Math.hypot(path[i+1].x - path[i].x, path[i+1].y - path[i].y);
    const p = window.__emu.viewport.worldToScreen(
      path[i].x + (path[i+1].x - path[i].x) * frac,
      path[i].y + (path[i+1].y - path[i].y) * frac);
    // worldToScreen is canvas-relative; return page coords via the rect
    if (seg > 12 && p.x > 20 && p.x < r.width - 20 && p.y > 10 && p.y < r.height - 10)
      return { x: r.left + p.x, y: r.top + p.y };
    acc += seg;
  }
  return null;
}; true`);

// sample the canvas at the middle of each wire's routed path
const sample = (idVar, want) => cdp.eval(`(() => {
  const pt = window.__routePoint(window.__bench.${idVar}, 0.4);
  if (!pt) return null;
  const cv = document.querySelector('.canvas-host canvas');
  const ctx = cv.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = cv.getBoundingClientRect();
  const cx = Math.round((pt.x - rect.left) * dpr), cy = Math.round((pt.y - rect.top) * dpr);
  void cv;
  const want = ${JSON.stringify(want)};
  let best = null, bd = 1e9;
  for (let dy = -3; dy <= 3; dy++)
    for (let dx = -3; dx <= 3; dx++) {
      const px = ctx.getImageData(cx + dx, cy + dy, 1, 1).data;
      if (px[3] <= 200) continue;
      const d = Math.abs(px[0] - want[0]) + Math.abs(px[1] - want[1]) + Math.abs(px[2] - want[2]);
      if (d < bd) { bd = d; best = [px[0], px[1], px[2]]; }
    }
  return best;
})()`);

const near = (c, rgb) => c && Math.abs(c[0] - rgb[0]) < 40 && Math.abs(c[1] - rgb[1]) < 40 && Math.abs(c[2] - rgb[2]) < 40;
const c0 = await sample('wp', [255, 82, 82]);
check('power wire paints red', near(c0, [255, 82, 82]), JSON.stringify(c0));
const c1 = await sample('wg', [232, 238, 245]);
check('gnd wire paints white', near(c1, [232, 238, 245]), JSON.stringify(c1));
const c2 = await sample('ws', [74, 222, 128]);
check('signal wire paints green', near(c2, [74, 222, 128]), JSON.stringify(c2));

// right-click the power wire -> palette -> cyan
const mid = await cdp.eval(`(() => {
  const pt = window.__routePoint(window.__bench.wp, 0.4);
  const rect = document.querySelector('.canvas-host canvas').getBoundingClientRect();
  return { x: pt.x, y: pt.y };
})()`);
await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: mid.x, y: mid.y, button: 'right', clickCount: 1 });
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: mid.x, y: mid.y, button: 'right', clickCount: 1 });
await sleep(250);
const menuUp = await cdp.eval(`!!document.querySelector('.wire-color-menu')`);
check('right-click opens the colour palette', menuUp);

const swatched = await cdp.eval(`(() => {
  const sw = [...document.querySelectorAll('.wire-swatch')].find(b => b.title === '#00e5ff');
  if (!sw) return false;
  sw.click(); return true;
})()`);
check('cyan swatch clickable', swatched);
await sleep(250);
const colored = await cdp.eval(`window.__emu.schematic.wireOf(window.__bench.wp).color ?? null`);
check('colour stored on the wire', colored === '#00e5ff', String(colored));

const cAfter = await sample('wp', [0, 229, 255]);
check('canvas repaints with the chosen colour', near(cAfter, [0, 229, 255]), JSON.stringify(cAfter));

const round = await cdp.eval(`(() => {
  const sc = window.__emu.schematic;
  const doc = JSON.parse(sc.toJSON());
  return doc.wires.find(w => w.id === window.__bench.wp).color ?? null;
})()`);
check('colour is part of the saved document', round === '#00e5ff', String(round));

// and the "auto" button clears it again
await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: mid.x, y: mid.y, button: 'right', clickCount: 1 });
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: mid.x, y: mid.y, button: 'right', clickCount: 1 });
await sleep(200);
await cdp.eval(`document.querySelector('.wire-color-auto').click()`);
await sleep(200);
const cleared = await cdp.eval(`window.__emu.schematic.wireOf(window.__bench.wp).color ?? null`);
check('"auto" restores the automatic colour', cleared === null, String(cleared));

chrome.kill('SIGKILL');
console.log(fail ? `${fail} FAILED` : 'ALL OK');
process.exit(fail ? 1 : 0);
