/**
 * F1.1 Boot mode straps (hardware spec sync): at reset release the ESP8266
 * samples GPIO0/GPIO2 (internal ~45k pull-UPS active out of reset) and
 * GPIO15 (internal pull-DOWN). GPIO15=1 -> no boot; GPIO0=0 -> UART download
 * mode (the sketch must NOT run); GPIO2=0 -> ROM panic. The straps are weak:
 * a real driver on the line always wins.
 */
import { describe, it, expect } from 'vitest';
import { Esp8266Machine } from '../core/machine';

const HELLO =
  'void setup(){ Serial.begin(115200); Serial.println("sketch alive"); } void loop(){ delay(10); }';

const SILK: Record<number, string> = { 0: 'D3', 2: 'D4', 15: 'D8' };

/** Board with a button from the strap pin to GND (the classic boot-hold). */
function strapped(gpio: number, to = 'GND'): Esp8266Machine {
  const m = new Esp8266Machine({ board: 'wemos-d1-mini' });
  m.netlist.addComponent('mcu', 'mcu', {
    board: 'wemos-d1-mini',
    pins: ['D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', '3V3', '5V', 'GND', 'A0'],
  });
  m.netlist.addComponent('btn', 'button', { bounce: 0 });
  m.netlist.addWire('btn.p1', `mcu.${SILK[gpio]}`);
  m.netlist.addWire('btn.p2', `mcu.${to}`);
  return m;
}

const text = (m: Esp8266Machine): string => m.serial.map((l) => l.text).join('\n');

describe('boot mode straps (F1.1)', () => {
  it('reset state carries the chip strap resistors', () => {
    const m = new Esp8266Machine({ board: 'wemos-d1-mini' });
    expect(m.pinLevel(0)).toBe(1); // internal pull-up
    expect(m.pinLevel(2)).toBe(1); // internal pull-up
    expect(m.pinLevel(15)).toBe(0); // internal pull-down
    expect(m.pinLevel(4)).toBe(0); // GPIO4: floating, no strap
  });

  it('digitalRead sees the straps before any pinMode call', () => {
    const m = new Esp8266Machine({ board: 'wemos-d1-mini' });
    m.load('void setup(){ Serial.begin(115200); Serial.println(digitalRead(D3)); Serial.println(digitalRead(D4)); Serial.println(digitalRead(D8)); } void loop(){ delay(10); }');
    m.run();
    expect(text(m).split('\n')).toEqual(['1', '1', '0']);
  });

  it('GPIO0 held LOW at boot enters UART download mode, sketch stays dead', () => {
    const m = strapped(0);
    m.press('btn', true);
    m.load(HELLO);
    m.run();
    expect(m.bootMode()).toBe('download');
    expect(m.phase()).not.toBe('running');
    expect(text(m)).toMatch(/download/i);
    m.advance(500);
    expect(text(m)).not.toMatch(/sketch alive/);
  });

  it('GPIO15 held HIGH at boot blocks boot entirely', () => {
    const m = strapped(15, '3V3'); // strap is a pull-DOWN: only a high driver holds it
    m.press('btn', true); // button pins D8 to 3V3 (strong source overrides the strap)
    m.load(HELLO);
    m.run();
    expect(m.bootMode()).toBe('no-boot');
    expect(text(m)).toMatch(/GPIO15/);
    m.advance(500);
    expect(text(m)).not.toMatch(/sketch alive/);
  });

  it('GPIO2 held LOW at boot panics like the ROM does', () => {
    const m = strapped(2);
    m.press('btn', true);
    m.load(HELLO);
    m.run();
    expect(m.bootMode()).toBe('crash-gpio2');
    expect(text(m)).toMatch(/GPIO2/);
    expect(text(m)).not.toMatch(/sketch alive/);
  });

  it('normal straps (0=H, 2=H, 15=L) boot the sketch', () => {
    const m = strapped(0); // button wired but released
    m.load(HELLO);
    m.run();
    expect(m.bootMode()).toBe('flash');
    expect(text(m)).toMatch(/sketch alive/);
  });

  it('straps are weak: an external driver at boot decides the mode', () => {
    // GPIO0 with the strap alone still boots; wiring it to GND through the
    // strap path must not - only a real hold-down changes the mode.
    const m = strapped(0);
    m.load(HELLO);
    m.run();
    expect(m.bootMode()).toBe('flash');
  });

  it('a boot blocked once stays blocked until the next run()', () => {
    const m = strapped(0);
    m.press('btn', true);
    m.load(HELLO);
    m.run();
    m.press('btn', false); // release mid-air: the ROM already latched download mode
    m.advance(500);
    expect(text(m)).not.toMatch(/sketch alive/);
    m.load(HELLO);
    m.run(); // reset release with GPIO0 high: normal boot
    expect(m.bootMode()).toBe('flash');
    expect(text(m)).toMatch(/sketch alive/);
  });
});
