/**
 * E2E for the F5 HTTP panel: a sketch with ESP8266WebServer runs in the
 * browser, the HTTP tab sends GET /ping through the virtual LAN, and the
 * panel shows the handler's "pong". Screenshot: /tmp/emu-http.png.
 *
 *   node scripts/verify6.mjs [url]   (needs a served dist/ and port 9339 free)
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';

const URL_ = process.argv[2] ?? 'http://127.0.0.1:8090/';
const PORT = 9339;

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
ESP8266WebServer server(80);
int target = 0;
void setup() {
  Serial.begin(115200);
  server.on("/ping", HTTP_GET, []() {
    server.send(200, "text/plain", "pong");
  });
  server.on("/TARGET", HTTP_GET, []() {
    target = constrain(server.arg("value").toInt(), 0, 100);
    server.send(200, "text/plain", "target=" + String(target));
  });
  server.onNotFound([]() {
    server.send(404, "text/plain", "no such path");
  });
  server.begin();
  Serial.println(WiFi.localIP());
}
void loop() {
  server.handleClient();
  delay(20);
}
`;

await cdp.eval(`window.__emu.setSketch(${JSON.stringify(SKETCH)}); true`);
await sleep(400);
// press Run
await cdp.eval(`(() => {
  const b = [...document.querySelectorAll('button')].find((b) => /run|start/i.test(b.textContent));
  if (b) b.click();
  return !!b;
})()`);
await sleep(1200);

// open the HTTP tab
const tabbed = await cdp.eval(`(() => {
  const b = [...document.querySelectorAll('.dock-tab')].find((b) => b.textContent.trim() === 'HTTP');
  if (!b) return false;
  b.click();
  return true;
})()`);
check('HTTP tab present and clickable', tabbed === true);
await sleep(400);

// type the URL and send
await cdp.eval(`(() => {
  const el = document.querySelector('.http-url');
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  set.call(el, 'http://192.168.1.42/ping');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return el.value;
})()`);
await cdp.eval(`(() => {
  const b = [...document.querySelectorAll('.http-bar button')].find((b) => b.textContent === 'send');
  b.click();
  return true;
})()`);
await sleep(900);

const got = await cdp.eval(`(() => {
  const e = document.querySelector('.http-resp');
  return e ? e.textContent : null;
})()`);
check('panel shows the handler body', got === 'pong', `got=${got}`);

// second request with args, straight through the machine hook (like the panel)
const target = await cdp.eval(`window.__emu.machine.fetchHttp('GET', 'http://192.168.1.42/TARGET?value=500').body`);
check('arg + clamp endpoint answers', target === 'target=100', `got=${target}`);

const nf = await cdp.eval(`window.__emu.machine.fetchHttp('GET', 'http://192.168.1.42/nope').status`);
check('onNotFound 404', nf === 404, `got=${nf}`);

// screenshot of the open panel
const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
writeFileSync('/tmp/emu-http.png', Buffer.from(shot.result.data, 'base64'));
console.log('screenshot: /tmp/emu-http.png');

ws.close();
chrome.kill();
console.log(fail ? `\n${fail} FAILURE(S)` : '\nALL OK');
process.exit(fail ? 1 : 0);
