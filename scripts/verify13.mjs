// F15 E2E: diode / Zener / transistor parts place, wire, simulate and render.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';
const PORT = 9338;
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

// 1. palette offers the semiconductor parts
const palette = await cdp.eval(`[...document.querySelectorAll('.palette button, .palette .palette-item, .palette div, .palette span')]
  .map(el => el.textContent.trim()).join('|')`);
for (const want of ['Diode 1N4148', 'Zener diode', 'Transistor NPN', 'Transistor PNP'])
  check(`palette lists "${want}"`, String(palette).includes(want));

// 2. bench: NPN low-side driver on D1 + reversed diode blocking LED2
await cdp.eval(`(() => {
  const sc = window.__emu.schematic;
  for (const k of [...sc.components.keys()]) sc.components.delete(k);
  sc.wires.clear();
  sc.addBoard('wemos-d1-mini', 60, 60, 'b1');
  // NPN: D1 - 1k - base; emitter GND; 3V3 - 220 - LED1 - collector
  const rb = sc.add('resistor', 190, 120, { resistance: 1000 }).id;
  const q1 = sc.add('transistor', 330, 140, { polarity: 'npn' }).id;
  const rc = sc.add('resistor', 190, 60, { resistance: 220 }).id;
  const led1 = sc.add('led', 330, 60, { forwardV: 2 }).id;
  sc.wire({ comp: 'b1', pin: 'D1' }, { comp: rb, pin: 'p1' });
  sc.wire({ comp: rb, pin: 'p2' }, { comp: q1, pin: 'b' });
  sc.wire({ comp: q1, pin: 'e' }, { comp: 'b1', pin: 'GND' });
  sc.wire({ comp: 'b1', pin: '3V3' }, { comp: rc, pin: 'p1' });
  sc.wire({ comp: rc, pin: 'p2' }, { comp: led1, pin: 'a' });
  sc.wire({ comp: led1, pin: 'k' }, { comp: q1, pin: 'c' });
  // reversed diode branch: 3V3 - 470R - (k) d1 (a) - LED2 - GND => dark
  const r2 = sc.add('resistor', 190, 380, { resistance: 470 }).id;
  const d1 = sc.add('diode', 330, 380, {}).id;
  const led2 = sc.add('led', 330, 440, { forwardV: 2 }).id;
  sc.wire({ comp: 'b1', pin: '5V' }, { comp: r2, pin: 'p1' });
  sc.wire({ comp: r2, pin: 'p2' }, { comp: d1, pin: 'k' });
  sc.wire({ comp: d1, pin: 'a' }, { comp: led2, pin: 'a' });
  sc.wire({ comp: led2, pin: 'k' }, { comp: 'b1', pin: 'GND' });
  window.__bench = { q1, d1, led1, led2 };
  return true;
})()`);
await sleep(200);

// 3. run the sketch; the base line drives the low-side switch
await cdp.eval(`window.__emu.setSketch(\`
void setup() {
  pinMode(D1, OUTPUT);
  digitalWrite(D1, HIGH);
}
void loop() { delay(500); }
\`); true`);
await cdp.eval(`(() => { const b = [...document.querySelectorAll('button')].find(x => /Run/.test(x.textContent)); b.click(); return true; })()`);
await sleep(1400);
const res = await cdp.eval(`(() => {
  const c = window.__emu.machine.circuit();
  const q = c.semis.get(window.__bench.q1);
  const d = c.semis.get(window.__bench.d1);
  return {
    qOn: q?.on ?? null, qMode: q?.mode ?? null, qBurnt: q?.burnt ?? null,
    dOn: d?.on ?? null,
    led1: c.leds.get(window.__bench.led1)?.on ?? null,
    led2: c.leds.get(window.__bench.led2)?.on ?? null,
    faults: c.faults.length,
  };
})()`);
check('NPN conducts with base driven HIGH', res.qOn === true && res.qMode === 'fwd', JSON.stringify(res));
check('LED1 lights through the saturated transistor', res.led1 === true);
check('reversed diode blocks, LED2 stays dark', res.dOn === false && res.led2 === false);
check('no spurious faults', res.faults === 0, JSON.stringify(res));

// 4. base LOW opens the switch (sketch change + restart)
await cdp.eval(`(() => { const b = [...document.querySelectorAll('button')].find(x => /Stop|Pause/.test(x.textContent)); if (b) b.click(); return true; })()`);
await sleep(300);
await cdp.eval(`window.__emu.setSketch(\`
void setup() {
  pinMode(D1, OUTPUT);
  digitalWrite(D1, LOW);
}
void loop() { delay(500); }
\`); true`);
await cdp.eval(`(() => { const b = [...document.querySelectorAll('button')].find(x => /Run/.test(x.textContent)); b.click(); return true; })()`);
await sleep(1400);
const res2 = await cdp.eval(`(() => {
  const c = window.__emu.machine.circuit();
  return { qOn: c.semis.get(window.__bench.q1)?.on ?? null, led1: c.leds.get(window.__bench.led1)?.on ?? null };
})()`);
check('base LOW switches the NPN off', res2.qOn === false && res2.led1 === false, JSON.stringify(res2));

// 5. symbols actually paint (transistor + diode bodies have stroke pixels)
const painted = await cdp.eval(`(() => {
  const sc = window.__emu.schematic;
  const cv = document.querySelector('.canvas-host canvas');
  const ctx = cv.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = cv.getBoundingClientRect();
  const probe = (id) => {
    let p = null;
    for (const pin of ['b', 'a']) { try { p = sc.pinWorld({ comp: id, pin }); break; } catch { /* next */ } }
    if (!p) return false;
    const q = window.__emu.viewport.worldToScreen(p.x + 10, p.y);
    const cx = Math.round(q.x * dpr), cy = Math.round(q.y * dpr);
    let hit = false;
    for (let dy = -6; dy <= 6 && !hit; dy++) for (let dx = -8; dx <= 8 && !hit; dx++) {
      const px = ctx.getImageData(cx + dx, cy + dy, 1, 1).data;
      if (px[3] > 120 && (px[0] + px[1] + px[2]) / 3 > 90) hit = true;
    }
    return hit;
  };
  return { q: probe(window.__bench.q1), d: probe(window.__bench.d1) };
})()`);
check('transistor symbol paints', painted.q === true, JSON.stringify(painted));
check('diode symbol paints', painted.d === true, JSON.stringify(painted));

console.log(fails.length ? `${fails.length} FAILED` : 'ALL OK');
chrome.kill('SIGKILL');
process.exit(fails.length ? 1 : 0);
