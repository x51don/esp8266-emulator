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
check('app mounts', (await cdp.eval(`!!window.__emu`)) === true);

// native dialogs are auto-rejected in headless: silence them deliberately
await cdp.eval(`window.__noConfirm = true; true`);

// ---- 1: Examples select loads sketch AND a wired preset ----
await cdp.eval(`(() => {
  const sel = [...document.querySelectorAll('.toolbar select')]
    .find(s => [...s.options].some(o => o.text === 'blink.ino'));
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
  setter.call(sel, 'blink.ino');
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);
await sleep(700);
const preset = await cdp.eval(`(() => {
  const s = window.__emu.schematic;
  const types = [...s.components.values()].map(c => c.type).sort().join(',');
  const ends = new Set();
  for (const w of s.wires.values()) { ends.add(w.a.comp+'.'+w.a.pin); ends.add(w.b.comp+'.'+w.b.pin); }
  return {
    types, wires: s.wires.size,
    sketch: localStorage.getItem('esp8266-emu.sketch') ?? '',
    d4: ends.has('board.D4'), gnd: ends.has('board.GND'),
  };
})()`);
check(
  'Example loads sketch + wired circuit (D4-R-LED-GND)',
  preset.types === 'board,led,resistor' && preset.wires === 3 && preset.d4 && preset.gnd &&
    preset.sketch.includes('blink started'),
  JSON.stringify(preset),
);

// ---- 2: routed wire never crosses the board body ----
const routing = await cdp.eval(`(() => {
  const s = window.__emu.schematic;
  const board = s.boardComponent();
  const b = s.bodyRect(board);
  let checked = 0;
  for (const w of s.wires.values()) {
    const touchesBoard = w.a.comp === 'board' || w.b.comp === 'board';
    if (!touchesBoard) continue;
    const path = window.__emu.wirePath(w.id);
    for (let i = 1; i < path.length - 2; i++) {
      const mx = (path[i].x + path[i+1].x) / 2, my = (path[i].y + path[i+1].y) / 2;
      if (mx > b.x && mx < b.x + b.w && my > b.y && my < b.y + b.h) return { clean: false, wire: w.id, seg: i, a: path[i], c: path[i + 1], path };
    }
    checked++;
  }
  return { clean: true, checked };
})()`);
check('Preset wires route around the board body', routing.clean === true, JSON.stringify(routing));

// ---- 3: double-click on a wire removes it (with confirm silenced) ----
const before = await cdp.eval(`window.__emu.schematic.wires.size`);
const dbl = await cdp.eval(`(() => {
  const s = window.__emu.schematic;
  const w = [...s.wires.values()].find(w => w.a.comp !== 'board' || w.b.comp !== 'board');
  const path = window.__emu.wirePath(w.id);
  const p = path[1], q = path[2] ?? path[path.length - 1];
  const mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
  const vp = window.__emu.viewport;
  const rect = document.querySelector('.canvas-host canvas').getBoundingClientRect();
  const sc = vp.worldToScreen(mid.x, mid.y);
  document.querySelector('.canvas-host canvas').dispatchEvent(new MouseEvent('dblclick', {
    bubbles: true, cancelable: true, clientX: sc.x + rect.left, clientY: sc.y + rect.top,
  }));
  return w.id;
})()`);
await sleep(400);
const after = await cdp.eval(`window.__emu.schematic.wires.size`);
check('Double-click removes a wire', after === before - 1, `${dbl}: ${before} -> ${after}`);

// ---- 4: delete the board (keyboard, confirmed), re-add it from the palette ----
await cdp.eval(`(() => {
  const s = window.__emu.schematic;
  const b = s.bodyRect(s.boardComponent());
  const vp = window.__emu.viewport;
  const rect = document.querySelector('.canvas-host canvas').getBoundingClientRect();
  const c = vp.worldToScreen(b.x + b.w / 2, b.y + b.h / 2);
  const el = document.querySelector('.canvas-host canvas');
  const at = { bubbles: true, cancelable: true, clientX: c.x + rect.left, clientY: c.y + rect.top, pointerId: 1, isPrimary: true, button: 0 };
  el.dispatchEvent(new PointerEvent('pointerdown', at));
  el.dispatchEvent(new PointerEvent('pointerup', at));
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
  return true;
})()`);
await sleep(400);
const gone = await cdp.eval(`!window.__emu.schematic.boardComponent()`);
check('Delete removes the board (confirmed dialog)', gone === true);

await cdp.eval(`(() => {
  const host = document.querySelector('.canvas-host');
  const rect = host.getBoundingClientRect();
  const dt = new DataTransfer();
  dt.setData('application/x-component', 'board');
  host.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: rect.x + 400, clientY: rect.y + 300 }));
  host.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: rect.x + 400, clientY: rect.y + 300 }));
  return true;
})()`);
await sleep(400);
const back = await cdp.eval(`(() => {
  const b = window.__emu.schematic.boardComponent();
  return b ? String(b.params.board) : null;
})()`);
check('Palette re-adds the board', back !== null && back.length > 0, `board=${back}`);

// ---- 5: project chrome present ----
const chrome5 = await cdp.eval(`(() => {
  const txt = document.querySelector('.toolbar').textContent;
  return { save: txt.includes('Save'), exp: txt.includes('Export'), imp: txt.includes('Import') };
})()`);
check('Toolbar has Save/Export/Import', chrome5.save && chrome5.exp && chrome5.imp);

// ---- 5b: New project empties the canvas back to a bare board ----
await cdp.eval(`window.__emu.loadExample('blink.ino'); true`);
await sleep(400);
await cdp.eval(`(() => { [...document.querySelectorAll('.toolbar .btn')].find(b => b.textContent.includes('New')).click(); return true; })()`);
await sleep(400);
const fresh = await cdp.eval(`(() => {
  const s = window.__emu.schematic;
  return { comps: s.components.size, wires: s.wires.size, board: !!s.boardComponent(),
           sketch: localStorage.getItem('esp8266-emu.sketch') ?? '' };
})()`);
check('New project leaves a bare board + template sketch',
  fresh.comps === 1 && fresh.wires === 0 && fresh.board && fresh.sketch.includes('hello esp8266'),
  JSON.stringify(fresh));

// ---- 6: project save -> list -> load -> delete round-trip ----
const proj = await cdp.eval(`(async () => {
  window.prompt = () => 'e2e-proj';
  window.__emu.loadExample('blink.ino');
  await new Promise(r => setTimeout(r, 400));
  const btn = [...document.querySelectorAll('.toolbar .btn')].find(b => b.textContent.includes('Save'));
  btn.click();
  await new Promise(r => setTimeout(r, 200));
  const saved = localStorage.getItem('esp8266-emu.project.e2e-proj') !== null;

  // wreck the current doc, then load the project back
  window.__emu.schematic.wires.clear();
  const wrecked = window.__emu.schematic.wires.size;
  const sel = [...document.querySelectorAll('.toolbar select')]
    .find(s2 => [...s2.options].some(o => o.text.includes('e2e-proj') && !o.text.includes('Delete')));
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
  setter.call(sel, 'e2e-proj');
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 400));
  const wiresBack = window.__emu.schematic.wires.size;

  const del = [...document.querySelectorAll('.toolbar select')]
    .find(s2 => [...s2.options].some(o => o.value === 'del:e2e-proj'));
  setter.call(del, 'del:e2e-proj');
  del.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 200));
  const deleted = localStorage.getItem('esp8266-emu.project.e2e-proj') === null;
  return { saved, wrecked, wiresBack, deleted };
})()`, true);
check(
  'Project save/load/delete round-trip',
  proj.saved && proj.wrecked === 0 && proj.wiresBack === 3 && proj.deleted,
  JSON.stringify(proj),
);

// ---- 10: DHT + OLED example drive the panel ----
await cdp.eval(`window.__emu.machine.stop(); window.__emu.loadExample('dht-oled.ino'); true`);
await sleep(400);
await cdp.eval(`document.querySelector('.btn-run').click(); true`);
await sleep(1500);
const oled = await cdp.eval(`(() => {
  const f = [...window.__emu.machine.oledFrames().values()];
  const rows = f.length ? f[0].cells.map(r => r.trimEnd()).filter(Boolean) : [];
  const txt = window.__emu.machine.serial.map(l => l.text).join(' ');
  return { rows, ser: txt.includes('T=23.5') && txt.includes('H=61') };
})()`);
check('DHT on serial + OLED panel text', oled.rows.some(r => r.includes('ESP8266 lab')) && oled.ser, JSON.stringify(oled).slice(0, 120));

// ---- 11: NeoPixel strip lights while running ----
await cdp.eval(`window.__emu.machine.stop(); window.__emu.loadExample('neopixel-chase.ino'); true`);
await sleep(400);
await cdp.eval(`document.querySelector('.btn-run').click(); true`);
await sleep(900);
const np = await cdp.eval(`(() => {
  const st = window.__emu.machine.strips().get(13);
  return { n: st ? st.count : 0, lit: st ? st.pixels.filter(p => p).length : 0 };
})()`);
check('NeoPixel strip on D7 lit', np.n === 8 && np.lit > 0, JSON.stringify(np));

// ---- 12: potentiometer drives analogRead live ----
await cdp.eval(`window.__emu.machine.stop(); window.__emu.loadExample('pot-serial.ino'); true`);
await sleep(400);
await cdp.eval(`document.querySelector('.btn-run').click(); true`);
await sleep(700);
const lastAdc = `(parseInt((window.__emu.machine.serial.map(l => l.text).join(' ').match(/adc = (\\d+)/g) || []).pop() || 'x').toString()`;
const midAdc = await cdp.eval(`(() => { const m = window.__emu.machine.serial.map(l => l.text).join(' ').match(/adc = (\\d+)/g); return m ? parseInt(m[m.length - 1].split(' ')[2]) : -1; })()`);
await cdp.eval(`(() => {
  const c = [...window.__emu.schematic.components.values()].find(c => c.type === 'pot');
  c.params.ratio = 0;
  window.__emu.machine.netlist.addComponent(c.id, 'pot', c.params);
  return true;
})()`);
await sleep(600);
const lowAdc = await cdp.eval(`(() => { const m = window.__emu.machine.serial.map(l => l.text).join(' ').match(/adc = (\\d+)/g); return m ? parseInt(m[m.length - 1].split(' ')[2]) : -1; })()`);
check('Pot wiper moves analogRead (0.5 -> ~511, 0 -> ~0)', midAdc > 400 && lowAdc >= 0 && lowAdc < 80, `mid=${midAdc} low=${lowAdc}`);
void lastAdc;
await cdp.eval(`window.__emu.machine.stop(); true`);

// ---- visual: load the button preset for a screenshot ----
await cdp.eval(`window.__emu.loadExample('button.ino'); true`);
await sleep(700);
await cdp.eval(`(() => { const vp = window.__emu.viewport; const s = window.__emu.schematic;
  const el = document.querySelector('.canvas-host canvas');
  vp.fit(s.bounds(), el.clientWidth, el.clientHeight, 60, 1.15); return true; })()`);
await sleep(400);
const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
writeFileSync('/home/donpedro/shot-presets.png', Buffer.from(shot.data, "base64"));
console.log('screenshot: /home/donpedro/shot-presets.png');

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
ws.close();
process.exit(failed.length ? 1 : 0);
