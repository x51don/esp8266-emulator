/**
 * F1.2 Electrical limits (hardware spec sync): each ESP8266 GPIO may source
 * or sink at most 12.8 mA (sum of all pins ~48.8 mA) and no signal pin may
 * see more than VDD+0.3 V. Sustained overload destroys the output driver
 * ("spalenie pinu"): the pad goes dead-float and stays dead over reset.
 */
import { describe, it, expect } from 'vitest';
import { Esp8266Machine } from '../core/machine';

const OUT_SKETCH =
  'void setup(){ pinMode(D5, OUTPUT); digitalWrite(D5, HIGH); } void loop(){ delay(10); }';

/** Machine driving D5 (GPIO14) through `r` ohms to GND via an LED. */
function ledToRail(r: number): Esp8266Machine {
  const m = new Esp8266Machine({ board: 'wemos-d1-mini' });
  m.netlist.addComponent('mcu', 'mcu', {
    board: 'wemos-d1-mini',
    pins: ['D5', 'D6', '3V3', '5V', 'GND'],
  });
  m.netlist.addComponent('led1', 'led', { forwardV: 2 });
  m.netlist.addComponent('r1', 'resistor', { resistance: r });
  m.netlist.addWire('mcu.D5', 'led1.a');
  m.netlist.addWire('led1.k', 'r1.p1');
  m.netlist.addWire('r1.p2', 'mcu.GND');
  m.load(OUT_SKETCH);
  return m;
}

const faultText = (m: Esp8266Machine): string => m.circuit().faults.map((f) => f.message).join(' | ');

describe('per-pin current limit (F1.2)', () => {
  it('a 100-ohm LED load pushes 13 mA through the pin - over the 12.8 mA max', () => {
    const m = ledToRail(100);
    m.run();
    m.advance(1);
    const cur = m.circuit().pinCurrent.get(14) ?? 0;
    expect(cur).toBeCloseTo(13, 0);
    expect(faultText(m)).toMatch(/12\.8/);
  });

  it('330 ohms stays within spec - no fault, no damage', () => {
    const m = ledToRail(330);
    m.run();
    m.advance(5000);
    const cur = m.circuit().pinCurrent.get(14) ?? 0;
    expect(cur).toBeLessThan(12.8);
    expect(faultText(m)).not.toMatch(/12\.8/);
    expect(m.gpio.driveState(14).kind).toBe('push');
  });

  it('sustained overload burns the output driver: dead float over reset', () => {
    const m = ledToRail(100); // ~13 mA, just over: burns in about a second
    m.run();
    expect(m.gpio.driveState(14).kind).toBe('push');
    m.advance(500); // still cooking
    expect(m.gpio.driveState(14).kind).toBe('push');
    m.advance(800); // overload crossed ~1 s of accumulated stress
    expect(m.gpio.isDamaged(14)).toBe(true);
    expect(m.gpio.driveState(14).kind).toBe('float');
    expect(m.pinLevel(14)).toBe(0); // digitalRead sees a dead pad
    m.reset(); // damage is physical: survives reset
    expect(m.gpio.isDamaged(14)).toBe(true);
    m.gpio.clearDamage(); // a "replace the board" GUI action
    expect(m.gpio.isDamaged(14)).toBe(false);
  });

  it('a momentary overload under a second does not kill the pin', () => {
    const m = ledToRail(100);
    m.run();
    m.advance(600);
    expect(m.gpio.isDamaged(14)).toBe(false);
    m.stop();
  });

  it('5 V on a signal pin exceeds the absolute maximum and kills it at once', () => {
    const m = new Esp8266Machine({ board: 'wemos-d1-mini' });
    m.netlist.addComponent('mcu', 'mcu', {
      board: 'wemos-d1-mini',
      pins: ['D5', '3V3', '5V', 'GND'],
    });
    m.netlist.addWire('mcu.5V', 'mcu.D5'); // the classic 5V-into-3V3-pin mistake
    m.load('void setup(){} void loop(){ delay(10); }');
    m.run();
    m.advance(1);
    expect(faultText(m)).toMatch(/absolute maximum/i);
    expect(m.gpio.isDamaged(14)).toBe(true);
    expect(m.gpio.driveState(14).kind).toBe('float');
  });

  it('total GPIO current over 48.8 mA faults the chip', () => {
    const m = new Esp8266Machine({ board: 'wemos-d1-mini' });
    m.netlist.addComponent('mcu', 'mcu', {
      board: 'wemos-d1-mini',
      pins: ['D5', 'D6', 'D7', 'D8', 'D1', '3V3', '5V', 'GND'],
    });
    // five pins at ~13 mA each: 65 mA total, each below the 2x immediate-burn
    // threshold but way over the 48.8 mA chip budget
    const silks = ['D5', 'D6', 'D7', 'D8', 'D1'];
    m.load(`void setup(){ ${silks.map((s) => `pinMode(${s}, OUTPUT); digitalWrite(${s}, HIGH);`).join(' ')} } void loop(){ delay(10); }`);
    silks.forEach((s, i) => {
      m.netlist.addComponent(`led${i}`, 'led', { forwardV: 2 });
      m.netlist.addComponent(`r${i}`, 'resistor', { resistance: 100 });
      m.netlist.addWire(`mcu.${s}`, `led${i}.a`);
      m.netlist.addWire(`led${i}.k`, `r${i}.p1`);
      m.netlist.addWire(`r${i}.p2`, 'mcu.GND');
    });
    m.run();
    m.advance(1);
    expect(faultText(m)).toMatch(/total.*(GPIO|48)/i);
  });
});
