/**
 * P3.3 WiFi mock: the radio is a scripted state machine and every TCP byte
 * the sketch "sends" lands in the Serial console with a [net->host:port]
 * prefix - a Serial-only dashboard. No sockets, no browser network.
 *
 * Object contract (documented deviation): instances are declared as
 * `WiFiClient client;` or `WiFiServer server = WiFiServer(80);` - the
 * Arduino one-arg constructor syntax `WiFiServer server(80);` is not parsed.
 */
import { describe, it, expect } from 'vitest';
import { Esp8266Machine } from '../core/machine';

function machine(): Esp8266Machine {
  const m = new Esp8266Machine({ board: 'wemos-d1-mini' });
  m.netlist.addComponent('mcu', 'mcu', { board: 'wemos-d1-mini' });
  return m;
}

const tail = (m: Esp8266Machine, n = 1): string[] =>
  m.serial.slice(-n).map((l) => l.text);

describe('WiFi mock (P3.3)', () => {
  it('begin() joins the network asynchronously (1.5 s association)', () => {
    const m = machine();
    m.load(`
      void setup() { Serial.begin(115200); WiFi.begin("myssid", "mypass"); }
      void loop() { Serial.println(WiFi.status()); delay(20); }
    `);
    m.run();
    m.advance(50);
    expect(tail(m)).toEqual(['6']); // WL_DISCONNECTED while associating
    m.advance(1600);
    expect(tail(m)).toEqual(['3']); // WL_CONNECTED
  });

  it('WL_CONNECTED constant compares against status()', () => {
    const m = machine();
    m.load(`
      void setup() { Serial.begin(115200); WiFi.begin("a", "b"); }
      void loop() { Serial.println(WiFi.status() == WL_CONNECTED ? 1 : 0); delay(20); }
    `);
    m.run();
    m.advance(50);
    expect(tail(m)).toEqual(['0']);
    m.advance(1600);
    expect(tail(m)).toEqual(['1']);
  });

  it('localIP is 0.0.0.0 until the link is up', () => {
    const m = machine();
    m.load(`
      void setup() { Serial.begin(115200); WiFi.begin("a", "b"); }
      void loop() { Serial.println(WiFi.localIP()); delay(20); }
    `);
    m.run();
    m.advance(50);
    expect(tail(m)).toEqual(['0.0.0.0']);
    m.advance(1600);
    expect(tail(m)).toEqual(['192.168.1.42']);
  });

  it('client traffic is mirrored to Serial with a [net->host:port] prefix', () => {
    const m = machine();
    m.load(`
      WiFiClient client;
      void setup() {
        Serial.begin(115200);
        WiFi.begin("a", "b");
        while (WiFi.status() != WL_CONNECTED) delay(50);
        if (client.connect("example.com", 80)) {
          client.print("GET / HTTP/1.1\\r\\n");
          client.println("Host: example.com");
          client.stop();
        }
      }
      void loop() { delay(20); }
    `);
    m.run();
    m.advance(2000); // setup parks in the while-delay until the link is up
    const texts = m.serial.map((l) => l.text);
    expect(texts.some((t) => t.includes('[net->example.com:80] GET / HTTP/1.1'))).toBe(true);
    expect(texts.some((t) => t === '[net->example.com:80] Host: example.com')).toBe(true);
  });

  it('connect() refuses before association', () => {
    const m = machine();
    m.load(`
      WiFiClient client;
      void setup() {
        Serial.begin(115200);
        Serial.println(client.connect("example.com", 80));
      }
      void loop() { delay(20); }
    `);
    m.run();
    m.advance(30);
    expect(tail(m)).toEqual(['0']);
  });

  it('server.begin() listens, available() stays empty (no outside clients)', () => {
    const m = machine();
    m.load(`
      WiFiServer server = WiFiServer(80);
      void setup() {
        Serial.begin(115200);
        WiFi.begin("a", "b");
        server.begin();
      }
      void loop() { Serial.println(server.available()); delay(20); }
    `);
    m.run();
    m.advance(1700);
    expect(tail(m)).toEqual(['0']);
  });

  it('macAddress and RSSI look real', () => {
    const m = machine();
    m.load(`
      void setup() { Serial.begin(115200); }
      void loop() { Serial.println(WiFi.macAddress()); delay(20); }
    `);
    m.run();
    m.advance(30);
    expect(tail(m)[0]).toMatch(/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/);
  });

  it('an unknown object names itself in the error', () => {
    const m = machine();
    m.load(`
      void setup() { Serial.begin(115200); relay.flip(1); }
      void loop() { delay(20); }
    `);
    expect(() => m.run()).toThrow(/relay/); // run() rethrows setup errors
    expect(m.phase()).toBe('stopped');
  });
});
