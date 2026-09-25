// E2E: the Variables tab - live globals, reorder, hide, persisted layout.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';
import WebSocket from 'ws';

const PORT = 9346;
const fails = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  :: ' + detail : ''}`);
  if (!ok) fails.push(name);
};
class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((r) => this.pending.set(id, r));
  }
  async eval(e) {
    const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
    return r.result.result.value;
  }
}

const SKETCH = `
int counter = 0;
unsigned long last = 0;
const int LIMIT = 10;
String label = "roleta";
int steps[4] = {1, 2, 3, 4};
bool armed = true;

void setup() {
  Serial.begin(115200);
  pinMode(D4, OUTPUT);
}

void loop() {
  counter++;
  last = millis();
  Serial.println(counter);
  delay(200);
}
`;

const PAGE = `(() => {
  const rows = [...document.querySelectorAll('.vars-row')].filter(r => !r.classList.contains('vars-off'));
  return JSON.stringify({
    names: rows.map(r => r.querySelector('.vars-name').textContent),
    values: rows.map(r => r.querySelector('.vars-value').textContent),
    types: rows.map(r => r.querySelector('.vars-type').textContent),
    hiddenToggle: !!document.querySelector('.vars-panel input[type=checkbox]'),
  });
})()`;

const chrome = spawn('chromium-browser', ['--headless=new', '--no-sandbox', `--remote-debugging-port=${PORT}`, 'about:blank']);
await sleep(1200);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
const cdp = new Cdp(ws);
await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

const open = async (reload = false) => {
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:8090/' + (reload ? '?r=2' : '') });
  await sleep(2200);
  await cdp.eval('window.__noConfirm = true; true');
  await cdp.eval(`window.__emu.setSketch(${JSON.stringify(SKETCH)}); true`);
  const ran = await cdp.eval(`(() => { const b = document.querySelector('.btn-run'); if (!b) return 'no-run-btn'; b.click(); return 'clicked'; })()`);
  if (ran !== 'clicked') throw new Error('Run button: ' + ran);
  await sleep(900);
  await cdp.eval(`(() => { const t = [...document.querySelectorAll('.dock-tab')].find(x => /Variables/.test(x.textContent)); t.click(); return true; })()`);
  await sleep(700);
};

await open();
let st = JSON.parse(await cdp.eval(PAGE));
check('tab shows every global by default',
  JSON.stringify(st.names) === JSON.stringify(['counter', 'last', 'LIMIT', 'label', 'steps', 'armed']),
  st.names.join(','));
check('types are as written',
  st.types.join('|') === 'int|unsigned long|const int|String|int[4]|bool',
  st.types.join('|'));
check('values are live', Number(st.values[0]) >= 1 && st.values[3] === '"roleta"' && st.values[4] === '[1, 2, 3, 4]',
  st.values.join(' '));

const before = Number(JSON.parse(await cdp.eval(PAGE)).values[0]);
await sleep(900);
const after = Number(JSON.parse(await cdp.eval(PAGE)).values[0]);
check('the list follows the running sketch', after > before, `${before} -> ${after}`);

// hide the first row
await cdp.eval(`(() => { const r = document.querySelector('.vars-row'); [...r.querySelectorAll('button')].find(b => b.textContent === 'hide').click(); return true; })()`);
await sleep(400);
st = JSON.parse(await cdp.eval(PAGE));
check('hide removes that row', !st.names.includes('counter') && st.names.length === 5, st.names.join(','));
check('a hidden list is offered', st.hiddenToggle, String(st.hiddenToggle));
const stored = await cdp.eval(`localStorage.getItem('esp8266-emu.vars')`);
check('layout is persisted', !!stored && JSON.parse(stored).hidden.includes('counter'), String(stored));

// reload: the layout must come back
await open(true);
st = JSON.parse(await cdp.eval(PAGE));
check('layout survives a reload', !st.names.includes('counter') && st.names.length === 5, st.names.join(','));

// reveal the hidden ones and bring one back
await cdp.eval(`(() => { document.querySelector('.vars-panel input[type=checkbox]').click(); return true; })()`);
await sleep(300);
const offRows = await cdp.eval(`document.querySelectorAll('.vars-row.vars-off').length`);
check('hidden rows are listed when revealed', offRows === 1, String(offRows));
await cdp.eval(`(() => { const r = document.querySelector('.vars-row.vars-off'); [...r.querySelectorAll('button')].find(b => b.textContent === 'show').click(); return true; })()`);
await sleep(300);
st = JSON.parse(await cdp.eval(PAGE));
check('show brings it back at the end', st.names[st.names.length - 1] === 'counter', st.names.join(','));

// reorder with the arrows
await cdp.eval(`(() => { const r = document.querySelector('.vars-row'); [...r.querySelectorAll('button')].find(b => b.textContent === '\\u25BC').click(); return true; })()`);
await sleep(300);
st = JSON.parse(await cdp.eval(PAGE));
check('down arrow moves a row', st.names[1] === 'last' && st.names[0] !== 'last', st.names.join(','));
const upDisabled = await cdp.eval(`document.querySelector('.vars-row button[title="move up"]').disabled`);
check('first row cannot move up', upDisabled === true, String(upDisabled));

// reset returns declaration order and nothing hidden
await cdp.eval(`(() => { [...document.querySelectorAll('.vars-panel .mini-btn')].find(b => b.textContent === 'reset').click(); return true; })()`);
await sleep(300);
st = JSON.parse(await cdp.eval(PAGE));
check('reset restores declaration order',
  JSON.stringify(st.names) === JSON.stringify(['counter', 'last', 'LIMIT', 'label', 'steps', 'armed']),
  st.names.join(','));

const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
writeFileSync('/tmp/vars-panel.png', Buffer.from(shot.result.data, 'base64'));
console.log('INFO  screenshot: /tmp/vars-panel.png');
console.log(fails.length ? `${fails.length} FAILED` : 'ALL OK');
chrome.kill('SIGKILL');
process.exit(fails.length ? 1 : 0);
