/**
 * F5: virtual LAN + ESP8266WebServer + HTTPClient.
 * Machine A talks HTTP to machine B (and to the GUI panel via fetchHttp)
 * with the sketch's handleClient() doing the real serving.
 */
import { describe, it, expect } from 'vitest';
import { Esp8266Machine } from '../core/machine';
import { lan } from '../core/lan';

const m = (ip: string) => new Esp8266Machine({ board: 'wemos-d1-mini', ip });

const SERVER_SKETCH = `
  ESP8266WebServer server(80);
  int target = 0;
  void setup() {
    Serial.begin(9600);
    server.on("/ping", HTTP_GET, []() {
      server.send(200, "text/plain", "pong");
    });
    server.on("/TARGET", HTTP_GET, []() {
      int v = server.arg("value").toInt();
      target = constrain(v, 0, 100);
      String out = server.uri();
      out += "|";
      out += server.method();
      out += "|";
      out += server.argName(0);
      out += "=";
      out += String(target);
      out += "|";
      out += String(server.args());
      server.send(200, "text/plain", out);
    });
    server.on("/form", HTTP_POST, []() {
      server.send(200, "text/plain", server.arg("a") + "/" + server.arg("b"));
    });
    server.onNotFound([]() {
      server.send(404, "text/plain", "nope");
    });
    server.begin();
  }
  void loop() {
    server.handleClient();
    delay(10);
  }
`;

describe('ESP8266WebServer over the virtual LAN', () => {
  it('serves a GET and an onNotFound 404 through handleClient()', () => {
    const a = m('192.168.1.42');
    a.load(SERVER_SKETCH);
    a.run();
    const r = a.fetchHttp('GET', 'http://192.168.1.42/ping');
    expect(r).toEqual({ status: 200, body: 'pong' });
    const nf = a.fetchHttp('GET', 'http://192.168.1.42/nope');
    expect(nf).toEqual({ status: 404, body: 'nope' });
    expect(a.faultReason).toBe(null);
    a.dispose();
  });

  it('uri/method/args/argName/arg feed a query string to the handler', () => {
    const a = m('192.168.1.42');
    a.load(SERVER_SKETCH);
    a.run();
    const r = a.fetchHttp('GET', 'http://192.168.1.42/TARGET?value=50');
    expect(r).toEqual({ status: 200, body: '/TARGET|GET|value=50|1' });
    // the v20 clamp: value=500 -> 100
    const r2 = a.fetchHttp('GET', 'http://192.168.1.42/TARGET?value=500');
    expect(r2!.body).toBe('/TARGET|GET|value=100|1');
    a.dispose();
  });

  it('POST arrives as form args', () => {
    const a = m('192.168.1.42');
    a.load(SERVER_SKETCH);
    a.run();
    const r = a.fetchHttp('POST', 'http://192.168.1.42/form', 'a=7&b=x');
    expect(r).toEqual({ status: 200, body: '7/x' });
    a.dispose();
  });

  it('a GET to a POST-only route falls through to 404', () => {
    const a = m('192.168.1.42');
    a.load(SERVER_SKETCH);
    a.run();
    const r = a.fetchHttp('GET', 'http://192.168.1.42/form');
    expect(r!.status).toBe(404);
    a.dispose();
  });

  it('no route on the LAN answers null, and a bare onNotFound-less server 404s', () => {
    const a = m('192.168.1.42');
    a.load(`
      ESP8266WebServer server(80);
      void setup() { server.begin(); }
      void loop() { server.handleClient(); delay(10); }
    `);
    a.run();
    const r = a.fetchHttp('GET', 'http://192.168.1.42/whatever');
    expect(r).toEqual({ status: 404, body: 'File not found:' });
    expect(a.fetchHttp('GET', 'http://10.0.0.9/ping')).toBe(null); // not this machine
    a.dispose();
  });

  it('handleClient serves one queued request per call, the panel pumps time', () => {
    const a = m('192.168.1.42');
    a.load(SERVER_SKETCH);
    a.run();
    const r = a.fetchHttp('GET', 'http://192.168.1.42/ping');
    expect(r!.status).toBe(200);
    // 10 ms loop + 1 ms pump steps: never more than a virtual frame's worth
    expect(a.timeMs()).toBeLessThan(2000);
    a.dispose();
  });
});

describe('HTTPClient across two machines', () => {
  it('machine A fetches machine B (GET + getString + end)', () => {
    const b = m('192.168.1.42');
    b.load(SERVER_SKETCH);
    b.run();
    const a = m('192.168.1.10');
    a.load(`
      HTTPClient http;
      void setup() {
        Serial.begin(9600);
        http.begin("http://192.168.1.42/ping");
        int code = http.GET();
        Serial.println(code);
        Serial.println(http.getString());
        http.end();
      }
      void loop() { delay(10); }
    `);
    a.run();
    expect(a.serial.map((l) => l.text)).toEqual(['200', 'pong']);
    a.dispose();
    b.dispose();
  });

  it('an unknown peer returns -1 and a peer_cmd-style retry loop ends', () => {
    const a = m('192.168.1.10');
    a.load(`
      HTTPClient http;
      void setup() {
        Serial.begin(9600);
        int tries = 0;
        while (tries < 3) {
          http.begin("http://192.168.1.150/TARGET?value=50");
          int code = http.GET();
          http.end();
          if (code > 0) break;
          tries++;
        }
        Serial.println(tries);
      }
      void loop() { delay(10); }
    `);
    a.run();
    expect(a.serial.map((l) => l.text)).toEqual(['3']);
    a.dispose();
  });

  it('query params from a target URL reach B\'s handler', () => {
    const b = m('192.168.1.42');
    b.load(SERVER_SKETCH);
    b.run();
    const a = m('192.168.1.10');
    a.load(`
      HTTPClient http;
      void setup() {
        Serial.begin(9600);
        http.begin("http://192.168.1.42/TARGET?value=80");
        Serial.println(http.GET());
        Serial.println(http.getString());
        http.end();
      }
      void loop() { delay(10); }
    `);
    a.run();
    expect(a.serial.map((l) => l.text)).toEqual(['200', '/TARGET|GET|value=80|1']);
    expect(b.timeMs()).toBeGreaterThan(0); // B was actually pumped
    a.dispose();
    b.dispose();
  });

  it('HTTPClient with a WiFiClient argument and separate host/port/path', () => {
    const b = m('192.168.1.42');
    b.load(SERVER_SKETCH);
    b.run();
    const a = m('192.168.1.10');
    a.load(`
      WiFiClient client;
      HTTPClient http;
      void setup() {
        Serial.begin(9600);
        http.begin(client, "192.168.1.42", 80, "/ping");
        Serial.println(http.GET());
        http.end();
      }
      void loop() { delay(10); }
    `);
    a.run();
    expect(a.serial.map((l) => l.text)).toEqual(['200']);
    a.dispose();
    b.dispose();
  });
});

describe('lan registry', () => {
  it('machines leave the registry when disposed', () => {
    const a = m('192.168.1.77');
    a.load(`
      ESP8266WebServer server(80);
      void setup() { server.begin(); }
      void loop() { server.handleClient(); delay(10); }
    `);
    a.run();
    expect(lan.route('192.168.1.77')).not.toBe(null);
    a.dispose();
    expect(lan.route('192.168.1.77')).toBe(null);
  });
});
