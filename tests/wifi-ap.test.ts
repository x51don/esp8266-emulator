/**
 * F2.6: WiFi radio modes. STA and AP are separate states: softAP() raises the
 * AP (~300 ms), WiFi.mode() keeps a mask readable via getMode(), and the AP
 * side reports its own connect flag - a Station-only status() never lies
 * about an AP that is up.
 */
import { describe, it, expect } from 'vitest';
import { Esp8266Machine } from '../core/machine';

function boot(sketch: string): Esp8266Machine {
  const m = new Esp8266Machine({ board: 'wemos-d1-mini' });
  m.load(sketch);
  m.run();
  return m;
}
const log = (m: Esp8266Machine) => m.serial.map((l) => l.text).join('\n');
/** last printed "tag=value" token anywhere in the log */
const last = (m: Esp8266Machine, tag: string): string => {
  const re = new RegExp(`(?:^| )${tag}=(\\S*)`);
  for (const l of [...m.serial].reverse()) {
    const hit = re.exec(l.text);
    if (hit) return hit[1];
  }
  return '';
};

describe('WiFi mode mask (F2.6)', () => {
  it('getMode() reflects mode() calls and the helpers that imply them', () => {
    const m = boot(`
      void setup() {
        Serial.begin(115200);
        Serial.println(String("mode=") + WiFi.getMode());
        WiFi.mode(WIFI_STA);
        Serial.println(String("mode=") + WiFi.getMode());
        WiFi.mode(WIFI_AP);
        Serial.println(String("mode=") + WiFi.getMode());
        WiFi.mode(WIFI_AP_STA);
        Serial.println(String("mode=") + WiFi.getMode());
      }
      void loop() { delay(50); }
    `);
    m.advance(60);
    const modes = m.serial.filter((l) => l.text.startsWith('mode=')).map((l) => l.text.slice(5));
    expect(modes).toEqual(['0', '1', '2', '3']);
  });

  it('begin() implies STA, softAP() implies AP', () => {
    const m = boot(`
      void setup() { Serial.begin(115200); WiFi.begin("a", "b"); WiFi.softAP("hotspot"); }
      void loop() { Serial.println(String("mode=") + WiFi.getMode()); delay(50); }
    `);
    m.advance(60);
    expect(last(m, 'mode')).toBe('3');
  });
});

describe('Access Point state (F2.6)', () => {
  it('softAP() alone comes up in ~300 ms and reports WL_CONNECTED', () => {
    const m = boot(`
      void setup() { Serial.begin(115200); WiFi.softAP("hotspot"); }
      void loop() {
        Serial.println(String("st=") + WiFi.status() + " ip=" + WiFi.softAPIP()
          + " n=" + WiFi.softAPgetStationNum());
        delay(50);
      }
    `);
    m.advance(200);
    expect(last(m, 'st')).toBe('6'); // still coming up
    m.advance(200); // 400 ms total
    expect(last(m, 'st')).toBe('3'); // WL_CONNECTED with the AP up
    expect(log(m)).toContain('ip=192.168.4.1');
    expect(last(m, 'n')).toBe('0'); // no stations joined
  });

  it('AP_STA: STA joins on its own clock, AP on its own', () => {
    const m = boot(`
      void setup() {
        Serial.begin(115200);
        WiFi.mode(WIFI_AP_STA);
        WiFi.begin("net", "pw");
        WiFi.softAP("hotspot");
      }
      void loop() {
        Serial.println(String("st=") + WiFi.status() + " ip=" + WiFi.localIP());
        delay(50);
      }
    `);
    m.advance(400); // AP up at 300 ms, STA still joining at 1.5 s
    // With STA in the mask status() is association-scoped (core):
    expect(last(m, 'st')).toBe('6');
    expect(last(m, 'ip')).toBe('0.0.0.0'); // STA side not linked yet
    m.advance(1_500);
    expect(last(m, 'st')).toBe('3');
    expect(last(m, 'ip')).not.toBe('0.0.0.0'); // STA joined too
  });

  it('mode(WIFI_OFF) drops both sides', () => {
    const m = boot(`
      bool off = false;
      void setup() { Serial.begin(115200); WiFi.softAP("hotspot"); }
      void loop() {
        if (millis() > 500 && !off) { off = true; WiFi.mode(WIFI_OFF); }
        Serial.println(String("st=") + WiFi.status() + " apip=" + WiFi.softAPIP()
          + " mode=" + WiFi.getMode());
        delay(50);
      }
    `);
    m.advance(1200);
    expect(last(m, 'st')).toBe('6');
    expect(last(m, 'apip')).toBe('0.0.0.0'); // AP interface is gone
    expect(last(m, 'mode')).toBe('0');
  });

  it('disconnect() kills the STA but leaves the AP running', () => {
    const m = boot(`
      bool done = false;
      void setup() {
        Serial.begin(115200);
        WiFi.mode(WIFI_AP_STA);
        WiFi.begin("net", "pw");
        WiFi.softAP("hotspot");
      }
      void loop() {
        if (millis() > 2000 && !done) { done = true; WiFi.disconnect(); }
        Serial.println(String("st=") + WiFi.status() + " ip=" + WiFi.localIP()
          + " apip=" + WiFi.softAPIP() + " mode=" + WiFi.getMode());
        delay(50);
      }
    `);
    m.advance(2500);
    expect(last(m, 'ip')).toBe('0.0.0.0'); // STA gone
    expect(last(m, 'st')).toBe('6'); // association-scoped (core semantics)
    expect(last(m, 'apip')).toBe('192.168.4.1'); // the AP survived disconnect()
    expect(last(m, 'mode')).toBe('3'); // mask untouched by disconnect()
  });
});
