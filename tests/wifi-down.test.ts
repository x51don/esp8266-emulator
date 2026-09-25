/**
 * F3 (repair 3/6): the access point can disappear.
 *
 * WiFi used to be a stopwatch: begin() always finished 1.5 s later, so no
 * sketch could be shown failing to associate, and a `while (waitForConnectResult()
 * != WL_CONNECTED)` recovery loop was untestable - it either passed or wedged
 * the interpreter. setWifiDown(true) takes the AP away: the link drops, joins
 * do not finish while it is gone, and waitForConnectResult() returns its own
 * timeout (WL_DISCONNECTED) instead of parking the sketch forever.
 */
import { describe, it, expect } from 'vitest';
import { Esp8266Machine } from '../core/machine';

const machine = () => new Esp8266Machine({ board: 'wemos-d1-mini' });

/** Serial lines without the empty ones println leaves behind. */
const out = (m: Esp8266Machine): string[] =>
  m.serial.map((l) => l.text).filter((t) => t !== '');
const last = (m: Esp8266Machine): string => {
  const o = out(m);
  return o[o.length - 1];
};

describe('the AP disappears (F3)', () => {
  it('isConnected() drops to 0 while the AP is gone and returns after it', () => {
    const m = machine();
    m.load(`
      void setup() {
        Serial.begin(9600);
        WiFi.begin("net", "pw");
        WiFi.waitForConnectResult();
        Serial.println(WiFi.isConnected());
      }
      void loop() { Serial.println(WiFi.isConnected()); delay(100); }
    `);
    m.run();
    m.advance(2000);
    expect(out(m)[0]).toBe('1');

    m.setWifiDown(true);
    m.advance(250);
    expect(last(m)).toBe('0');
    m.advance(1000);
    expect(last(m)).toBe('0'); // it does not come back on its own

    m.setWifiDown(false);
    m.advance(500);
    expect(last(m)).toBe('0'); // re-association takes its time
    m.advance(2000);
    expect(last(m)).toBe('1');
  });

  it('a join started while the AP is gone never finishes; it completes once it returns', () => {
    const m = machine();
    m.setWifiDown(true);
    m.load(`
      void setup() {
        Serial.begin(9600);
        WiFi.begin("net", "pw");
      }
      void loop() { Serial.println(WiFi.isConnected()); delay(100); }
    `);
    m.run();
    m.advance(10000); // ten times the association latency: still no link
    expect(out(m).length).toBeGreaterThan(5);
    expect(out(m).every((l) => l === '0')).toBe(true);

    m.setWifiDown(false);
    m.advance(2000);
    expect(last(m)).toBe('1');
  });

  it('waitForConnectResult ends on its own timeout and the sketch keeps running', () => {
    const m = machine();
    m.setWifiDown(true);
    m.load(`
      void setup() {
        Serial.begin(9600);
        WiFi.begin("net", "pw");
        unsigned long t0 = millis();
        int r = WiFi.waitForConnectResult(2000);
        Serial.println(r);
        Serial.println(millis() - t0 >= 2000 ? 1 : 0);
        Serial.println("alive");
      }
      void loop() { delay(10); }
    `);
    m.run();
    m.advance(3000);
    // 6 = WL_DISCONNECTED: the wait gave up, it did not hang, and it cost
    // the caller the whole 2 s it asked for
    expect(out(m)).toEqual(['6', '1', 'alive']);
  });

  it('a join already parked in waitForConnectResult finishes when the AP returns', () => {
    const m = machine();
    m.load(`
      void setup() {
        Serial.begin(9600);
        WiFi.begin("net", "pw");
        int r = WiFi.waitForConnectResult(10000);
        Serial.println(r);
        Serial.println(WiFi.localIP());
      }
      void loop() { delay(10); }
    `);
    m.run();
    m.advance(1000);
    m.setWifiDown(true); // the AP dies mid-association
    m.advance(3000);
    expect(out(m)).toEqual([]);
    m.setWifiDown(false);
    m.advance(1000);
    expect(out(m)).toEqual([]);
    m.advance(1500);
    expect(out(m)).toEqual(['3', '192.168.1.42']);
  });

  it('a recovery loop keeps ticking instead of wedging the interpreter', () => {
    const m = machine();
    m.setWifiDown(true);
    m.load(`
      void setup() {
        Serial.begin(9600);
        WiFi.begin("net", "pw");
      }
      void loop() {
        while (WiFi.waitForConnectResult(1000) != 3) {
          Serial.print("down ");
          Serial.println(WiFi.status());
        }
        Serial.print("up ");
        Serial.println(WiFi.localIP());
        delay(1000);
      }
    `);
    m.run();
    m.advance(3200); // three 1 s waits, each one returning on its own
    expect(out(m).slice(0, 3)).toEqual(['down 6', 'down 6', 'down 6']);

    m.setWifiDown(false);
    m.advance(2000);
    expect(out(m)).toContain('up 192.168.1.42');
  });

  it('a soft-AP goes down with the radio and comes back up', () => {
    const m = machine();
    m.load(`
      void setup() {
        Serial.begin(9600);
        WiFi.mode(WIFI_AP);
        WiFi.softAP("net");
      }
      void loop() { Serial.println(WiFi.softAPIP()); delay(100); }
    `);
    m.run();
    m.advance(1000);
    expect(last(m)).toBe('192.168.4.1');
    m.setWifiDown(true);
    m.advance(250);
    expect(last(m)).toBe('0.0.0.0');
    m.setWifiDown(false);
    m.advance(1000);
    expect(last(m)).toBe('192.168.4.1');
  });

  it('clearing an outage that was never set changes nothing', () => {
    const m = machine();
    m.load(`
      void setup() {
        Serial.begin(9600);
        WiFi.begin("net", "pw");
        WiFi.waitForConnectResult();
      }
      void loop() { Serial.println(WiFi.isConnected()); delay(100); }
    `);
    m.run();
    m.advance(2000);
    m.setWifiDown(false);
    m.advance(150);
    expect(last(m)).toBe('1');
  });

  it('an outage on the server costs its clients the whole timeout', () => {
    const server = new Esp8266Machine({ board: 'wemos-d1-mini', ip: '192.168.1.61' });
    const client = new Esp8266Machine({ board: 'wemos-d1-mini', ip: '192.168.1.62' });
    server.load(`
      ESP8266WebServer server(80);
      void setup() {
        Serial.begin(9600);
        server.on("/ping", HTTP_GET, []() { server.send(200, "text/plain", "pong"); });
        server.begin();
      }
      void loop() { server.handleClient(); delay(10); }
    `);
    client.load(`
      HTTPClient http;
      void setup() { Serial.begin(9600); }
      void loop() {
        http.begin("http://192.168.1.61/ping");
        http.setTimeout(1500);
        Serial.println(http.GET());
        http.end();
        delay(500);
      }
    `);
    server.run();
    client.run();
    client.advance(1000);
    expect(out(client).length).toBeGreaterThan(0);
    expect(out(client).every((l) => l === '200')).toBe(true);

    const before = out(client).length;
    server.setWifiDown(true);
    client.advance(4200); // attempts now burn the client's whole timeout
    const during = out(client).slice(before);
    expect(during.length).toBeGreaterThanOrEqual(2);
    expect(during.every((l) => l === '-1')).toBe(true);

    const beforeHeal = out(client).length;
    server.setWifiDown(false);
    client.advance(4200);
    expect(out(client).slice(beforeHeal).every((l) => l === '200')).toBe(true);
    expect(out(client).length).toBeGreaterThan(beforeHeal);
    server.dispose();
    client.dispose();
  });

  it('the chip answers nobody over the LAN while its radio is down', () => {
    const m = new Esp8266Machine({ board: 'wemos-d1-mini', ip: '192.168.1.63' });
    m.load(`
      ESP8266WebServer server(80);
      void setup() {
        Serial.begin(9600);
        server.on("/ping", HTTP_GET, []() { server.send(200, "text/plain", "pong"); });
        server.begin();
      }
      void loop() { server.handleClient(); delay(10); }
    `);
    m.run();
    m.advance(100);
    expect(m.fetchHttp('GET', 'http://192.168.1.63/ping')?.status).toBe(200);
    m.setWifiDown(true);
    expect(m.fetchHttp('GET', 'http://192.168.1.63/ping')).toBeNull();
    m.setWifiDown(false);
    m.advance(100);
    expect(m.fetchHttp('GET', 'http://192.168.1.63/ping')?.status).toBe(200);
    m.dispose();
  });

  it('the criterion: blink + HTTP blinks through the outage and reconnects after', () => {
    const server = new Esp8266Machine({ board: 'wemos-d1-mini', ip: '192.168.1.65' });
    const node = new Esp8266Machine({ board: 'wemos-d1-mini', ip: '192.168.1.64' });
    server.load(`
      ESP8266WebServer server(80);
      void setup() {
        Serial.begin(9600);
        server.on("/ping", HTTP_GET, []() { server.send(200, "text/plain", "pong"); });
        server.begin();
      }
      void loop() { server.handleClient(); delay(10); }
    `);
    node.load(`
      HTTPClient http;
      unsigned long t0 = 0;
      void setup() {
        pinMode(2, OUTPUT);
        Serial.begin(9600);
        WiFi.begin("net", "pw");
      }
      void loop() {
        if (millis() - t0 >= 500) {
          t0 = millis();
          digitalWrite(2, HIGH);
          Serial.print("link ");
          Serial.println(WiFi.isConnected());
          Serial.print("ip ");
          Serial.println(WiFi.localIP());
          if (WiFi.isConnected()) {
            http.begin("http://192.168.1.65/ping");
            http.setTimeout(1500);
            Serial.print("http ");
            Serial.println(http.GET());
            http.end();
          }
          digitalWrite(2, LOW);
        }
        delay(50);
      }
    `);
    server.run();
    node.run();
    node.advance(3000); // 1.5 s association, then a 500 ms report tick
    expect(out(node).slice(-3)).toEqual(['link 1', 'ip 192.168.1.64', 'http 200']);

    node.setWifiDown(true);
    const before = out(node).length;
    node.advance(3000);
    const during = out(node).slice(before);
    // the sketch is alive: it keeps blinking and reporting, and reports dead
    expect(during.length).toBeGreaterThanOrEqual(8);
    expect(during.filter((l) => l === 'link 0').length).toBeGreaterThanOrEqual(3);
    expect(during.some((l) => l.startsWith('http'))).toBe(false);
    expect(during.filter((l) => l.startsWith('ip ')).every((l) => l === 'ip 0.0.0.0')).toBe(true);

    node.setWifiDown(false);
    node.advance(3000);
    const after = out(node).slice(out(node).length - 3);
    expect(after).toEqual(['link 1', 'ip 192.168.1.64', 'http 200']);
    server.dispose();
    node.dispose();
  });
});
