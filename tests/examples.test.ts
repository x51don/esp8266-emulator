import { describe, expect, it } from 'vitest';
import { EXAMPLE_NAMES, EXAMPLE_SKETCHES, loadExample } from '../gui/examples';
import { parse } from '../core/sketch/parser';
import { Netlist } from '../peripherals/netlist';
import { GpioBus } from '../peripherals/gpio';

describe('example presets', () => {
  it('lists every example', () => {
    expect(EXAMPLE_NAMES).toEqual([
      'blink.ino',
      'pwm-fade.ino',
      'button.ino',
      'serial-hello.ino',
      'pot-serial.ino',
      'ldr-led.ino',
      'dht-oled.ino',
      'servo-pot.ino',
      'neopixel-chase.ino',
      'hcsr-serial.ino',
      'relay-pump.ino',
    ]);
  });

  it('every example preset builds, parses and resolves fault-free', () => {
    for (const name of EXAMPLE_NAMES) {
      const sc = loadExample(name, 'wemos-d1-mini');
      parse(EXAMPLE_SKETCHES[name]); // must compile
      const nl = new Netlist(new GpioBus());
      sc.syncNetlist(nl);
      const faults = nl.resolve().faults;
      expect(faults, name).toEqual([]);
    }
  });

  it('blink builds a board + resistor + LED wired to D4 and GND', () => {
    const sc = loadExample('blink.ino', 'wemos-d1-mini');
    const board = sc.boardComponent();
    expect(board).toBeDefined();
    const types = [...sc.components.values()].map((c) => c.type).sort();
    expect(types).toEqual(['board', 'led', 'resistor']);
    const ends = new Set<string>();
    for (const w of sc.wires.values()) {
      ends.add(`${w.a.comp}.${w.a.pin}`);
      ends.add(`${w.b.comp}.${w.b.pin}`);
    }
    expect(ends.has('board.D4')).toBe(true);
    expect(ends.has('board.GND')).toBe(true);
    // D4 - R - LED - GND chain: 3 wires
    expect(sc.wires.size).toBe(3);
  });

  it('button example wires D3 through a button to GND', () => {
    const sc = loadExample('button.ino', 'wemos-d1-mini');
    const types = [...sc.components.values()].map((c) => c.type);
    expect(types).toContain('button');
    const refs = new Set<string>();
    for (const w of sc.wires.values()) {
      refs.add(`${w.a.comp}.${w.a.pin}`);
      refs.add(`${w.b.comp}.${w.b.pin}`);
    }
    expect(refs.has('board.D3')).toBe(true);
  });

  it('serial-hello is the bare board', () => {
    const sc = loadExample('serial-hello.ino', 'nodemcu-v3');
    expect(sc.components.size).toBe(1);
    expect([...sc.wires.values()]).toEqual([]);
  });

  it('blink preset projects into a fault-free netlist', () => {
    const sc = loadExample('blink.ino', 'wemos-d1-mini');
    const nl = new Netlist(new GpioBus());
    sc.syncNetlist(nl);
    const res = nl.resolve();
    expect(res.faults).toEqual([]);
  });

  it('works on the NodeMCU pinout too', () => {
    const sc = loadExample('blink.ino', 'nodemcu-v3');
    const ends = new Set<string>();
    for (const w of sc.wires.values()) {
      ends.add(`${w.a.comp}.${w.a.pin}`);
      ends.add(`${w.b.comp}.${w.b.pin}`);
    }
    expect(ends.has('board.D4')).toBe(true);
    expect(ends.has('board.GND')).toBe(true);
  });

  it('unknown example throws', () => {
    expect(() => loadExample('nope.ino', 'wemos-d1-mini')).toThrow();
  });

  // Guard for audit H2 (the hcsr preset once hardcoded 'hcsr-1'): a preset
  // must never reference a component it did not just create, or the wire
  // dangles silently (routes and netlist skip it without an error).
  it('no preset leaves dangling wire endpoints', () => {
    for (const name of EXAMPLE_NAMES) {
      const sc = loadExample(name, 'wemos-d1-mini');
      for (const w of sc.wires.values()) {
        expect(sc.components.has(w.a.comp), `${name}: ${w.id}.a`).toBe(true);
        expect(sc.components.has(w.b.comp), `${name}: ${w.id}.b`).toBe(true);
      }
      // every wire must route (dangling endpoints are skipped silently)
      expect(sc.wireRoutes().size, name).toBe(sc.wires.size);
    }
  });
});
