/**
 * F2.3 watchdogs: the soft WDT (~6.3 s, fed by the scheduler) resets a
 * sketch whose loop() blocks; ESP.wdtFeed() keeps it alive, wdtDisable()
 * leaves only the hardware WDT, and getResetReason() reports the cause.
 * Values follow the esp8266 Arduino core (`.ref/Esp.cpp`): both watchdogs
 * fire at ~6.3 s and the boot ROM prints "wdt reset".
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

const REPORT = `
  void setup() {
    Serial.begin(9600);
    Serial.print("boot:");
    Serial.println(ESP.getResetReason());
  }
`;

describe('watchdog (F2.3)', () => {
  it('a loop() that blocks trips the soft WDT ~6.3 s after the last feed', () => {
    const m = boot(REPORT + ' int x = 0; void loop(){ while (true) { x++; } }');
    m.advance(6000); // still inside the timeout window
    expect(log(m)).not.toContain('wdt reset');
    m.advance(500); // 6.5 s total: past the 6.3 s soft WDT
    expect(log(m)).toContain('wdt reset'); // boot ROM banner on the new boot
    expect(log(m)).toContain('boot:Software Watchdog');
  });

  it('ESP.wdtFeed() inside the blocking loop keeps the chip alive', () => {
    const m = boot(`
      void setup() { Serial.begin(9600); }
      int x = 0;
      void loop(){ while (true) { ESP.wdtFeed(); x++; } }
    `);
    m.advance(20000);
    expect(log(m)).not.toContain('wdt reset');
  });

  it('a delay()-driven loop feeds the watchdog by itself', () => {
    const m = boot(`
      void setup() { Serial.begin(9600); }
      void loop(){ delay(100); }
    `);
    m.advance(60000); // a minute of normal sketching
    expect(log(m)).not.toContain('wdt reset');
  });

  it('wdtDisable() leaves the hardware WDT: reason switches', () => {
    const m = boot(`
      void setup() {
        Serial.begin(9600);
        Serial.print("boot:");
        Serial.println(ESP.getResetReason());
        ESP.wdtDisable();
      }
      int x = 0;
      void loop(){ while (true) { x++; } }
    `);
    m.advance(6500);
    expect(log(m)).toContain('wdt reset');
    expect(log(m)).toContain('boot:Hardware Watchdog');
  });

  it('wdtEnable() re-arms the soft watchdog after a disable', () => {
    const m = boot(`
      void setup() {
        Serial.begin(9600);
        Serial.print("boot:");
        Serial.println(ESP.getResetReason());
        ESP.wdtDisable();
        ESP.wdtEnable(6300);
      }
      int x = 0;
      void loop(){ while (true) { x++; } }
    `);
    m.advance(6500);
    expect(log(m)).toContain('boot:Software Watchdog');
  });

  it('ESP.restart() is no watchdog: reason is a software restart', () => {
    const m = boot(`
      void setup() {
        Serial.begin(9600);
        Serial.print("boot:");
        Serial.println(ESP.getResetReason());
        delay(10);
        ESP.restart();
      }
      void loop() { delay(10); }
    `);
    m.advance(30); // second boot after the restart
    expect(log(m)).toContain('boot:Software System Restart');
    expect(log(m)).not.toContain('wdt reset');
  });

  it('the WDT trips again on every reboot while the bug persists', () => {
    const m = boot(REPORT + ' int x = 0; void loop(){ while (true) { x++; } }');
    m.advance(6500); // first trip
    expect(log(m)).toContain('boot:Software Watchdog');
    m.advance(6500); // second trip: the rebooted sketch blocks again
    // the log is per-boot: the current boot is again a watchdog boot
    expect(log(m)).toContain('wdt reset');
    expect(log(m)).toContain('boot:Software Watchdog');
  });
});
