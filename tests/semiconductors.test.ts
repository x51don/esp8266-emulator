/**
 * F15: diode, Zener diode and transistor in the solver.
 *
 * Model (documented approximation, consistent with the digital-ish solver):
 * a forward-biased diode / energized transistor becomes a small-resistance
 * link inside the conductive graph, so current through downstream LEDs is
 * computed normally; bias is probed the way the relay coil probes its own.
 */
import { describe, it, expect } from 'vitest';
import { Netlist } from '../peripherals/netlist';
import { GpioBus, PIN_OUTPUT } from '../peripherals/gpio';

function bench() {
  const bus = new GpioBus();
  const nl = new Netlist(bus);
  nl.addComponent('mcu', 'mcu', { board: 'wemos-d1-mini', pins: ['D2', 'D1', 'GND', '3V3', '5V'] });
  return { bus, nl };
}

describe('diode', () => {
  it('conducts forward: 3V3 - 220R - diode - GND passes ~(3.3-0.7)/220 mA', () => {
    const { nl } = bench();
    nl.addComponent('r1', 'resistor', { pins: ['p1', 'p2'], resistance: 220 });
    nl.addComponent('d1', 'diode', { pins: ['a', 'k'] });
    nl.addWire('mcu.3V3', 'r1.p1');
    nl.addWire('r1.p2', 'd1.a');
    nl.addWire('d1.k', 'mcu.GND');
    const s = nl.resolve();
    const d = s.semis.get('d1')!;
    expect(d.on).toBe(true);
    expect(d.mode).toBe('fwd');
    // path R seen by the solver includes the conducting junction; current
    // must be in the right decade and clearly non-zero
    expect(d.currentMa).toBeGreaterThan(5);
    expect(d.currentMa).toBeLessThan(15);
    expect(d.burnt).toBe(false);
  });

  it('blocks in reverse: the far side stays dead (no LED current)', () => {
    const { nl } = bench();
    nl.addComponent('r1', 'resistor', { pins: ['p1', 'p2'], resistance: 220 });
    nl.addComponent('d1', 'diode', { pins: ['a', 'k'] });
    nl.addComponent('led1', 'led', { pins: ['a', 'k'], forwardV: 2 });
    nl.addWire('mcu.3V3', 'r1.p1');
    nl.addWire('r1.p2', 'd1.k'); // reversed!
    nl.addWire('d1.a', 'led1.a');
    nl.addWire('led1.k', 'mcu.GND');
    const s = nl.resolve();
    expect(s.semis.get('d1')!.on).toBe(false);
    expect(s.leds.get('led1')!.on).toBe(false);
  });

  it('passes current downstream when forward-biased (LED after diode lights)', () => {
    const { bus, nl } = bench();
    nl.addComponent('r1', 'resistor', { pins: ['p1', 'p2'], resistance: 220 });
    nl.addComponent('d1', 'diode', { pins: ['a', 'k'] });
    nl.addComponent('led1', 'led', { pins: ['a', 'k'], forwardV: 2 });
    nl.addWire('mcu.D1', 'r1.p1');
    nl.addWire('r1.p2', 'd1.a');
    nl.addWire('d1.k', 'led1.a');
    nl.addWire('led1.k', 'mcu.GND');
    bus.setMode(5, PIN_OUTPUT); // D1 -> GPIO5
    bus.write(5, 1);
    const s = nl.resolve();
    expect(s.semis.get('d1')!.on).toBe(true);
    expect(s.leds.get('led1')!.on).toBe(true);
  });

  it('diode straight across 5V and GND burns and faults', () => {
    const { nl } = bench();
    nl.addComponent('d1', 'diode', { pins: ['a', 'k'] });
    nl.addWire('mcu.5V', 'd1.a');
    nl.addWire('d1.k', 'mcu.GND');
    const s = nl.resolve();
    expect(s.semis.get('d1')!.burnt).toBe(true);
    expect(s.faults.some((f) => /d1/.test(f.message))).toBe(true);
  });
});

describe('zener', () => {
  it('acts as a plain diode in forward bias', () => {
    const { nl } = bench();
    nl.addComponent('r1', 'resistor', { pins: ['p1', 'p2'], resistance: 220 });
    nl.addComponent('z1', 'zener', { pins: ['a', 'k'], vz: 5.1 });
    nl.addWire('mcu.3V3', 'r1.p1');
    nl.addWire('r1.p2', 'z1.a');
    nl.addWire('z1.k', 'mcu.GND');
    const s = nl.resolve();
    expect(s.semis.get('z1')!.mode).toBe('fwd');
    expect(s.semis.get('z1')!.on).toBe(true);
  });

  it('blocks reverse below Vz', () => {
    const { nl } = bench();
    nl.addComponent('r1', 'resistor', { pins: ['p1', 'p2'], resistance: 220 });
    nl.addComponent('z1', 'zener', { pins: ['a', 'k'], vz: 5.1 });
    nl.addComponent('led1', 'led', { pins: ['a', 'k'], forwardV: 2 });
    nl.addWire('mcu.3V3', 'r1.p1');
    nl.addWire('r1.p2', 'z1.k'); // cathode to the supply side
    nl.addWire('z1.a', 'led1.a'); // anode side goes down to GND via LED
    nl.addWire('led1.k', 'mcu.GND');
    const s = nl.resolve();
    // 3.3V reverse < 5.1V Vz: no breakdown, no LED current
    expect(s.semis.get('z1')!.mode).not.toBe('rev');
    expect(s.leds.get('led1')!.on).toBe(false);
  });

  it('breaks down at Vz and feeds the load', () => {
    const { bus, nl } = bench();
    void bus;
    nl.addComponent('r1', 'resistor', { pins: ['p1', 'p2'], resistance: 220 });
    nl.addComponent('z1', 'zener', { pins: ['a', 'k'], vz: 3.0 });
    nl.addComponent('led1', 'led', { pins: ['a', 'k'], forwardV: 2 });
    nl.addWire('mcu.5V', 'r1.p1');
    nl.addWire('r1.p2', 'z1.k');
    nl.addWire('z1.a', 'led1.a');
    nl.addWire('led1.k', 'mcu.GND');
    const s = nl.resolve();
    expect(s.semis.get('z1')!.mode).toBe('rev');
    expect(s.semis.get('z1')!.on).toBe(true);
    expect(s.leds.get('led1')!.on).toBe(true);
  });
});

describe('transistor', () => {
  // classic low-side driver: LED from 3V3 into the collector, emitter to GND
  function npnDriver() {
    const { bus, nl } = bench();
    nl.addComponent('rb', 'resistor', { pins: ['p1', 'p2'], resistance: 1000 });
    nl.addComponent('rc', 'resistor', { pins: ['p1', 'p2'], resistance: 220 });
    nl.addComponent('led1', 'led', { pins: ['a', 'k'], forwardV: 2 });
    nl.addComponent('q1', 'transistor', { pins: ['c', 'b', 'e'], polarity: 'npn' });
    nl.addWire('mcu.D2', 'rb.p1');
    nl.addWire('rb.p2', 'q1.b');
    nl.addWire('q1.e', 'mcu.GND');
    nl.addWire('mcu.3V3', 'rc.p1');
    nl.addWire('rc.p2', 'led1.a');
    nl.addWire('led1.k', 'q1.c');
    return { bus, nl };
  }

  it('NPN: base HIGH sinks the collector load, LED lights', () => {
    const { bus, nl } = npnDriver();
    bus.setMode(4, PIN_OUTPUT); // D2 -> GPIO4
    bus.write(4, 1);
    const s = nl.resolve();
    expect(s.semis.get('q1')!.on).toBe(true);
    expect(s.leds.get('led1')!.on).toBe(true);
  });

  it('NPN: base LOW (or floating) leaves the load off', () => {
    const { bus, nl } = npnDriver();
    bus.setMode(4, PIN_OUTPUT);
    bus.write(4, 0);
    const s = nl.resolve();
    expect(s.semis.get('q1')!.on).toBe(false);
    expect(s.leds.get('led1')!.on).toBe(false);
  });

  it('PNP: emitter at 3V3, base pulled LOW switches the high-side load', () => {
    const { bus, nl } = bench();
    nl.addComponent('rb', 'resistor', { pins: ['p1', 'p2'], resistance: 1000 });
    nl.addComponent('rc', 'resistor', { pins: ['p1', 'p2'], resistance: 220 });
    nl.addComponent('led1', 'led', { pins: ['a', 'k'], forwardV: 2 });
    nl.addComponent('q1', 'transistor', { pins: ['c', 'b', 'e'], polarity: 'pnp' });
    nl.addWire('mcu.3V3', 'q1.e');
    nl.addWire('mcu.D2', 'rb.p1');
    nl.addWire('rb.p2', 'q1.b');
    nl.addWire('q1.c', 'rc.p1');
    nl.addWire('rc.p2', 'led1.a');
    nl.addWire('led1.k', 'mcu.GND');
    bus.setMode(4, PIN_OUTPUT);
    bus.write(4, 0); // LOW base = on for a PNP
    let s = nl.resolve();
    expect(s.semis.get('q1')!.on).toBe(true);
    expect(s.leds.get('led1')!.on).toBe(true);
    bus.write(4, 1);
    s = nl.resolve();
    expect(s.semis.get('q1')!.on).toBe(false);
    expect(s.leds.get('led1')!.on).toBe(false);
  });

  it('saturated NPN across 5V and GND with no load burns', () => {
    const { bus, nl } = bench();
    nl.addComponent('q1', 'transistor', { pins: ['c', 'b', 'e'], polarity: 'npn' });
    nl.addWire('mcu.D2', 'q1.b');
    nl.addWire('q1.e', 'mcu.GND');
    nl.addWire('mcu.5V', 'q1.c');
    bus.setMode(4, PIN_OUTPUT);
    bus.write(4, 1);
    const s = nl.resolve();
    expect(s.semis.get('q1')!.burnt).toBe(true);
  });
});
