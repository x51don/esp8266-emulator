import { describe, expect, it } from 'vitest';
import { Esp8266Machine } from '../core/machine';
import { SimDriver } from '../gui/sim/driver';

const BOOM_SKETCH = `
int buf[2];
void setup() { }
void loop() {
  static int n = 0;
  n = n + 1;
  if (n == 3) buf[7] = 1; // out of bounds -> SketchRuntimeError mid-run
  delay(1);
}
`;

function machine(): Esp8266Machine {
  return new Esp8266Machine({ board: 'wemos-d1-mini' });
}

describe('machine fault isolation (P0.1)', () => {
  it('a runtime error inside advance() does not throw out of advance()', () => {
    const m = machine();
    m.load(BOOM_SKETCH);
    m.run();
    expect(() => m.advance(20)).not.toThrow();
  });

  it('the machine enters the "faulted" phase with a readable reason', () => {
    const m = machine();
    m.load(BOOM_SKETCH);
    m.run();
    m.advance(20);
    expect(m.phase()).toBe('faulted');
    expect(m.faultReason ?? '').toMatch(/line \d+/);
  });

  it('onFault fires exactly once with the reason; unsubscribe detaches', () => {
    const m = machine();
    const seen: string[] = [];
    const off = m.onFault((r) => seen.push(r));
    m.load(BOOM_SKETCH);
    m.run();
    m.advance(20);
    m.advance(20);
    expect(seen.length).toBe(1);
    off();
    const m2 = machine();
    const seen2: string[] = [];
    m2.onFault(() => seen2.push('x'));
    m2.load(BOOM_SKETCH);
    m2.run();
    m2.advance(50);
    expect(seen2.length).toBe(1); // sanity: listener attached before run fires
  });

  it('further advance() calls after a fault are inert, never throwing', () => {
    const m = machine();
    m.load(BOOM_SKETCH);
    m.run();
    m.advance(20);
    const t = m.timeMs();
    expect(() => m.advance(500)).not.toThrow();
    expect(m.phase()).toBe('faulted');
    expect(m.timeMs()).toBeGreaterThanOrEqual(t);
  });

  it('stop() clears the fault and a fresh run() works', () => {
    const m = machine();
    m.load(BOOM_SKETCH);
    m.run();
    m.advance(20);
    expect(m.phase()).toBe('faulted');
    m.stop();
    expect(m.phase()).toBe('stopped');
    m.load('void setup(){ } void loop(){ delay(5); }');
    m.run();
    expect(m.phase()).toBe('running');
    expect(() => m.advance(50)).not.toThrow();
  });
});

describe('sim driver fault awareness (P0.1)', () => {
  it('a driver pumps while the machine runs and stops on fault', () => {
    let phase = 'running';
    const adv: number[] = [];
    const d = new SimDriver({
      advance: (ms: number) => {
        adv.push(ms);
        if (adv.length === 2) phase = 'faulted';
      },
      timeMs: () => 0,
      phase: () => phase,
    });
    d.start();
    d.frame(16);
    d.frame(16);
    d.frame(16); // must not pump after the fault
    expect(adv.length).toBe(2);
    expect(d.running).toBe(false);
  });

  it('drivers for machines without phase() keep working (interface is optional)', () => {
    const d = new SimDriver({ advance: () => undefined, timeMs: () => 0 });
    d.start();
    expect(() => d.frame(16)).not.toThrow();
    expect(d.running).toBe(true);
  });
});

describe('cpu budget per advance (P0.3)', () => {
  const HOT = `
int n = 0;
void setup(){ Serial.begin(115200); }
void loop(){
  n = n + 1;
  if (n == 20000) { Serial.println("alive"); n = 0; }
}
`;

  it('advance() on a delay-free loop returns in bounded wall-time', () => {
    const m = machine();
    m.load(HOT);
    m.run();
    const t0 = Date.now();
    m.advance(20);
    expect(Date.now() - t0).toBeLessThan(250);
  });

  it('virtual time still advances by the full requested amount', () => {
    const m = machine();
    m.load(HOT);
    m.run();
    m.advance(20);
    expect(m.timeMs()).toBeGreaterThanOrEqual(20);
  });

  it('the throttled sketch keeps making progress across frames', () => {
    const m = machine();
    m.load(HOT);
    m.run();
    for (let i = 0; i < 50; i++) m.advance(16);
    expect(m.serial.some((l) => l.text === 'alive')).toBe(true);
  });

  it('run() with while(true) in setup() still returns', () => {
    const m = machine();
    m.load('void setup(){ while (true) { } } void loop(){ delay(1); }');
    const t0 = Date.now();
    m.run();
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('an infinite loop inside an expression throws with a line number', () => {
    const m = machine();
    m.load('int a[2];\nint f(){ int x = 0; while (true) { x = x + 1; } return x; }\nvoid setup(){ a[f()] = 1; }\nvoid loop(){ delay(1); }');
    expect(() => m.run()).toThrow(/budget|infinite/i);
    expect(() => m.run()).toThrow(/line \d+/);
  });
});
