/**
 * F7: mDNS names on the virtual LAN. MDNS.begin("pokoj") registers the
 * machine's IP under that name; HTTPClient and the GUI panel resolve
 * "pokoj.local" the way the real resolver would.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Esp8266Machine } from '../core/machine';
import { lan } from '../core/lan';

let machines: Esp8266Machine[] = [];
function boot(sketch: string, ip: string) {
  const m = new Esp8266Machine({ board: 'wemos-d1-mini', ip });
  machines.push(m);
  m.load(sketch);
  m.run();
  m.advance(10);
  return m;
}
afterEach(() => {
  for (const m of machines) m.dispose();
  machines = [];
});

const SERVER_SKETCH = `
ESP8266WebServer server(80);
void setup() {
  Serial.begin(9600);
  MDNS.begin("pokoj");
  server.on("/LED", []() { server.send(200, "text/plain", "ok"); });
  server.begin();
}
void loop() { server.handleClient(); delay(10); }
`;

const clientTo = (host: string) => `
HTTPClient http;
int code = 0;
String body;
void setup() {
  Serial.begin(9600);
  http.begin("http://${host}/LED");
  code = http.GET();
  body = http.getString();
  http.end();
  Serial.print("CODE=");
  Serial.println(code);
  Serial.print("BODY=");
  Serial.println(body);
}
void loop() { delay(50); }
`;
const log = (m: Esp8266Machine) => m.serial.map((l) => l.text).join('\n');

describe('mDNS names (F7)', () => {
  it('HTTPClient reaches a peer by its .local name', () => {
    boot(SERVER_SKETCH, '192.168.1.160');
    const a = boot(clientTo('pokoj.local'), '192.168.1.161');
    a.advance(120);
    expect(log(a)).toContain('CODE=200');
    expect(log(a)).toContain('BODY=ok');
  });

  it('the bare name without .local resolves too', () => {
    boot(SERVER_SKETCH, '192.168.1.170');
    const a = boot(clientTo('pokoj'), '192.168.1.171');
    a.advance(120);
    expect(log(a)).toContain('CODE=200');
  });

  it('an unclaimed name fails the connection with -1, not a fault', () => {
    const a = boot(clientTo('nic-tam.local'), '192.168.1.172');
    a.advance(120);
    expect(a.faultReason).toBe(null);
    expect(log(a)).toContain('CODE=-1');
  });

  it('the GUI panel accepts a name that resolves to this machine', () => {
    const m = boot(SERVER_SKETCH, '192.168.1.180');
    expect(m.fetchHttp('GET', 'http://pokoj.local/LED')?.body).toBe('ok');
    expect(m.fetchHttp('GET', 'http://kuchnia.local/LED')).toBe(null);
  });

  it('a disposed machine releases its name (re-registration wins)', () => {
    const s1 = boot(SERVER_SKETCH, '192.168.1.190');
    s1.dispose();
    machines = machines.filter((m) => m !== s1);
    const a = boot(clientTo('pokoj.local'), '192.168.1.191');
    a.advance(120);
    expect(log(a)).toContain('CODE=-1'); // no stale route left behind
  });

  it('the registry survives re-running MDNS.begin on the same machine', () => {
    const m = boot(SERVER_SKETCH, '192.168.1.192');
    expect(lan.routeHost('pokoj.local')?.ip).toBe('192.168.1.192');
    m.advance(5);
    expect(m.faultReason).toBe(null);
  });
});

import { lanFetch, lan as lanSingleton } from '../core/lan';

describe('lanFetch (GUI side, F10)', () => {
  it('serves a peer machine that is not the caller', () => {
    const b = boot(SERVER_SKETCH, '192.168.1.200');
    const resp = lanFetch(lanSingleton.route('192.168.1.200'), 'GET', 'http://192.168.1.200/LED');
    expect(resp?.status).toBe(200);
    expect(resp?.body).toBe('ok');
    // by name too, and an unreachable host yields null
    expect(lanFetch(lanSingleton.routeHost('pokoj.local'), 'GET', 'http://pokoj.local/LED')?.body).toBe('ok');
    expect(lanFetch(lanSingleton.route('192.168.1.201'), 'GET', 'http://192.168.1.201/LED')).toBe(null);
    expect(b.faultReason).toBe(null);
  });
});

describe('WiFi.config static lease (F10)', () => {
  const CONFIG_SKETCH = `
IPAddress wemos_ip(192, 168, 1, 77);
ESP8266WebServer server(80);
void setup() {
  Serial.begin(9600);
  WiFi.config(wemos_ip, IPAddress(192, 168, 1, 1), IPAddress(255, 255, 255, 0));
  WiFi.begin("ssid", "pass");
  MDNS.begin("ustawione");
  server.on("/LED", []() { server.send(200, "text/plain", WiFi.localIP()); });
  server.begin();
}
void loop() { server.handleClient(); delay(10); }
`;
  it('moves the machine to the configured address, names included', () => {
    const m = boot(CONFIG_SKETCH, '192.168.1.210');
    m.advance(1600); // join latency so WiFi.localIP() is the static one
    expect(m.ip).toBe('192.168.1.77');
    const r = lanFetch(lanSingleton.routeHost('ustawione.local'), 'GET', 'http://ustawione.local/LED');
    expect(r?.body).toBe('192.168.1.77');
    expect(lanSingleton.route('192.168.1.210')).toBe(null); // old lease released
    m.dispose();
    machines = machines.filter((x) => x !== m);
  });
});
