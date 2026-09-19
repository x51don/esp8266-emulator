// F16 E2E: MOSFET bench, bare-base warning in the banner, scrollable palette.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';
const PORT = 9342;
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

check('palette lists MOSFET', await cdp.eval(`[...document.querySelectorAll('.palette-item')].some(x => x.textContent.includes('MOSFET'))`));

// palette scrolls when its content exceeds the window
const pal = await cdp.eval(`(() => {
  const el = document.querySelector('.palette');
  const cs = getComputedStyle(el);
  return { scrollable: cs.overflowY === 'auto' || cs.overflowY === 'scroll', overflow: el.scrollHeight - el.clientHeight, h: el.clientHeight };
})()`);
check('palette is a scroll container', pal.scrollable, JSON.stringify(pal));
check('palette content exceeds its box at 900px height', pal.overflow > 0, JSON.stringify(pal));
await cdp.eval(`(() => { const el = document.querySelector('.palette'); el.scrollTop = 99999; return el.scrollTop; })()`);
const scrolled = await cdp.eval(`(() => { const el = document.querySelector('.palette'); return el.scrollTop > 0; })()`);
check('palette actually scrolls', scrolled);

// bench: MOSFET low-side switch + a transistor with a bare base
await cdp.eval(`(() => {
  const sc = window.__emu.schematic;
  for (const k of [...sc.components.keys()]) sc.components.delete(k);
  sc.wires.clear();
  sc.addBoard('wemos-d1-mini', 60, 60, 'b1');
  const m1 = sc.add('mosfet', 320, 140, { vth: 2 }).id;
  const rm = sc.add('resistor', 180, 60, { resistance: 220 }).id;
  const l1 = sc.add('led', 320, 60, { forwardV: 2 }).id;
  sc.wire({ comp: 'b1', pin: 'D1' }, { comp: m1, pin: 'g' });
  sc.wire({ comp: m1, pin: 's' }, { comp: 'b1', pin: 'GND' });
  sc.wire({ comp: 'b1', pin: '3V3' }, { comp: rm, pin: 'p1' });
  sc.wire({ comp: rm, pin: 'p2' }, { comp: l1, pin: 'a' });
  sc.wire({ comp: l1, pin: 'k' }, { comp: m1, pin: 'd' });
  const q1 = sc.add('transistor', 320, 300, { polarity: 'npn' }).id;
  sc.wire({ comp: 'b1', pin: 'D2' }, { comp: q1, pin: 'b' });
  sc.wire({ comp: q1, pin: 'e' }, { comp: 'b1', pin: 'GND' });
  window.__bench = { m1, q1 };
  return true;
})()`);
await cdp.eval(`window.__emu.setSketch('void setup(){ pinMode(D1, OUTPUT); pinMode(D2, OUTPUT); } void loop(){ digitalWrite(D1, HIGH); digitalWrite(D2, HIGH); delay(500); }'); true`);
await cdp.eval(`(() => { const b = [...document.querySelectorAll('button')].find(x => /Run/.test(x.textContent)); b.click(); return true; })()`);
await sleep(900);
const st = await cdp.eval(`(() => {
  const c = window.__emu.machine.circuit();
  const m = c.semis.get(window.__bench.m1);
  return { mOn: !!m?.on, led: [...c.leds.values()].some(l => l.on), warn: document.body.innerText.match(/base resistor[^\\n]*/)?.[0] ?? null };
})()`);
check('MOSFET conducts with the gate on HIGH', st.mOn === true && st.led === true, JSON.stringify(st));
check('bare-base warning reaches the banner', /base resistor/.test(st.warn ?? ''), st.warn ?? 'none');
check('MOSFET gate draws no warning', !(st.warn ?? '').includes('m1'));
console.log(fails.length ? `${fails.length} FAILED` : 'ALL OK');
chrome.kill('SIGKILL');
process.exit(fails.length ? 1 : 0);
