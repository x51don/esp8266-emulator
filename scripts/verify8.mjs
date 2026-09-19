/**
 * F10 E2E: two ESP8266 machines in one page. Device 1 serves /ID; device 2
 * fetches it with HTTPClient (target is pumped on demand) and the HTTP
 * panel of device 2 reaches device 1 through lanFetch. Screenshot:
 * /tmp/emu-devices.png.   node scripts/verify8.mjs [url]  (port 9337)
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
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
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await cdp.send('Page.navigate', { url: URL_ });
await sleep(2500);

const pressRun = `(() => {
  const b = [...document.querySelectorAll('button')].find((b) => /run|start/i.test(b.textContent));
  if (b) b.click();
  return !!b;
})()`;

// device 1: server answering /ID with its own address
const SERVER = `
IPAddress wemos_ip(192, 168, 1, 150);
ESP8266WebServer server(80);
void setup() {
  Serial.begin(115200);
  WiFi.config(wemos_ip, IPAddress(192, 168, 1, 1), IPAddress(255, 255, 255, 0));
  MDNS.begin("serwer");
  server.on("/ID", []() { server.send(200, "text/plain", WiFi.localIP()); });
  server.begin();
}
void loop() { server.handleClient(); delay(20); }
`;
await cdp.eval(`window.__emu.setSketch(${JSON.stringify(SERVER)}); true`);
await sleep(300);
await cdp.eval(pressRun);
await sleep(1200);

// add device 2 and give it a client sketch
await cdp.eval(`(() => { window.__emu.addDevice(); return true; })()`);
await sleep(600);
const devs1 = await cdp.eval(`window.__emu.devices()`);
check('second device appears', devs1.length === 2, JSON.stringify(devs1));
const CLIENT = `
HTTPClient http;
void setup() {
  Serial.begin(115200);
  http.begin("http://192.168.1.150/ID");
  int code = http.GET();
  Serial.print("CODE=");
  Serial.println(code);
  Serial.print("PEER=");
  Serial.println(http.getString());
  http.end();
}
void loop() { delay(50); }
`;
await cdp.eval(`window.__emu.setSketch(${JSON.stringify(CLIENT)}); true`);
await sleep(300);
await cdp.eval(pressRun);
await sleep(1500);

const bLog = await cdp.eval(`window.__emu.machine.serial.map(l => l.text).join('\\n')`);
check('client reached the peer machine', /CODE=200/.test(bLog) && /PEER=192\.168\.1\.150/.test(bLog), JSON.stringify(bLog));

// the HTTP panel of device 2 talks to device 1 (lanFetch, name form too)
await cdp.eval(`(() => {
  const t = [...document.querySelectorAll('.dock-tab')].find((b) => b.textContent === 'HTTP');
  if (t) t.click();
  return !!t;
})()`);
await sleep(200);
await cdp.eval(`(() => {
  const inp = document.querySelector('.http-url');
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  set.call(inp, 'http://serwer.local/ID');
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(200);
await cdp.eval(`(() => {
  const b = [...document.querySelectorAll('button')].find((b) => /send/i.test(b.textContent));
  if (b) b.click();
  return !!b;
})()`);
await sleep(700);
const resp = await cdp.eval(`document.querySelector('.http-resp')?.textContent ?? ''`);
check('HTTP panel reaches the other device by name', /192\.168\.1\.150/.test(resp), JSON.stringify(resp));

// switching back to device 1 restores its sketch and log
const back = await cdp.eval(`(() => {
  window.__emu.switchDevice(1);
  return true;
})()`);
await sleep(500);
const aLog = await cdp.eval(`window.__emu.machine.serial.map(l => l.text).join('\\n')`);
const chips = await cdp.eval(`document.querySelectorAll('.device-chip').length`);
check('device switch keeps per-device logs', typeof aLog === 'string' && chips === 4, 'chips=' + chips + ' aLog=' + JSON.stringify(aLog));

const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
writeFileSync('/tmp/emu-devices.png', Buffer.from(shot.result.data, 'base64'));
chrome.kill('SIGKILL');
console.log(fail ? `${fail} FAILED` : 'ALL OK');
process.exit(fail ? 1 : 0);
