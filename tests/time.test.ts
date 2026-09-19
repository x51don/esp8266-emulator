/**
 * F8: time & NTP. configTime() locks a virtual epoch onto the wall clock
 * half a second after the call; time()/localTime() advance with virtual
 * time; the TimeLib helpers (now/hour/minute/...) read the same epoch.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Esp8266Machine } from '../core/machine';

let machine: Esp8266Machine | null = null;
afterEach(() => {
  machine?.dispose();
  machine = null;
});
const boot = (sketch: string) => {
  const m = new Esp8266Machine({ board: 'wemos-d1-mini' });
  machine = m;
  m.load(sketch);
  m.run();
  return m;
};
const log = (m: Esp8266Machine) => m.serial.map((l) => l.text).join('\n');
const nowSec = () => Math.floor(Date.now() / 1000);

describe('time & NTP (F8)', () => {
  it('time() is 0 until configTime has locked, then it is the wall clock', () => {
    const m = boot(`
      void setup() {
        Serial.begin(9600);
        Serial.println(time(nullptr));
        configTime(0, 0, "pool.ntp.org");
        Serial.println(time(nullptr));
        delay(600);
        Serial.println(time(nullptr) > 1000000000);
      }
      void loop() { delay(10); }
    `);
    m.advance(1200);
    const lines = log(m).split('\n');
    expect(lines[0]).toBe('0'); // no time before the NTP lock
    expect(lines[1]).toBe('0'); // 10 ms later it is still syncing
    expect(lines[2]).toBe('1'); // past the half-second lock
    expect(m.faultReason).toBe(null);
  });

  it('the epoch tracks virtual time, not the real clock', () => {
    const m = boot(`
      unsigned long a;
      void setup() {
        Serial.begin(9600);
        configTime(0, 0, "pool.ntp.org");
        delay(600);
        a = time(nullptr);
        delay(2000);
        Serial.println((unsigned long)time(nullptr) - a);
      }
      void loop() { delay(10); }
    `);
    m.advance(3200);
    expect(log(m).trim().split('\n').pop()).toBe('2');
  });

  it('time(nullptr) lands within seconds of the real wall clock', () => {
    const m = boot(`
      void setup() {
        Serial.begin(9600);
        configTime(0, 0, "pool.ntp.org");
        delay(600);
        Serial.println(time(nullptr));
      }
      void loop() { delay(10); }
    `);
    m.advance(1200);
    const shown = Number(log(m).trim().split('\n').pop());
    expect(Math.abs(shown - nowSec())).toBeLessThan(10);
  });

  it('localTime applies the configured GMT offset', () => {
    const m = boot(`
      void setup() {
        Serial.begin(9600);
        configTime(2 * 3600 + 0, 3600, "pool.ntp.org");
        delay(600);
        Serial.println(localTime() - time(nullptr));
      }
      void loop() { delay(10); }
    `);
    m.advance(1200);
    expect(log(m).trim().split('\n').pop()).toBe(String(3 * 3600)); // gmt + dst as configured
  });

  it('TimeLib: setTime + now/hour/minute/weekday/calendar parts', () => {
    const m = boot(`
      void setup() {
        Serial.begin(9600);
        setTime(1704110400); // 2024-01-01 12:00:00 UTC, a Monday
        Serial.println(hour());
        Serial.println(minute());
        Serial.println(day());
        Serial.println(month());
        Serial.println(year());
        Serial.println(weekday());
        delay(61000);
        Serial.println(minute());
        Serial.println(hour(now()));
      }
      void loop() { delay(10); }
    `);
    m.advance(62_000); // the sketch sleeps a virtual minute
    const lines = log(m).split('\n');
    expect(lines.slice(0, 6)).toEqual(['12', '0', '1', '1', '2024', '2']);
    expect(lines[6]).toBe('1'); // minute after one virtual minute
    expect(lines[7]).toBe('12');
  });
});
