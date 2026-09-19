/**
 * F9: ESP.deepSleep(us) = delayed reboot. The chip wakes after the given
 * virtual time, runs setup() from scratch, serial cleared, EEPROM kept.
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

const SKETCH = `
void setup() {
  Serial.begin(9600);
  EEPROM.begin(512);
  int n = EEPROM.read(0);
  n = n == 255 ? 1 : n + 1;
  EEPROM.write(0, n);
  EEPROM.commit();
  Serial.print("BOOT=");
  Serial.println(n);
  delay(20);
  ESP.deepSleep(10000000); // 10 s
}
void loop() { delay(100); }
`;

describe('ESP.deepSleep (F9)', () => {
  it('wakes after the virtual sleep and reboots from setup()', () => {
    const m = boot(SKETCH);
    expect(log(m)).toContain('BOOT=1');
    m.advance(5000); // still asleep at t=5 s
    expect(log(m)).toContain('BOOT=1');
    expect(log(m)).not.toContain('BOOT=2');
    m.advance(6000); // t=11 s: the wake landed at 10.02 s
    expect(log(m)).toContain('BOOT=2');
    expect(log(m)).not.toContain('BOOT=1'); // a wake clears the log like a reset
    expect(m.faultReason).toBe(null);
  });
});
