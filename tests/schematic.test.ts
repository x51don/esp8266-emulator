import { describe, expect, it } from 'vitest';
import { Schematic, footprintFor, rotatePoint } from '../gui/canvas/schematic';
import { Netlist } from '../peripherals/netlist';
import { GpioBus } from '../peripherals/gpio';
import { Esp8266Machine } from '../core/machine';

describe('Schematic placement', () => {
  it('auto-assigns ids per type', () => {
    const s = new Schematic();
    expect(s.add('led', 30, 20).id).toBe('led-1');
    expect(s.add('led', 60, 20).id).toBe('led-2');
    expect(s.add('resistor', 0, 0).id).toBe('resistor-1');
  });

  it('rejects duplicate explicit ids', () => {
    const s = new Schematic();
    s.add('led', 0, 0, undefined, 'x');
    expect(() => s.add('resistor', 0, 0, undefined, 'x')).toThrow(/duplicate|exists/i);
  });

  it('rotate cycles 0 -> 90 -> 180 -> 270 -> 0', () => {
    const s = new Schematic();
    const c = s.add('led', 0, 0);
    const seen: number[] = [];
    for (let i = 0; i < 5; i++) {
      seen.push(s.component(c.id)!.rot);
      s.rotate(c.id);
    }
    expect(seen).toEqual([0, 90, 180, 270, 0]);
  });

  it('pinWorld applies rotation around the origin pin', () => {
    const s = new Schematic();
    const led = s.add('led', 100, 100);
    expect(s.pinWorld({ comp: led.id, pin: 'k' })).toEqual({ x: 120, y: 100 });
    s.rotate(led.id); // 90 deg CW: (20,0) -> (0,20)
    expect(s.pinWorld({ comp: led.id, pin: 'k' })).toEqual({ x: 100, y: 120 });
  });

  it('rotatePoint rotates clockwise on a y-down screen', () => {
    expect(rotatePoint({ x: 20, y: 0 }, 90)).toEqual({ x: 0, y: 20 });
    expect(rotatePoint({ x: 20, y: 0 }, 180)).toEqual({ x: -20, y: 0 });
    expect(rotatePoint({ x: 20, y: 0 }, 270)).toEqual({ x: 0, y: -20 });
    expect(rotatePoint({ x: 20, y: 0 }, 0)).toEqual({ x: 20, y: 0 });
  });
});

describe('Schematic wiring', () => {
  const wired = () => {
    const s = new Schematic();
    s.addBoard('wemos-d1-mini', 0, 0, 'board');
    const led = s.add('led', 300, 0);
    const r = s.add('resistor', 200, 0);
    return { s, led, r };
  };

  it('stores wires with generated ids', () => {
    const { s, r } = wired();
    const w = s.wire({ comp: 'board', pin: 'D2' }, { comp: r.id, pin: 'p1' });
    expect(w.id).toMatch(/^w\d+$/);
    expect(s.wires.size).toBe(1);
  });

  it('rejects a wire onto the same terminal and duplicate routes', () => {
    const { s, led, r } = wired();
    expect(() => s.wire({ comp: r.id, pin: 'p1' }, { comp: r.id, pin: 'p1' })).toThrow(/itself|same/i);
    s.wire({ comp: r.id, pin: 'p1' }, { comp: led.id, pin: 'a' });
    expect(() => s.wire({ comp: led.id, pin: 'a' }, { comp: r.id, pin: 'p1' })).toThrow(/already|duplicate/i);
  });

  it('removing a component removes its wires', () => {
    const { s, led, r } = wired();
    s.wire({ comp: r.id, pin: 'p1' }, { comp: led.id, pin: 'a' });
    s.wire({ comp: led.id, pin: 'k' }, { comp: 'board', pin: 'GND' });
    s.remove(led.id);
    expect(s.wires.size).toBe(0);
    expect(s.components.size).toBe(2);
  });

  it('componentsIn selects by world rect', () => {
    const { s, led, r } = wired();
    const near = s.componentsIn({ x: 150, y: -30, w: 120, h: 60 });
    expect(near).toContain(r.id);
    expect(near).not.toContain(led.id);
  });
});

describe('footprints', () => {
  it('led and resistor expose their pins', () => {
    expect(footprintFor('led', {}).pins.map((p) => p.name)).toEqual(['a', 'k']);
    expect(footprintFor('resistor', {}).pins.map((p) => p.name)).toEqual(['p1', 'p2']);
  });

  it('board footprint carries every silk pin of the board', () => {
    const fp = footprintFor('board', { board: 'wemos-d1-mini' });
    const names = fp.pins.map((p) => p.name);
    for (const n of ['D0', 'D4', 'D8', 'GND', '3V3', '5V']) expect(names).toContain(n);
  });
});

describe('Schematic -> Netlist sync', () => {
  it('a synced LED chain lights when the sketch drives the pin HIGH', () => {
    const m = new Esp8266Machine({ board: 'wemos-d1-mini' });
    const s = new Schematic();
    s.addBoard('wemos-d1-mini', 0, 0, 'board');
    const led = s.add('led', 300, 0, { forwardV: 2 });
    const r = s.add('resistor', 200, 0, { resistance: 220 });
    s.wire({ comp: 'board', pin: 'D2' }, { comp: r.id, pin: 'p1' });
    s.wire({ comp: r.id, pin: 'p2' }, { comp: led.id, pin: 'a' });
    s.wire({ comp: led.id, pin: 'k' }, { comp: 'board', pin: 'GND' });

    s.syncNetlist(m.netlist);
    m.load('void setup(){ pinMode(D2, OUTPUT); digitalWrite(D2, HIGH); } void loop(){}');
    m.run();
    m.advance(1);

    const ledState = m.circuit().leds.get(led.id);
    expect(ledState).toBeDefined();
    expect(ledState!.on).toBe(true);
    expect(ledState!.burnt).toBe(false);
  });

  it('sync is idempotent: re-sync does not duplicate components', () => {
    const nl = new Netlist(new GpioBus());
    const s = new Schematic();
    s.addBoard('wemos-d1-mini', 0, 0, 'board');
    s.add('led', 300, 0);
    s.syncNetlist(nl);
    s.syncNetlist(nl);
    const res = nl.resolve();
    expect(res.leds.size).toBe(1);
    expect(res.faults).toEqual([]);
  });

  it('a board rail short is reported as a fault after sync', () => {
    const nl = new Netlist(new GpioBus());
    const s = new Schematic();
    s.addBoard('wemos-d1-mini', 0, 0, 'board');
    s.wire({ comp: 'board', pin: '3V3' }, { comp: 'board', pin: 'GND' });
    s.syncNetlist(nl);
    const res = nl.resolve();
    expect(res.faults.some((f) => f.kind === 'short')).toBe(true);
  });
});

describe('Schematic JSON', () => {
  it('round-trips through toJSON/fromJSON', () => {
    const s = new Schematic();
    s.addBoard('wemos-d1-mini', 10, 20, 'board');
    const led = s.add('led', 300, 40, { forwardV: 2.1 });
    const r = s.add('resistor', 200, 40, { resistance: 470 });
    s.wire({ comp: 'board', pin: 'D5' }, { comp: r.id, pin: 'p1' });
    s.rotate(led.id);

    const t = Schematic.fromJSON(s.toJSON());
    expect(t.components.size).toBe(3);
    expect(t.wires.size).toBe(1);
    expect(t.component(led.id)!.rot).toBe(90);
    expect(t.component(led.id)!.params.forwardV).toBe(2.1);
    expect(t.pinWorld({ comp: 'board', pin: 'D5' })).toEqual(s.pinWorld({ comp: 'board', pin: 'D5' }));
    // id counters survive too: the next led must not clash
    expect(t.add('led', 0, 0).id).toBe('led-2');
  });
});
