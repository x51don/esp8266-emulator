/**
 * F3.1: brushed DC motor as an output. It is a bidirectional load: supply it
 * across the tabs and it spins one way, swap the leads and it reverses. The
 * winding resistance (default 50R) makes direct-on-a-pin wiring an honest
 * overcurrent lesson - like the relay coil, a GPIO cannot feed it.
 */
import { describe, it, expect } from 'vitest';
import { Netlist } from '../peripherals/netlist';
import { GpioBus, PIN_OUTPUT } from '../peripherals/gpio';

// D2 = GPIO4 on the Wemos mapping (see netlist.test.ts)
function motorCircuit(mk: (nl: Netlist) => void) {
  const bus = new GpioBus();
  const nl = new Netlist(bus);
  nl.addComponent('mcu', 'mcu', { board: 'wemos-d1-mini', pins: ['D2', 'GND', '5V'] });
  nl.addComponent('m1', 'motor', { pins: ['+', '-'] });
  mk(nl);
  return { bus, nl };
}

describe('DC motor load (F3.1)', () => {
  it('HIGH on + with - on GND spins it forward at stall current', () => {
    const { bus, nl } = motorCircuit((nl) => {
      nl.addWire('mcu.D2', 'm1.+');
      nl.addWire('m1.-', 'mcu.GND');
    });
    bus.setMode(4, PIN_OUTPUT);
    bus.write(4, 1);
    const m = nl.resolve().motors.get('m1')!;
    expect(m.spinning).toBe(true);
    expect(m.dir).toBe(1);
    // (3.3 - 0.3 brush drop) / 50R winding
    expect(m.currentMa).toBeCloseTo(60, 0);
    expect(m.rpm).toBeGreaterThan(0);
  });

  it('swapping the leads reverses the shaft', () => {
    const { bus, nl } = motorCircuit((nl) => {
      nl.addWire('mcu.D2', 'm1.-'); // pin on the minus tab
      nl.addWire('m1.+', 'mcu.GND');
    });
    bus.setMode(4, PIN_OUTPUT);
    bus.write(4, 1);
    const m = nl.resolve().motors.get('m1')!;
    expect(m.spinning).toBe(true);
    expect(m.dir).toBe(-1);
    expect(m.currentMa).toBeCloseTo(60, 0);
  });

  it('a tab to nothing: no path, no spin, no current', () => {
    const { bus, nl } = motorCircuit((nl) => {
      nl.addWire('mcu.D2', 'm1.+'); // - left in the air
    });
    bus.setMode(4, PIN_OUTPUT);
    bus.write(4, 1);
    const m = nl.resolve().motors.get('m1')!;
    expect(m.spinning).toBe(false);
    expect(m.dir).toBe(0);
    expect(m.currentMa).toBe(0);
    expect(m.rpm).toBe(0);
  });

  it('PWM halves the average current and the speed', () => {
    const { bus, nl } = motorCircuit((nl) => {
      nl.addWire('mcu.D2', 'm1.+');
      nl.addWire('m1.-', 'mcu.GND');
    });
    bus.analogWrite(4, 512); // ~50 % duty
    const m = nl.resolve().motors.get('m1')!;
    expect(m.spinning).toBe(true);
    expect(m.currentMa).toBeCloseTo(30, 0);
    expect(m.rpm).toBeLessThan(4000);
  });

  it('driving it from the 5V rail through a MOSFET leaves the pin clean', () => {
    const { bus, nl } = motorCircuit((nl) => {
      nl.addComponent('q1', 'mosfet', { pins: ['d', 'g', 's'] });
      nl.addWire('mcu.5V', 'm1.+');
      nl.addWire('m1.-', 'q1.d');
      nl.addWire('q1.s', 'mcu.GND');
      nl.addWire('mcu.D2', 'q1.g');
    });
    bus.setMode(4, PIN_OUTPUT);
    bus.write(4, 1);
    const r = nl.resolve();
    const m = r.motors.get('m1')!;
    expect(m.spinning).toBe(true);
    // (5 - 0.3) / (50 winding + 10 channel)
    expect(m.currentMa).toBeCloseTo(78, 0);
    // the gate draws nothing: no GPIO current budget was touched
    expect(r.pinCurrent.get(4) ?? 0).toBe(0);
    expect(r.faults.filter((f) => f.net === 'gpio4')).toHaveLength(0);
  });

  it('a pin feeding the motor straight breaks the 12.8 mA budget (F1.2)', () => {
    const { bus, nl } = motorCircuit((nl) => {
      nl.addWire('mcu.D2', 'm1.+');
      nl.addWire('m1.-', 'mcu.GND');
    });
    bus.setMode(4, PIN_OUTPUT);
    bus.write(4, 1);
    const r = nl.resolve();
    expect(r.pinCurrent.get(4) ?? 0).toBeCloseTo(60, 0);
    expect(r.faults.some((f) => f.kind === 'overcurrent' && f.net === 'gpio4')).toBe(true);
  });

  it('a series resistor limits what the winding pulls', () => {
    const { bus, nl } = motorCircuit((nl) => {
      nl.addComponent('r1', 'resistor', { pins: ['p1', 'p2'], resistance: 100 });
      nl.addWire('mcu.D2', 'r1.p1');
      nl.addWire('r1.p2', 'm1.+');
      nl.addWire('m1.-', 'mcu.GND');
    });
    bus.setMode(4, PIN_OUTPUT);
    bus.write(4, 1);
    const m = nl.resolve().motors.get('m1')!;
    expect(m.spinning).toBe(true);
    // (3.3 - 0.3) / (100 series + 50 winding)
    expect(m.currentMa).toBeCloseTo(20, 0);
  });
});
