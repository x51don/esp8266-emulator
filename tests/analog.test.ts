/**
 * Analog world: potentiometer as an ideal tap, LDR as a light-controlled
 * resistor, and analogRead() scaling the voltage the ADC pin would see.
 */
import { describe, it, expect } from 'vitest';
import { Netlist } from '../peripherals/netlist';
import { GpioBus } from '../peripherals/gpio';
import { Esp8266Machine } from '../core/machine';

const near = (v: number, e: number, tol = 0.05) => Math.abs(v - e) <= tol;

function netWithMcu(): Netlist {
  const nl = new Netlist(new GpioBus());
  nl.addComponent('mcu', 'mcu', { board: 'wemos-d1-mini' });
  return nl;
}

describe('analogVolts (netlist)', () => {
  it('potentiometer wiper divides between its ends', () => {
    const nl = netWithMcu();
    nl.addComponent('pot1', 'pot', { ratio: 0.5 });
    nl.addWire('mcu.3V3', 'pot1.p1');
    nl.addWire('pot1.p2', 'mcu.GND');
    nl.addWire('pot1.w', 'mcu.A0');
    expect(nl.analogVolts('mcu.A0')).not.toBeNull();
    expect(near(nl.analogVolts('mcu.A0')!, 1.65, 0.1)).toBe(true);
  });

  it('potentiometer ratio 0.25 gives a quarter of the rail', () => {
    const nl = netWithMcu();
    nl.addComponent('pot1', 'pot', { ratio: 0.25 });
    nl.addWire('mcu.3V3', 'pot1.p1');
    nl.addWire('pot1.p2', 'mcu.GND');
    nl.addWire('pot1.w', 'mcu.A0');
    expect(near(nl.analogVolts('pot1.w')!, 0.825, 0.1)).toBe(true);
  });

  it('LDR and a fixed resistor form a divider the ADC can read', () => {
    const nl = netWithMcu();
    // lux chosen so the LDR is ~10k: midpoint with the 10k pull-up
    nl.addComponent('ldr1', 'ldr', { lux: 720 });
    nl.addComponent('r1', 'resistor', { resistance: 10_000 });
    nl.addWire('mcu.3V3', 'r1.p1');
    nl.addWire('r1.p2', 'mcu.A0');
    nl.addWire('ldr1.p1', 'mcu.A0');
    nl.addWire('ldr1.p2', 'mcu.GND');
    const v = nl.analogVolts('mcu.A0');
    expect(v).not.toBeNull();
    expect(near(v!, 1.65, 0.3)).toBe(true);
  });

  it('unconnected terminal has no analog voltage', () => {
    const nl = netWithMcu();
    expect(nl.analogVolts('mcu.A0')).toBeNull();
  });
});

describe('analogRead (machine)', () => {
  function machineWithPot(ratio: number): Esp8266Machine {
    const m = new Esp8266Machine({ board: 'wemos-d1-mini' });
    m.netlist.addComponent('mcu', 'mcu', { board: 'wemos-d1-mini' });
    m.netlist.addComponent('pot1', 'pot', { ratio });
    m.netlist.addWire('mcu.3V3', 'pot1.p1');
    m.netlist.addWire('pot1.p2', 'mcu.GND');
    m.netlist.addWire('pot1.w', 'mcu.A0');
    return m;
  }

  it('reads ~511 at mid-scale through A0', () => {
    const m = machineWithPot(0.5);
    expect(Math.abs(m.analogRead(17) - 511)).toBeLessThanOrEqual(30);
  });

  it('A0 constant works in a sketch and tracks the wiper', () => {
    const m = machineWithPot(0);
    m.load(`
      void setup() { Serial.begin(115200); }
      void loop() { Serial.println(analogRead(A0)); delay(50); }
    `);
    m.run();
    m.advance(60);
    const v0 = Number(m.serial[m.serial.length - 1].text);
    expect(v0).toBeLessThanOrEqual(30);
    // turn the wiper full
    m.netlist.addComponent('pot1', 'pot', { ratio: 1 });
    m.advance(60);
    const v1 = Number(m.serial[m.serial.length - 1].text);
    expect(v1).toBeGreaterThanOrEqual(993);
  });
});

// P3.1: a UI slider acting as a bench supply on the ADC pin. The force is
// WEAK (source resistance ~10k), so a real driver on the same net wins the
// divider instead of reporting a rail-to-rail short.
describe('analog force editor (P3.1)', () => {
  it('a forced voltage appears on a floating A0', () => {
    const nl = netWithMcu();
    nl.pinForce('adc1', 2.5, 'mcu.A0');
    expect(near(nl.analogVolts('mcu.A0')!, 2.5)).toBe(true);
  });

  it('the force survives clear() (document resync keeps the slider)', () => {
    const nl = netWithMcu();
    nl.pinForce('adc1', 1.0, 'mcu.A0');
    nl.addComponent('r1', 'resistor', { resistance: 1000 });
    nl.clear();
    expect(near(nl.analogVolts('mcu.A0')!, 1.0)).toBe(true);
  });

  it('force is weak: a 10k load halves it, no fault', () => {
    const nl = netWithMcu();
    nl.pinForce('adc1', 3.0, 'mcu.A0');
    nl.addComponent('r1', 'resistor', { resistance: 10_000 });
    nl.addWire('r1.p1', 'mcu.A0');
    nl.addWire('r1.p2', 'mcu.GND');
    expect(near(nl.analogVolts('mcu.A0')!, 1.5)).toBe(true);
    expect(nl.resolve().faults).toEqual([]);
  });

  it('removing the force floats the pin again', () => {
    const nl = netWithMcu();
    nl.pinForce('adc1', 2.5, 'mcu.A0');
    nl.pinForce('adc1', null, 'mcu.A0');
    expect(nl.analogVolts('mcu.A0')).toBeNull();
  });

  it('machine.setAnalogForce scales into analogRead and survives resync', () => {
    const m = new Esp8266Machine({ board: 'wemos-d1-mini' });
    m.netlist.addComponent('mcu', 'mcu', { board: 'wemos-d1-mini' });
    m.setAnalogForce(2.5);
    expect(Math.abs(m.analogRead(17) - 775)).toBeLessThanOrEqual(5);
    m.netlist.clear(); // what Schematic.syncNetlist does before rebuilding
    expect(Math.abs(m.analogRead(17) - 775)).toBeLessThanOrEqual(5);
    m.setAnalogForce(null);
    expect(m.analogRead(17)).toBe(0);
  });
});
