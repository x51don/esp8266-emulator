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
