/**
 * F2.5: hardware timers. Timer0 (CCOUNT0) belongs to the WiFi stack while the
 * radio runs - arming it from a sketch is a documented conflict. Timer1 is a
 * 23-bit counter on a /256 prescaler: one tick is 3.2 us, so no period may
 * exceed 0x7FFFFF ticks (~26.8 s).
 */
import { describe, it, expect } from 'vitest';
import { Esp8266Machine } from '../core/machine';

const ISR_COUNT = `
volatile int hits = 0;
void timer0ISR() { hits++; }
void timer1ISR() { hits++; }
void report() { Serial.println(String("h=") + hits); }
`;

function boot(sketch: string): Esp8266Machine {
  const m = new Esp8266Machine({ board: 'wemos-d1-mini' });
  m.load(sketch);
  m.run();
  return m;
}

const log = (m: Esp8266Machine) => m.serial.map((l) => l.text).join('\n');
/** ISR hits from the most recent report line. */
const hits = (m: Esp8266Machine) => {
  const line = [...m.serial].reverse().find((l) => l.text.startsWith('h='));
  return line ? Number(line.text.slice(2)) : 0;
};

describe('timer0 is reserved by the WiFi stack (F2.5)', () => {
  it('arming timer0 while WiFi is joining fails with a warning', () => {
    const m = boot(`${ISR_COUNT}
      void setup() {
        Serial.begin(115200);
        WiFi.begin("net", "pw");
        Serial.print("en=");
        Serial.println(timerAlarmWrite(timer0, 10000, true) && timerAlarmEnable(timer0));
      }
      void loop() { report(); delay(50); }
    `);
    m.advance(300);
    expect(log(m)).toContain('timer0 reserved by WiFi stack');
    expect(log(m)).toContain('en='); // enable refused:
    expect(log(m)).toMatch(/en=.*\n0\n/s); // ...printed 0
    expect(log(m)).toContain('h=0'); // and nothing ever fired
  });

  it('arming a WebServer also occupies the radio, so timer0 stays reserved', () => {
    const m = boot(`${ISR_COUNT}
      ESP8266WebServer server(80);
      void handle() {}
      void setup() {
        Serial.begin(115200);
        server.on("/", handle);
        server.begin();
        Serial.println(timerAlarmWrite(timer0, 10000, true) && timerAlarmEnable(timer0));
      }
      void loop() { server.handleClient(); report(); delay(50); }
    `);
    m.advance(300);
    expect(log(m)).toContain('timer0 reserved by WiFi stack');
    expect(log(m)).toContain('\n0\n');
    expect(log(m)).toContain('h=0');
  });

  it('timer0 runs free when the radio never started', () => {
    const m = boot(`${ISR_COUNT}
      void setup() {
        Serial.begin(115200);
        Serial.println(timerAlarmWrite(timer0, 10000, true) && timerAlarmEnable(timer0));
      }
      void loop() { report(); delay(50); }
    `);
    m.advance(500);
    expect(log(m)).toMatch(/^1\n/);
    expect(hits(m)).toBeGreaterThanOrEqual(40); // 10 ms period over 500 ms
  });

  it('WiFi.disconnect() hands timer0 back to the sketch', () => {
    const m = boot(`${ISR_COUNT}
      bool rearmed = false;
      void setup() {
        Serial.begin(115200);
        WiFi.begin("net", "pw");
        WiFi.disconnect();
        Serial.println(timerAlarmWrite(timer0, 10000, true) && timerAlarmEnable(timer0));
      }
      void loop() { report(); delay(50); }
    `);
    m.advance(500);
    expect(log(m)).toMatch(/^1\n/);
    expect(hits(m)).toBeGreaterThanOrEqual(40);
  });
});

describe('timer1 23-bit range (F2.5)', () => {
  it('a 60 s period clamps to the 23-bit maximum ~26.8 s', () => {
    const m = boot(`${ISR_COUNT}
      void setup() {
        Serial.begin(115200);
        timerAlarmWrite(timer1, 60000000, true);
        timerAlarmEnable(timer1);
      }
      void loop() { report(); delay(1000); }
    `);
    m.advance(20_000);
    expect(hits(m)).toBe(0); // the hardware cannot count that slow...
    m.advance(9_000); // ...so the clamped 26.8 s window closes at ~26.8 s
    expect(hits(m)).toBe(1);
  });

  it('periods inside the 23-bit range pass through untouched', () => {
    const m = boot(`${ISR_COUNT}
      void setup() {
        Serial.begin(115200);
        timerAlarmWrite(timer1, 5000000, true); // 5 s, well inside
        timerAlarmEnable(timer1);
      }
      void loop() { report(); delay(1000); }
    `);
    m.advance(6_000);
    expect(hits(m)).toBe(1);
    m.advance(5_000);
    expect(hits(m)).toBe(2);
  });
});
