/**
 * F2 syntax upgrade: lambdas as values, reference (copy-out) parameters,
 * `T*` declarators, `volatile` qualifier, constructor-style declarations
 * for object tokens, and dynamic dispatch of a function held in a variable.
 */
import { describe, it, expect } from 'vitest';
import { parse } from '../core/sketch/parser';
import { Esp8266Machine } from '../core/machine';

const machine = (board = 'wemos-d1-mini') => new Esp8266Machine({ board });

describe('lambdas (F2)', () => {
  it('a [](){} literal parses into a synthetic function and yields a callable value', () => {
    const m = machine();
    m.load(`
      int callIt(int f) { f(); return 7; }
      void setup() {
        Serial.begin(9600);
        int r = callIt([]() { Serial.println("in lambda"); });
        Serial.println(r);
      }
      void loop() { delay(1); }
    `);
    m.run();
    const t = m.serial.map((l) => l.text);
    expect(t).toContain('in lambda');
    expect(t).toContain('7');
  });

  it('lambda parameters work through dynamic dispatch', () => {
    const m = machine();
    m.load(`
      int call2(int f, int a) { return f(a); }
      void setup() {
        Serial.begin(9600);
        Serial.println(call2([](int x) { return x * 3; }, 5));
      }
      void loop() { delay(1); }
    `);
    m.run();
    expect(m.serial.map((l) => l.text)).toContain('15');
  });

  it('lambda stored in a variable stays callable', () => {
    const m = machine();
    m.load(`
      int fire(int f) { return f(); }
      int cb = 0;
      void setup() {
        Serial.begin(9600);
        cb = []() { return 42; };
        Serial.println(fire(cb));
      }
      void loop() { delay(1); }
    `);
    m.run();
    expect(m.serial.map((l) => l.text)).toContain('42');
  });

  it('captures ([x], [=], [&]) are rejected with a clear message', () => {
    expect(() => parse('void setup() { int f = [x]() { return x; }; } void loop(){}')).toThrow(/capture/);
    expect(() => parse('void setup() { int f = [=]() { }; } void loop(){}')).toThrow(/capture/);
  });
});

describe('reference parameters (F2)', () => {
  it('int &out writes the value back into the caller variable', () => {
    const m = machine();
    m.load(`
      bool getArgValue(int idx, int &out) {
        if (idx != 1) return false;
        out = 99;
        return true;
      }
      void setup() {
        Serial.begin(9600);
        int val = -1;
        bool ok = getArgValue(1, val);
        Serial.println(ok);
        Serial.println(val);
        bool ok2 = getArgValue(0, val);
        Serial.println(val);
      }
      void loop() { delay(1); }
    `);
    m.run();
    expect(m.serial.map((l) => l.text)).toEqual(['1', '99', '99']);
  });

  it('String& fills the caller string', () => {
    const m = machine();
    m.load(`
      void hello(String &who) { who = "world"; }
      void setup() { Serial.begin(9600); String s = "x"; hello(s); Serial.println(s); }
      void loop() { delay(1); }
    `);
    m.run();
    expect(m.serial.map((l) => l.text)).toContain('world');
  });
});

describe('declarator sugar (F2)', () => {
  it('const char* and volatile parse; char* holds strings', () => {
    const m = machine();
    m.load(`
      const char* ssid = "HomeAP";
      volatile bool flag = false;
      void setup() {
        Serial.begin(9600);
        Serial.println(ssid);
        flag = true;
        Serial.println(flag);
      }
      void loop() { delay(1); }
    `);
    m.run();
    expect(m.serial.map((l) => l.text)).toEqual(['HomeAP', '1']);
  });

  it('a & reference parameter parses with the ampersand on the type too', () => {
    expect(() => parse('void f(int& x) { x = 1; } void setup(){} void loop(){}')).not.toThrow();
  });
});

describe('constructor-style object declarations (F2)', () => {
  it('ESP8266WebServer server(80); and HTTPClient h; declare tokens', () => {
    const m = machine();
    m.load(`
      #include <ESP8266WebServer.h>
      ESP8266WebServer server(80);
      HTTPClient h;
      IPAddress ip(192, 168, 1, 60);
      void setup() { Serial.begin(9600); Serial.println("decl ok"); }
      void loop() { delay(1); }
    `);
    m.run();
    expect(m.serial.map((l) => l.text)).toContain('decl ok');
  });
});
