/**
 * F6: EEPROM emulation (ESP8266 core). 4096 bytes, survives ESP.restart()
 * and machine re-boots, plus explicit save/restore for project files.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Esp8266Machine } from '../core/machine';

let machine: Esp8266Machine | null = null;
afterEach(() => {
  machine?.dispose();
  machine = null;
});

const boot = (sketch: string, ip?: string) => {
  const m = new Esp8266Machine({ board: 'wemos-d1-mini', ip });
  machine = m;
  m.load(sketch);
  m.run();
  return m;
};
const log = (m: Esp8266Machine) => m.serial.map((l) => l.text).join('\n');

describe('EEPROM (F6)', () => {
  it('write/commit/read roundtrip and reads back 0xFF when untouched', () => {
    const m = boot(`
      void setup() {
        Serial.begin(9600);
        EEPROM.begin(512);
        Serial.println(EEPROM.read(100));
        EEPROM.write(100, 42);
        Serial.println(EEPROM.commit());
        Serial.println(EEPROM.read(100));
        Serial.println(EEPROM.begin(5000));
        Serial.println(EEPROM.length());
      }
      void loop() { delay(10); }
    `);
    m.advance(20);
    expect(log(m).split('\n')).toEqual(['255', '1', '42', '0', '4096']);
  });

  it('survives ESP.restart(): boot counter increments across reboots', () => {
    const m = boot(`
      void setup() {
        Serial.begin(9600);
        EEPROM.begin(512);
        int n = EEPROM.read(0);
        n = n == 255 ? 1 : n + 1;
        EEPROM.write(0, n);
        EEPROM.commit();
        Serial.print("N=");
        Serial.println(n);
        delay(50);
        ESP.restart();
      }
      void loop() { delay(100); }
    `);
    m.advance(40); // first boot: prints N=1, hits the 50 ms restart
    expect(log(m)).toContain('N=1');
    m.advance(120); // restart clears the log, second boot prints N=2
    expect(log(m)).toContain('N=2');
    expect(log(m)).not.toContain('N=1');
    m.advance(120);
    expect(log(m)).toContain('N=3');
  });

  it('writeString/readString and writeInt/readInt use the core layout', () => {
    const m = boot(`
      void setup() {
        Serial.begin(9600);
        EEPROM.begin(512);
        EEPROM.writeString(0, "salon-L");
        EEPROM.writeInt(64, 305419896);
        EEPROM.commit();
        Serial.println(EEPROM.readString(0));
        Serial.println(EEPROM.readString(128));
        Serial.println(EEPROM.readInt(64));
      }
      void loop() { delay(10); }
    `);
    m.advance(20);
    const lines = log(m).split('\n');
    expect(lines[0]).toBe('salon-L');
    expect(lines[1]).toBe(''); // untouched area reads as an empty string
    expect(lines[2]).toBe('305419896');
  });

  it('bytes leave the machine with save/restore - project-file path', () => {
    const writer = boot(`
      void setup() {
        Serial.begin(9600);
        EEPROM.begin(512);
        EEPROM.writeString(8, "192.168.1.10");
        EEPROM.commit();
      }
      void loop() { delay(10); }
    `);
    writer.advance(10);
    const saved = writer.eepromBytes();

    const fresh = boot(`
      void setup() {
        Serial.begin(9600);
        EEPROM.begin(512);
        Serial.println("[" + EEPROM.readString(8) + "]");
      }
      void loop() { delay(10); }
    `);
    fresh.advance(10);
    expect(log(fresh)).toContain('[]'); // a new machine starts empty

    const m2 = new Esp8266Machine({ board: 'wemos-d1-mini' });
    machine = m2;
    m2.eepromRestore(saved); // the GUI restores this before pressing Run
    m2.load(`
      void setup() {
        Serial.begin(9600);
        EEPROM.begin(512);
        Serial.println("[" + EEPROM.readString(8) + "]");
      }
      void loop() { delay(10); }
    `);
    m2.run();
    m2.advance(10);
    expect(log(m2)).toContain('[192.168.1.10]');
  });

  it('erase fills 0xFF and a writeString that does not fit returns 0', () => {
    const m = boot(`
      void setup() {
        Serial.begin(9600);
        EEPROM.begin(512);
        EEPROM.write(0, 7);
        EEPROM.erase();
        Serial.println(EEPROM.read(0));
        Serial.println(EEPROM.writeString(4090, "too long string"));
      }
      void loop() { delay(10); }
    `);
    m.advance(20);
    expect(log(m).split('\n')).toEqual(['255', '0']);
  });
});
