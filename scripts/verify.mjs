/**
 * E2E verification through raw CDP (no playwright): launches the system
 * Chromium, drives the real UI (clicks, pointer wiring, palette drop) and
 * asserts on serial output + circuit state. Run against a served dist/.
 *
 *   node scripts/verify.mjs [url]
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';
import WebSocket from 'ws';

const URL_ = process.argv[2] ?? 'http://127.0.0.1:8090/';
const PORT = 9333;
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  :: ' + detail : ''}`);
}

// ---- CDP client ----
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
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval error');
    return r.result.value;
  }
}

// ---- launch ----
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

// ---- test 0: app booted ----
const booted = await cdp.eval(`!!window.__emu`);
check('app mounts and exposes __emu', booted === true);

// ---- test 1: Run button produces serial output ----
await cdp.eval(`document.querySelector('.btn-run').click(); true`);
await sleep(1600); // blink prints at t=0, 500, 1000 ms of virtual time @1x
const serial = await cdp.eval(
  `[...document.querySelectorAll('.serial-line')].map(e=>e.textContent).join('\\n')`,
);
check(
  'Run produces serial output (blink started / LED on / LED off)',
  serial.includes('blink started') && serial.includes('LED on') && serial.includes('LED off'),
  serial.split('\n').slice(0, 2).join(' | '),
);

// pin dot on D4 glows while running (canvas pixel check is unreliable; use model)
const d4 = await cdp.eval(`window.__emu.machine.pinLevel(2) === 0 || window.__emu.machine.pinLevel(2) === 1`);
check('machine exposes live pin level', d4 === true);

// ---- test 2: stop freezes time ----
await cdp.eval(`[...document.querySelectorAll('.btn-stop')][0].click(); true`);
await sleep(600);
const t1 = await cdp.eval(`window.__emu.machine.timeMs()`);
await sleep(500);
const t2 = await cdp.eval(`window.__emu.machine.timeMs()`);
check('Stop freezes simulated time', t1 === t2, `t=${t1}`);

// ---- test 3: pointer wiring through the real canvas handlers ----
// place R + LED next to the board via the model, then wire D4->R.p1 by pointer
await cdp.eval(`(() => {
  const s = window.__emu.schematic;
  const r = s.add('resistor', 420, 100, { resistance: 220 });
  const led = s.add('led', 420, 160, { forwardV: 2 });
  s.syncNetlist(window.__emu.machine.netlist);
  return [r.id, led.id];
})()`);
const screenPts = await cdp.eval(`(() => {
  const { schematic } = window.__emu;
  const vp = window.__emu.viewport;
  const rect = document.querySelector('.canvas-host canvas').getBoundingClientRect();
  const pts = {};
  for (const [key, ref] of Object.entries({
    d4: { comp: 'board', pin: 'D4' },
    r1: { comp: [...schematic.components.values()].find(c=>c.type==='resistor').id, pin: 'p1' },
    r2: { comp: [...schematic.components.values()].find(c=>c.type==='resistor').id, pin: 'p2' },
    la: { comp: [...schematic.components.values()].find(c=>c.type==='led').id, pin: 'a' },
    lk: { comp: [...schematic.components.values()].find(c=>c.type==='led').id, pin: 'k' },
    gnd: { comp: 'board', pin: 'GND' },
  })) {
    const w = schematic.pinWorld(ref);
    const q = vp.worldToScreen(w.x, w.y);
    pts[key] = [q.x + rect.left, q.y + rect.top];
  }
  return pts;
})()`).catch(() => null);
check('canvas viewport reachable from page', screenPts !== null);

if (screenPts) {
  const dispatch = async (type, [x, y]) =>
    cdp.eval(
      `(() => { const c = document.querySelector('.canvas-host canvas');
        c.dispatchEvent(new PointerEvent('${type}', {bubbles:true, cancelable:true, clientX:${x}, clientY:${y}, pointerId:1, isPrimary:true, button:0})); return true; })()`,
      // pointerup is delivered via window listener capture; the canvas
      // handler uses onPointerUp so dispatching on the canvas is fine.
    );
  const drag = async (from, to, steps = 6) => {
    const [ax, ay] = screenPts[from];
    const [bx, by] = screenPts[to];
    await dispatch('pointerdown', [ax, ay]);
    for (let i = 1; i <= steps; i++) {
      await dispatch('pointermove', [ax + ((bx - ax) * i) / steps, ay + ((by - ay) * i) / steps]);
    }
    await dispatch('pointerup', [bx, by]);
  };
  await drag('d4', 'r1');
  await drag('r2', 'la');
  await drag('lk', 'gnd');
  const wires = await cdp.eval(`window.__emu.schematic.wires.size`);
  check('pointer drag creates 3 wires (D4-R-LED-GND)', wires === 3, `wires=${wires}`);
}

// ---- test 4: run the button example, press the button via the machine, serial reacts ----
await cdp.eval(`window.__emu.machine.stop(); true`);
await cdp.eval(`(() => {
  const s = window.__emu.schematic;
  for (const id of [...s.components.keys()]) if (s.component(id).type !== 'board') s.remove(id);
  s.add('button', 420, 100, {});
  s.syncNetlist(window.__emu.machine.netlist);
  return true;
})()`);
const wireBtn = await cdp.eval(`(() => {
  const s = window.__emu.schematic;
  const b = [...s.components.values()].find(c=>c.type==='button').id;
  s.wire({comp:'board',pin:'D3'},{comp:b,pin:'p1'});
  s.wire({comp:b,pin:'p2'},{comp:'board',pin:'GND'});
  s.syncNetlist(window.__emu.machine.netlist);
  return b;
})()`);
// load the button sketch into the editor through CodeMirror's input path
const btnSketch = `void setup(){ pinMode(D3, INPUT_PULLUP); pinMode(D4, OUTPUT); Serial.begin(115200);} void loop(){ if (digitalRead(D3)==LOW){ digitalWrite(D4,HIGH); Serial.println("pressed"); } else { digitalWrite(D4,LOW); } delay(20); }`;
await cdp.eval(`window.__emu.setSketch(${JSON.stringify(btnSketch)}); true`);
await sleep(400);
await cdp.eval(`document.querySelector('.btn-run').click(); true`);
await sleep(700);
const before = await cdp.eval(`window.__emu.machine.serial.filter(l=>l.text==='pressed').length`);
await cdp.eval(`window.__emu.machine.press(${JSON.stringify(wireBtn)}, true)`);
await sleep(400);
await cdp.eval(`window.__emu.machine.press(${JSON.stringify(wireBtn)}, false)`);
await sleep(400);
const after = await cdp.eval(`window.__emu.machine.serial.filter(l=>l.text==='pressed').length`);
check(
  'button press drives digitalRead -> serial "pressed"',
  before === 0 && after > 0,
  `before=${before} after=${after}`,
);

// ---- test 5: HTML5 drag & drop from the palette ----
const dropped = await cdp.eval(`(() => {
  const before = window.__emu.schematic.components.size;
  const item = [...document.querySelectorAll('.palette-item')].find(e=>e.textContent.includes('LED'));
  const canvas = document.querySelector('.canvas-host canvas');
  const dt = new DataTransfer();
  item.dispatchEvent(new DragEvent('dragstart', {bubbles:true, dataTransfer:dt}));
  const r = canvas.getBoundingClientRect();
  canvas.dispatchEvent(new DragEvent('drop', {bubbles:true, dataTransfer:dt, clientX:r.left+120, clientY:r.top+120}));
  return window.__emu.schematic.components.size - before;
})()`);
check('palette drag-drop adds LED (+resistor)', dropped === 2, `added=${dropped}`);

// ---- test 6: switching the board rebuilds machine + board footprint ----
const switched = await cdp.eval(`(() => {
  const sel = document.querySelector('.toolbar select');
  const opt = [...sel.options].find((o) => o.value.includes('nodemcu'));
  sel.value = opt.value;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return opt.value;
})()`);
await sleep(600);
const switchedState = await cdp.eval(`(() => {
  const s = window.__emu.schematic;
  const b = s.boardComponent();
  return JSON.stringify({
    param: b.params.board,
    pins: s.allPinWorlds().filter((p) => p.comp === 'board').length,
    gpio: window.__emu.machine.gpio !== undefined,
    ledBuiltin: window.__emu.machine.phase() !== undefined,
  });
})()`);
const a = JSON.parse(switchedState);
check(
  'board switch to NodeMCU keeps document consistent',
  a.param.includes('nodemcu') && a.pins > 0 && a.gpio,
  switchedState,
);

// ---- screenshot of the finished scene ----
const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
writeFileSync('/home/donpedro/shot-gui-e2e.png', Buffer.from(shot.data, 'base64'));

// ---- summary ----
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
