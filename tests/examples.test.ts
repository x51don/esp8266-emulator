import { describe, expect, it } from 'vitest';
import { EXAMPLE_NAMES, loadExample } from '../gui/examples';
import { Netlist } from '../peripherals/netlist';
import { GpioBus } from '../peripherals/gpio';

describe('example presets', () => {
  it('lists the four examples', () => {
    expect(EXAMPLE_NAMES).toEqual([
      'blink.ino',
      'pwm-fade.ino',
      'button.ino',
      'serial-hello.ino',
    ]);
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
});
