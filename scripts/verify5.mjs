/**
 * E2E for the P3.5 OLED framebuffer: a sketch paints pixels, the machine
 * commits them on oledShow(), and the schematic canvas actually draws them
 * (screenshot saved to /tmp/emu-oled.png for eyeball verification).
 *
 *   node scripts/verify5.mjs [url]   (needs a served dist/ and port 9338 free)
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';

const URL_ = process.argv[2] ?? 'http://127.0.0.1:8090/';
const PORT = 9338;

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

const SKETCH = `
void setup() {
  Serial.begin(115200);
  oledBegin(0x3c);
  oledFillRect(0, 0, 64, 32, 1);   // solid block, top-left quadrant
  oledLine(64, 63, 127, 32, 1);    // diagonal in the right half
  oledRect(70, 4, 20, 14, 1);      // outline
  oledShow();
}
void loop() { delay(50); }
`;

const placed = await cdp.eval(`(() => {
  const c = window.__emu.schematic.add('oled', 260, 240, { addr: 0x3c });
  return c.id;
})()`);
check('OLED placed on canvas', typeof placed === 'string' && placed.length > 0, String(placed));

await cdp.eval(`window.__emu.setSketch(${JSON.stringify(SKETCH)}); true`);
await cdp.eval(`document.querySelector('.btn-run').click(); true`);
await sleep(1600);

const st = await cdp.eval(`(() => {
  const f = [...window.__emu.machine.oledFrames().values()][0];
  if (!f) return { none: true };
  let lit = 0;
  for (const b of f.fb) lit += b.toString(2).split('1').length - 1;
  const px = (x, y) => f.fb[(y << 4) + (x >> 3)] & (1 << (x & 7)) ? 1 : 0;
  // Bresenham may land on 47 or 48 at x=96; accept either, nothing else
  let diagCol = 0;
  for (let y = 33; y < 63; y++) if (px(96, y)) diagCol = y;
  return { lit, block: px(10, 10), diag: diagCol, out: px(30, 40) };
})()`);
check('framebuffer committed on the panel', st.lit > 2000, JSON.stringify(st));
check('fillRect pixel on', st.block === 1);
check('diagonal pixel on', st.diag === 47 || st.diag === 48, 'y@x96=' + st.diag);
check('untouched pixel off', st.out === 0);

// screenshot the canvas for the eyeball check
const box = await cdp.eval(`(() => { const r = document.querySelector('canvas').getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
const shot = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...box, scale: 2 } });
writeFileSync('/tmp/emu-oled.png', Buffer.from(shot.result.data, 'base64'));
console.log('screenshot: /tmp/emu-oled.png');

ws.close();
chrome.kill('SIGKILL');
console.log(fail ? `${fail} checks FAILED` : 'all checks passed');
process.exit(fail ? 1 : 0);
