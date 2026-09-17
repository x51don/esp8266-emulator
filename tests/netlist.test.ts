import { describe, it, expect } from 'vitest';
import { Netlist } from '../peripherals/netlist';
import { GpioBus, PIN_OUTPUT } from '../peripherals/gpio';

// The netlist resolves the wire graph + components into electrical truth:
// which net a pin sits on, whether an LED lights and how bright, and whether
// a wiring mistake burns something. Resistors conduct (with Ohm's law),
// wires and closed buttons connect, LEDs are nonlinear endpoints.

function setup(opts: { gpio16?: boolean } = {}) {
  const bus = new GpioBus();
  const nl = new Netlist(bus);
  void opts;
  return { bus, nl };
}

// helpers: pins are addressed as `${componentId}.${pinName}`; MCU pins are
// `mcu.D2` etc. (the machine registers the MCU under id "mcu").
describe('connectivity', () => {
  it('wires merge pins into one net', () => {
    const { nl } = setup();
    nl.addComponent('mcu', 'mcu', { board: 'wemos-d1-mini', pins: ['D2', 'D5', 'GND', '3V3'] });
    nl.addComponent('led1', 'led', { pins: ['a', 'k'] });
    nl.addComponent('r1', 'resistor', { pins: ['p1', 'p2'], resistance: 220 });
    nl.addWire('mcu.D2', 'r1.p1');
    nl.addWire('r1.p2', 'led1.a');
    expect(nl.netOf('mcu.D2')).toBe(nl.netOf('r1.p1'));
    // the resistor BREAKS the net but keeps the electrical path
    expect(nl.netOf('r1.p2')).not.toBe(nl.netOf('r1.p1'));
  });

  it('removing a wire splits nets again', () => {
    const { nl } = setup();
    nl.addComponent('mcu', 'mcu', { board: 'wemos-d1-mini', pins: ['D2', 'GND'] });
    nl.addComponent('b1', 'buzzer', { pins: ['+', '-'] });
    const w = nl.addWire('mcu.D2', 'b1.+');
    expect(nl.netOf('mcu.D2')).toBe(nl.netOf('b1.+'));
    nl.removeWire(w);
    expect(nl.netOf('mcu.D2')).not.toBe(nl.netOf('b1.+'));
  });
});

describe('LED circuits', () => {
  function ledCircuit() {
    const { bus, nl } = setup();
    nl.addComponent('mcu', 'mcu', { board: 'wemos-d1-mini', pins: ['D2', 'GND', '3V3'] });
    nl.addComponent('r1', 'resistor', { pins: ['p1', 'p2'], resistance: 220 });
    nl.addComponent('led1', 'led', { pins: ['a', 'k'], forwardV: 2 });
    nl.addWire('mcu.D2', 'r1.p1');
    nl.addWire('r1.p2', 'led1.a');
    nl.addWire('led1.k', 'mcu.GND');
    return { bus, nl };
  }

  it('D2 HIGH through 220R lights the LED at ~5.9 mA (3.3V - Vf) / R', () => {
    const { bus, nl } = ledCircuit();
    bus.setMode(4, PIN_OUTPUT);
    bus.write(4, 1);
    const s = nl.resolve();
    const led = s.leds.get('led1')!;
    expect(led.on).toBe(true);
    expect(led.currentMa).toBeCloseTo((3.3 - 2) / 220 * 1000, 1);
    expect(led.brightness).toBeGreaterThan(0.2);
    expect(led.burnt).toBe(false);
  });

  it('D2 LOW leaves the LED dark', () => {
    const { bus, nl } = ledCircuit();
    bus.setMode(4, PIN_OUTPUT);
    bus.write(4, 0);
    expect(nl.resolve().leds.get('led1')!.on).toBe(false);
  });

  it('active-low wiring: VCC -> R -> LED -> pin LOW lights the LED', () => {
    const { bus, nl } = setup();
    nl.addComponent('mcu', 'mcu', { board: 'wemos-d1-mini', pins: ['D2', 'GND', '3V3'] });
    nl.addComponent('r1', 'resistor', { pins: ['p1', 'p2'], resistance: 330 });
    nl.addComponent('led1', 'led', { pins: ['a', 'k'], forwardV: 2 });
    nl.addWire('mcu.3V3', 'r1.p1');
    nl.addWire('r1.p2', 'led1.a');
    nl.addWire('led1.k', 'mcu.D2');
    bus.setMode(4, PIN_OUTPUT);
    bus.write(4, 0);
    expect(nl.resolve().leds.get('led1')!.on).toBe(true);
    bus.write(4, 1);
    expect(nl.resolve().leds.get('led1')!.on).toBe(false);
  });

  it('LED tied to a source with no resistor reports burnt', () => {
    const { bus, nl } = setup();
    nl.addComponent('mcu', 'mcu', { board: 'wemos-d1-mini', pins: ['D2', 'GND'] });
    nl.addComponent('led1', 'led', { pins: ['a', 'k'], forwardV: 2 });
    nl.addWire('mcu.D2', 'led1.a');
    nl.addWire('led1.k', 'mcu.GND');
    bus.setMode(4, PIN_OUTPUT);
    bus.write(4, 1);
    const led = nl.resolve().leds.get('led1')!;
    expect(led.burnt).toBe(true);
  });

  it('PWM drives proportional brightness (duty-scaled average current)', () => {
    const { bus, nl } = ledCircuit();
    bus.analogWrite(4, 512); // half duty
    const full = (() => { bus.analogWrite(4, 1023); const v = nl.resolve().leds.get('led1')!.brightness; bus.analogWrite(4, 512); return v; })();
    const half = nl.resolve().leds.get('led1')!.brightness;
    expect(half).toBeCloseTo(full * (512 / 1023), 1);
  });

  it('series resistance adds up (two resistors in the path)', () => {
    const { bus, nl } = setup();
    nl.addComponent('mcu', 'mcu', { board: 'wemos-d1-mini', pins: ['D2', 'GND'] });
    nl.addComponent('r1', 'resistor', { pins: ['p1', 'p2'], resistance: 110 });
    nl.addComponent('r2', 'resistor', { pins: ['p1', 'p2'], resistance: 110 });
    nl.addComponent('led1', 'led', { pins: ['a', 'k'], forwardV: 2 });
    nl.addWire('mcu.D2', 'r1.p1');
    nl.addWire('r1.p2', 'r2.p1');
    nl.addWire('r2.p2', 'led1.a');
    nl.addWire('led1.k', 'mcu.GND');
    bus.setMode(4, PIN_OUTPUT);
    bus.write(4, 1);
    const led = nl.resolve().leds.get('led1')!;
    expect(led.currentMa).toBeCloseTo((3.3 - 2) / 220 * 1000, 1);
  });
});

describe('buttons', () => {
  it('pressed button closes the circuit, released opens it', () => {
    const { bus, nl } = setup();
    nl.addComponent('mcu', 'mcu', { board: 'wemos-d1-mini', pins: ['D2', 'GND'] });
    nl.addComponent('sw1', 'button', { pins: ['p1', 'p2'] });
    nl.addComponent('r1', 'resistor', { pins: ['p1', 'p2'], resistance: 220 });
    nl.addComponent('led1', 'led', { pins: ['a', 'k'], forwardV: 2 });
    nl.addWire('mcu.3V3', 'sw1.p1');
    nl.addWire('sw1.p2', 'r1.p1');
    nl.addWire('r1.p2', 'led1.a');
    nl.addWire('led1.k', 'mcu.GND');
    void bus;
    expect(nl.resolve().leds.get('led1')!.on).toBe(false); // 3V3 rail exists though
    nl.setSwitchState('sw1', true);
    expect(nl.resolve().leds.get('led1')!.on).toBe(true);
  });

  it('button to GND on an INPUT_PULLUP pin reads LOW when pressed', () => {
    const { bus, nl } = setup();
    nl.addComponent('mcu', 'mcu', { board: 'wemos-d1-mini', pins: ['D2', 'GND'] });
    nl.addComponent('sw1', 'button', { pins: ['p1', 'p2'] });
    nl.addWire('mcu.GND', 'sw1.p1');
    nl.addWire('sw1.p2', 'mcu.D2');
    bus.setMode(4, 'input_pullup');
    expect(nl.resolve().pinLevels.get('mcu.D2')).toBe(1);
    nl.setSwitchState('sw1', true);
    expect(nl.resolve().pinLevels.get('mcu.D2')).toBe(0);
  });
});

describe('wiring faults', () => {
  it('output LOW straight on the 3V3 rail is a conflict', () => {
    const { bus, nl } = setup();
    nl.addComponent('mcu', 'mcu', { board: 'wemos-d1-mini', pins: ['D2', '3V3'] });
    nl.addWire('mcu.D2', 'mcu.3V3');
    bus.setMode(4, PIN_OUTPUT);
    bus.write(4, 0);
    const r = nl.resolve();
    expect(r.faults.length).toBeGreaterThan(0);
    expect(r.faults.some((f) => /short|conflict/i.test(f.message))).toBe(true);
  });

  it('two outputs driving opposite levels are reported', () => {
    const { bus, nl } = setup();
    nl.addComponent('mcu', 'mcu', { board: 'wemos-d1-mini', pins: ['D2', 'D5'] });
    nl.addWire('mcu.D2', 'mcu.D5');
    bus.setMode(4, PIN_OUTPUT); bus.write(4, 1);
    bus.setMode(14, PIN_OUTPUT); bus.write(14, 0);
    const r = nl.resolve();
    expect(r.faults.some((f) => f.kind === 'contention')).toBe(true);
  });
});

describe('stability', () => {
  it('resolve() is deterministic and empty circuit resolves clean', () => {
    const nl = new Netlist(new GpioBus());
    const r = nl.resolve();
    expect(r.leds.size).toBe(0);
    expect(r.faults).toEqual([]);
  });
});

describe('clear', () => {
  it('drops components, wires and switch states', () => {
    const nl = new Netlist(new GpioBus());
    nl.addComponent('mcu', 'mcu', { board: 'wemos-d1-mini', pins: ['D2', 'GND'] });
    nl.addComponent('b1', 'button');
    nl.addWire('mcu.D2', 'b1.p1');
    nl.clear();
    const res = nl.resolve();
    expect(res.faults).toEqual([]);
    expect(res.leds.size).toBe(0);
    expect(res.netOf.get('mcu.D2')).toBeUndefined();
  });
});
