/**
 * F4 (repair 4/6): millis() and micros() are 32-bit counters.
 *
 * Real hardware rolls millis() over after 49.7 days and micros() after
 * 71.6 minutes, and every Arduino tutorial that matters is written against
 * `millis() - previous >= interval` precisely because of that. The emulator
 * used to hand the sketch an ever-growing double, so the classic rollover
 * bug was invisible: a sketch that stops working after 49 days looked
 * healthy forever. Both calls are now uint32, and setUptimeUs() starts the
 * virtual clock near the boundary so a test does not need 49.7 days.
 */
import { describe, it, expect } from 'vitest';
import { Esp8266Machine } from '../core/machine';

const WRAP = 4294967296; // 2**32

const machine = (uptimeUs: number): Esp8266Machine => {
  const m = new Esp8266Machine({ board: 'wemos-d1-mini' });
  m.setUptimeUs(uptimeUs);
  return m;
};
const nums = (m: Esp8266Machine): number[] =>
  m.serial.map((l) => l.text).filter((t) => t !== '').map(Number);

describe('the 32-bit time counters (F4)', () => {
  it('millis() rolls over at 2**32', () => {
    const m = machine((WRAP - 10) * 1000);
    m.load(`
      void setup() {
        Serial.begin(9600);
        Serial.println(millis());
        delay(20);
        Serial.println(millis());
      }
      void loop() { delay(10); }
    `);
    m.run();
    m.advance(100);
    // 10 ms before the boundary: the counter passes through 0, it does not
    // climb on to 4294967306
    expect(nums(m)).toEqual([WRAP - 10, 10]);
  });

  it('micros() rolls over at 2**32 too', () => {
    const m = machine(WRAP - 10);
    m.load(`
      void setup() {
        Serial.begin(9600);
        Serial.println(micros());
        delay(20);
        Serial.println(micros());
      }
      void loop() { delay(10); }
    `);
    m.run();
    m.advance(100);
    const v = nums(m);
    // The first micros() already includes the few µs of boot latency, so the
    // pair is checked against each other: 20 ms apart, across the boundary.
    expect(v[0]).toBeGreaterThanOrEqual(WRAP - 10);
    expect(v[0]).toBeLessThan(WRAP);
    expect(v[1]).toBe((v[0] + 20_000) % WRAP);
    expect(v[1]).toBeLessThan(20_000);
  });

  it('millis() - t0 >= X keeps counting across the rollover', () => {
    const m = machine((WRAP - 1500) * 1000);
    m.load(`
      unsigned long t0 = 0;
      void setup() { Serial.begin(9600); t0 = millis(); }
      void loop() {
        if (millis() - t0 >= 1000) {
          t0 = millis();
          Serial.println(millis());
        }
        delay(50);
      }
    `);
    m.run();
    m.advance(5000);
    const v = nums(m);
    expect(v.length).toBeGreaterThanOrEqual(4);
    expect(v.some((x) => x > WRAP - 5000)).toBe(true); // printed before the wrap
    expect(v.some((x) => x < 5000)).toBe(true); // and after it
    // every tick stays exactly 1000 ms apart, modulo the wrap
    const gaps = v.slice(1).map((x, i) => (x - v[i] + WRAP) % WRAP);
    expect(gaps.every((g) => g === 1000)).toBe(true);
  });

  it('millis() >= t0 + X stops firing once the counter has wrapped', () => {
    const m = machine((WRAP - 1500) * 1000);
    m.load(`
      unsigned long t0 = 0;
      void setup() { Serial.begin(9600); t0 = millis(); }
      void loop() {
        if (millis() >= t0 + 1000) {
          t0 = millis();
          Serial.println(millis());
        }
        delay(50);
      }
    `);
    m.run();
    m.advance(5000);
    // The buggy pattern breaks at the boundary: t0 + 1000 itself wraps to a
    // small number, so `millis() >= t0 + 1000` is true again on the very next
    // tick and the sketch fires in a burst instead of once a second. The
    // emulator has to show that difference, not hide it.
    const v = nums(m);
    expect(v[0]).toBe(WRAP - 500); // the first tick is still on time
    const gaps = v.slice(1).map((x, i) => (x - v[i] + WRAP) % WRAP);
    expect(Math.min(...gaps)).toBe(50); // back-to-back ticks: the cadence is gone
    expect(v.length).toBeGreaterThan(8);
  });

  it('delay() and the scheduler are unbothered by the rollover', () => {
    const m = machine((WRAP - 1200) * 1000);
    m.load(`
      int n = 0;
      void setup() { Serial.begin(9600); }
      void loop() {
        n = n + 1;
        Serial.println(n);
        digitalWrite(2, n % 2);
        delay(100);
      }
    `);
    m.run();
    m.advance(3000);
    const v = nums(m);
    expect(v.length).toBeGreaterThanOrEqual(25);
    expect(v.every((x) => Number.isFinite(x))).toBe(true); // no 'wdt reset' text
    expect(v[v.length - 1]).toBe(v.length); // no lost or doubled ticks
  });

  it('the uptime offset is where the clock boots, also after a reboot', () => {
    const m = machine((WRAP - 1000) * 1000);
    m.load(`
      void setup() {
        Serial.begin(9600);
        Serial.println(millis());
      }
      void loop() { delay(10); }
    `);
    m.run();
    m.advance(100);
    const first = nums(m);
    expect(first[0]).toBe(WRAP - 1000);
    m.run(); // ESP.restart(): the world clock keeps its offset
    m.advance(100);
    expect(nums(m)[0]).toBe(WRAP - 1000);
    m.setUptimeUs(0); // back to a plain cold boot
    m.run();
    m.advance(100);
    expect(nums(m)[0]).toBe(0);
  });
});

describe('declared integer widths (F4)', () => {
  // The rollover is only testable if the types that hold a millis() value can
  // actually hold it. The interpreter used to truncate every integer to a
  // signed int32 on assignment, so `unsigned long t = millis();` turned
  // 4294965796 into -1500 and the whole upper half of the range was lost.
  const show = (decls: string, prints: string): number[] => {
    const m = new Esp8266Machine({ board: 'wemos-d1-mini' });
    m.load(`
      ${decls}
      void setup() {
        Serial.begin(9600);
        ${prints}
      }
      void loop() { delay(10); }
    `);
    m.run();
    m.advance(10);
    return nums(m);
  };

  it('wraps values into the declared width', () => {
    expect(show('byte b = 0;', 'b = 300; Serial.println(b); b = b + 1; Serial.println(b);'))
      .toEqual([44, 45]);
    expect(show('word w = 0;', 'w = 70000; Serial.println(w);')).toEqual([4464]);
    expect(show('char c = 0;', 'c = 200; Serial.println(c);')).toEqual([-56]);
    expect(show('unsigned long u = 0;', 'u = -1; Serial.println(u);'))
      .toEqual([4294967295]);
    expect(show('int i = 0;', 'i = 4294967295; Serial.println(i);')).toEqual([-1]);
  });

  it('counts a byte up to 255 and over', () => {
    const m = new Esp8266Machine({ board: 'wemos-d1-mini' });
    m.load(`
      byte b = 254;
      void setup() {
        Serial.begin(9600);
        b++; Serial.println(b);
        b++; Serial.println(b);
      }
      void loop() { delay(10); }
    `);
    m.run();
    m.advance(10);
    expect(nums(m)).toEqual([255, 0]);
  });

  it('does the arithmetic of unsigned operands in unsigned arithmetic', () => {
    // 100 - 200 in uint32 is 4294967196, and a millis() delta across the
    // rollover is the same trick at a larger scale
    expect(show('unsigned long d = 0;', 'd = 100 - 200; Serial.println(d);'))
      .toEqual([4294967196]);
    expect(show('unsigned long m = 4294967295;', 'Serial.println(m >> 31);'))
      .toEqual([1]);
    expect(show('long s = -1;', 'Serial.println(s >> 31);')).toEqual([-1]);
    // the difference lands back in a signed int as a negative delta
    expect(show('unsigned long a = 5, b = 9; int d = 0;', 'd = a - b; Serial.println(d);'))
      .toEqual([-4]);
    // millis() is an unsigned long, so a "negative" delta is a huge positive
    // one on real hardware and here too
    expect(show('unsigned long d = 0;', 'd = millis() - 5000; Serial.println(d);'))
      .toEqual([4294962296]);
  });

  it('passes scalars to functions by value', () => {
    const m = new Esp8266Machine({ board: 'wemos-d1-mini' });
    m.load(`
      void poke(int x) { x = 99; }
      void setup() {
        Serial.begin(9600);
        int v = 1;
        poke(v);
        Serial.println(v);
      }
      void loop() { delay(10); }
    `);
    m.run();
    m.advance(10);
    expect(nums(m)).toEqual([1]);
  });
});
