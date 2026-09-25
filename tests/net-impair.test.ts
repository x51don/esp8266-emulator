/**
 * F2: the LAN used to be binary - a registered host answered instantly, an
 * unregistered one failed instantly. A real ESP8266 sits in connect()/read()
 * until its own timeout expires, and a peer can be alive but slow, or slow
 * only today. These tests drive the sketch's own HTTPClient against an
 * impaired peer and check what the CLIENT's clock says afterwards.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Esp8266Machine } from '../core/machine';
import { lan } from '../core/lan';

const m = (ip: string) => new Esp8266Machine({ board: 'wemos-d1-mini', ip });

const SERVER = `
  ESP8266WebServer server(80);
  int hits = 0;
  void setup() {
    Serial.begin(9600);
    server.on("/ping", HTTP_GET, []() { hits++; server.send(200, "text/plain", "pong"); });
    server.on("/HITS", HTTP_GET, []() { server.send(200, "text/plain", String(hits)); });
    server.begin();
  }
  void loop() { server.handleClient(); delay(10); }
`;

/** One GET with a 1500 ms timeout; prints the code and the client's millis(). */
const CLIENT = `
  HTTPClient http;
  void setup() {
    Serial.begin(9600);
    http.begin("http://192.168.1.42/ping");
    http.setTimeout(1500);
    Serial.println(http.GET());
    Serial.println(millis());
    Serial.println(http.getString());
  }
  void loop() { delay(10); }
`;

const lines = (x: Esp8266Machine) => x.serial.map((l) => l.text);

/** Boot a server, then a client that fires one GET at it. */
function pair(clientIp = '192.168.1.10'): [Esp8266Machine, Esp8266Machine] {
  const server = m('192.168.1.42');
  server.load(SERVER);
  server.run();
  const client = m(clientIp);
  client.load(CLIENT);
  return [client, server];
}

describe('per-host network impairments (F2)', () => {
  afterEach(() => {
    lan.clearImpairments('192.168.1.42');
    lan.clearImpairments('192.168.1.10');
    lan.clearImpairments('192.168.1.11');
  });

  it('an healthy peer answers in well under a millisecond of client time', () => {
    const [client, server] = pair();
    client.run();
    client.advance(2000);
    expect(lines(client)).toEqual(['200', expect.any(String), 'pong']);
    expect(Number(client.serial[1].text)).toBeLessThan(20);
    client.dispose();
    server.dispose();
  });

  it('latency 300 ms: the call succeeds and the CLIENT clock moves by ~300 ms', () => {
    const [client, server] = pair();
    lan.setPeerLatency('192.168.1.42', 300);
    client.run();
    client.advance(2000);
    expect(lines(client).slice(0, 2)).toEqual(['200', expect.any(String)]);
    const t = Number(client.serial[1].text);
    expect(t).toBeGreaterThanOrEqual(300);
    expect(t).toBeLessThan(310);
    expect(client.serial[2].text).toBe('pong');
    client.dispose();
    server.dispose();
  });

  it('latency 3000 ms with a 1500 ms timeout: -1 after exactly the timeout', () => {
    const [client, server] = pair();
    lan.setPeerLatency('192.168.1.42', 3000);
    client.run();
    client.advance(2000);
    expect(lines(client)).toEqual(['-1', '1500', '']);
    // the peer did answer - the reply just arrived after the client gave up
    expect(server.fetchHttp('GET', 'http://192.168.1.42/HITS')?.body).toBe('1');
    client.dispose();
    server.dispose();
  });

  it('unreachable: the client hangs for its whole timeout and then fails', () => {
    const [client, server] = pair();
    lan.setPeerUnreachable('192.168.1.42');
    client.run();
    client.advance(2000);
    expect(lines(client)).toEqual(['-1', '1500', '']);
    // nothing reached the peer: the wire swallowed the request itself
    expect(server.fetchHttp('GET', 'http://192.168.1.42/HITS')?.body).toBe('0');
    client.dispose();
    server.dispose();
  });

  it('down: connection refused, the client fails without wasting its timeout', () => {
    const [client, server] = pair();
    lan.setPeerDown('192.168.1.42');
    client.run();
    client.advance(2000);
    expect(Number(lines(client)[0])).toBe(-1);
    expect(Number(client.serial[1].text)).toBeLessThan(5);
    expect(server.fetchHttp('GET', 'http://192.168.1.42/HITS')?.body).toBe('0');
    client.dispose();
    server.dispose();
  });

  it('clearImpairments brings the peer back for the next call', () => {
    const [client, server] = pair();
    lan.setPeerDown('192.168.1.42');
    client.run();
    client.advance(2000);
    expect(Number(lines(client)[0])).toBe(-1);
    client.dispose();

    lan.clearImpairments('192.168.1.42');
    const back = m('192.168.1.11');
    back.load(CLIENT);
    back.run();
    back.advance(2000);
    expect(lines(back).slice(0, 1)).toEqual(['200']);
    expect(back.serial[2].text).toBe('pong');
    back.dispose();
    server.dispose();
  });

  it('impairments are per host: a slow peer does not slow the whole LAN', () => {
    const [client, server] = pair();
    const other = m('192.168.1.77');
    other.load(SERVER);
    other.run();
    lan.setPeerDown('192.168.1.42');
    client.load(`
      HTTPClient http;
      void setup() {
        Serial.begin(9600);
        http.begin("http://192.168.1.77/ping");
        http.setTimeout(1500);
        Serial.println(http.GET());
        Serial.println(millis());
      }
      void loop() { delay(10); }
    `);
    client.run();
    client.advance(2000);
    expect(lines(client)[0]).toBe('200');
    expect(Number(client.serial[1].text)).toBeLessThan(20);
    client.dispose();
    server.dispose();
    other.dispose();
  });

  it('an mDNS name and its IP name the same peer', () => {
    const [client, server] = pair();
    client.load(`
      HTTPClient http;
      void setup() {
        Serial.begin(9600);
        MDNS.begin("client");
        WiFi.begin("net", "pw");
        http.begin("http://roleta/ping");
        http.setTimeout(1500);
        Serial.println(http.GET());
        Serial.println(millis());
      }
      void loop() { delay(10); }
    `);
    server.load(SERVER.replace('server.begin();', 'MDNS.begin("roleta"); server.begin();'));
    server.run();
    lan.setPeerLatency('192.168.1.42', 400);
    client.run();
    client.advance(3000);
    expect(lines(client)[0]).toBe('200');
    expect(Number(client.serial[1].text)).toBeGreaterThanOrEqual(400);
    client.dispose();
    server.dispose();
  });

  it('a machine that goes away stops being impaired (no stale table rows)', () => {
    const [client, server] = pair();
    lan.setPeerDown('192.168.1.42');
    expect(lan.impairmentFor('192.168.1.42')?.kind).toBe('down');
    server.dispose();
    expect(lan.impairmentFor('192.168.1.42')).toBe(null);
    client.dispose();
  });

  it('the machine facade exposes the same controls', () => {
    const [client, server] = pair();
    client.setPeerLatency('192.168.1.42', 250);
    client.run();
    client.advance(2000);
    expect(Number(client.serial[1].text)).toBeGreaterThanOrEqual(250);
    client.clearImpairments('192.168.1.42');
    client.dispose();
    server.dispose();
  });
});
