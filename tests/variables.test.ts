/**
 * Live view of a sketch's globals: what the GUI's Variables panel shows.
 * The interpreter already keeps every global in one map, so the contract here
 * is a stable, ordered, honest snapshot - declaration order, declared type,
 * and the value the sketch holds right now.
 */
import { describe, it, expect } from 'vitest';
import { Esp8266Machine } from '../core/machine';

const boot = (src: string): Esp8266Machine => {
  const m = new Esp8266Machine({ board: 'wemos-d1-mini' });
  m.load(src);
  m.run();
  return m;
};

const WATCHED = `
  int counter = 0;
  unsigned long last = 0;
  const int LIMIT = 5;
  String label = "roleta";
  int steps[4] = {1, 2, 3, 4};
  bool armed = true;
  void setup() { Serial.begin(9600); }
  void loop() { counter++; last = millis(); delay(50); }
`;

const named = (m: Esp8266Machine, name: string) =>
  m.variables().find((v) => v.name === name);

describe('variable watch (core)', () => {
  it('lists the globals in declaration order with their declared types', () => {
    const m = boot(WATCHED);
    expect(m.variables().map((v) => v.name)).toEqual([
      'counter',
      'last',
      'LIMIT',
      'label',
      'steps',
      'armed',
    ]);
    expect(named(m, 'last')!.type).toBe('unsigned long');
    expect(named(m, 'counter')!.type).toBe('int');
    m.dispose();
  });

  it('reports the value the sketch holds right now', () => {
    const m = boot(WATCHED);
    m.advance(120);
    expect(named(m, 'counter')!.value).toBe(3);
    expect(named(m, 'label')!.value).toBe('roleta');
    expect(named(m, 'armed')!.value).toBe(1);
    expect(Number(named(m, 'last')!.value)).toBeGreaterThan(0);
    m.dispose();
  });

  it('marks constants so the panel can tell them apart', () => {
    const m = boot(WATCHED);
    expect(named(m, 'LIMIT')!.value).toBe(5);
    expect(named(m, 'LIMIT')!.isConst).toBe(true);
    expect(named(m, 'counter')!.isConst).toBe(false);
    m.dispose();
  });

  it('shows arrays as their elements, not as a pointer', () => {
    const m = boot(WATCHED);
    const steps = named(m, 'steps')!;
    expect(steps.kind).toBe('array');
    expect(steps.length).toBe(4);
    expect(steps.elements).toEqual([1, 2, 3, 4]);
    m.dispose();
  });

  it('long arrays are capped so the panel stays readable', () => {
    const m = boot(`
      int buf[40];
      void setup(){ Serial.begin(9600); buf[39] = 7; }
      void loop(){ delay(50); }
    `);
    const buf = named(m, 'buf')!;
    expect(buf.length).toBe(40);
    expect(buf.elements!.length).toBe(16);
    expect(buf.elements![39 - 0]).toBeUndefined();
    expect(buf.elements![15]).toBe(0);
    m.dispose();
  });

  it('library objects show their class instead of an internal token', () => {
    const m = boot(`
      ESP8266WebServer server(80);
      HTTPClient http;
      int hits = 0;
      void setup(){ Serial.begin(9600); server.begin(); }
      void loop(){ server.handleClient(); delay(10); }
    `);
    const names = m.variables().map((v) => v.name);
    expect(names).toEqual(['server', 'http', 'hits']);
    expect(named(m, 'server')!.kind).toBe('object');
    expect(named(m, 'server')!.object).toBe('ESP8266WebServer');
    expect(named(m, 'http')!.object).toBe('HTTPClient');
    m.dispose();
  });

  it('values move while the sketch runs and stop moving when it is stopped', () => {
    const m = boot(WATCHED);
    m.advance(120);
    const early = Number(named(m, 'counter')!.value);
    m.advance(200);
    const later = Number(named(m, 'counter')!.value);
    expect(later).toBeGreaterThan(early);
    m.stop();
    const frozen = JSON.stringify(m.variables());
    m.advance(500);
    expect(JSON.stringify(m.variables())).toBe(frozen);
    m.dispose();
  });

  it('a reboot resets the values with the sketch', () => {
    const m = boot(WATCHED);
    m.advance(120);
    expect(Number(named(m, 'counter')!.value)).toBe(3);
    m.run();
    // run() finishes setup() and the first loop pass, so a fresh boot is at 1
    expect(Number(named(m, 'counter')!.value)).toBeLessThanOrEqual(1);
    m.dispose();
  });

  it('nothing is reported until the sketch has actually started', () => {
    const m = new Esp8266Machine({ board: 'wemos-d1-mini' });
    expect(m.variables()).toEqual([]);
    // loaded but not started: the initializers have not run, so no value exists
    m.load(`int x = 1; void setup(){} void loop(){ delay(50); }`);
    expect(m.variables()).toEqual([]);
    m.run();
    expect(m.variables().map((v) => v.name)).toEqual(['x']);
    m.dispose();
  });

  it('locals of setup/loop are not globals and stay out of the list', () => {
    const m = boot(`
      int global_one = 1;
      void setup(){ int local_one = 2; Serial.begin(9600); }
      void loop(){ int other = 3; delay(50); }
    `);
    expect(m.variables().map((v) => v.name)).toEqual(['global_one']);
    m.dispose();
  });
});
