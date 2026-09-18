import { describe, expect, it } from 'vitest';
import { Netlist } from '../peripherals/netlist';
import { GpioBus } from '../peripherals/gpio';
import { footprintFor, manualPath, Schematic } from '../gui/canvas/schematic';
import type { Rect } from '../gui/canvas/routes';

// Round 4: manual wire waypoints, crossing detection and the capacitor part.

function twoResistors(): { s: Schematic; ids: string[] } {
  const s = new Schematic();
  const a = s.add('resistor', 100, 100, { resistance: 220 });
  const b = s.add('resistor', 300, 100, { resistance: 220 });
  return { s, ids: [a.id, b.id] };
}

describe('manualPath', () => {
  it('joins waypoints with orthogonal elbows', () => {
    const p = manualPath({ x: 0, y: 0 }, [{ x: 50, y: 30 }, { x: 80, y: 80 }], { x: 120, y: 80 });
    expect(p).toEqual([
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 50, y: 30 },
      { x: 80, y: 30 },
      { x: 80, y: 80 },
      { x: 120, y: 80 },
    ]);
  });
});

describe('Schematic manual wire routes', () => {
  it('setWirePath pins the route; clearWirePath restores auto-routing', () => {
    const { s, ids } = twoResistors();
    const w = s.wire({ comp: ids[0], pin: 'p2' }, { comp: ids[1], pin: 'p1' });
    expect(s.wireRoutes().get(w.id)).toEqual([
      { x: 120, y: 100 },
      { x: 300, y: 100 },
    ]);
    s.setWirePath(w.id, [{ x: 120, y: 160 }, { x: 300, y: 160 }]);
    expect(s.wireRoutes().get(w.id)).toEqual([
      { x: 120, y: 100 },
      { x: 120, y: 160 },
      { x: 300, y: 160 },
      { x: 300, y: 100 },
    ]);
    s.clearWirePath(w.id);
    expect(s.wireRoutes().get(w.id)).toEqual([
      { x: 120, y: 100 },
      { x: 300, y: 100 },
    ]);
  });
});

describe('Schematic.wireCrossings', () => {
  it('reports a perpendicular crossing with coordinates', () => {
    const s = new Schematic();
    const r1 = s.add('resistor', 100, 100, { resistance: 220 });
    const r2 = s.add('resistor', 300, 100, { resistance: 220 });
    const r3 = s.add('resistor', 200, 0, { resistance: 220 });
    const r4 = s.add('resistor', 200, 300, { resistance: 220 });
    const wa = s.wire({ comp: r1.id, pin: 'p1' }, { comp: r2.id, pin: 'p1' });
    const wb = s.wire({ comp: r3.id, pin: 'p2' }, { comp: r4.id, pin: 'p1' });
    s.setWirePath(wb.id, [{ x: 200, y: 150 }]);
    const xs = s.wireCrossings();
    expect(xs).toHaveLength(1);
    expect(xs[0]).toMatchObject({ x: 200, y: 100, w1: wa.id, w2: wb.id, endpoint: false });
  });

  it('parallel wires produce no crossings', () => {
    const s = new Schematic();
    const r1 = s.add('resistor', 100, 100, { resistance: 220 });
    const r2 = s.add('resistor', 300, 100, { resistance: 220 });
    const r3 = s.add('resistor', 100, 160, { resistance: 220 });
    const r4 = s.add('resistor', 300, 160, { resistance: 220 });
    s.wire({ comp: r1.id, pin: 'p2' }, { comp: r2.id, pin: 'p1' });
    s.wire({ comp: r3.id, pin: 'p2' }, { comp: r4.id, pin: 'p1' });
    expect(s.wireCrossings()).toHaveLength(0);
  });

  it('detects a T-junction where an endpoint touches another wire', () => {
    const s = new Schematic();
    const r1 = s.add('resistor', 100, 100, { resistance: 220 });
    const r2 = s.add('resistor', 300, 100, { resistance: 220 });
    const r3 = s.add('resistor', 200, 200, { resistance: 220 });
    const wa = s.wire({ comp: r1.id, pin: 'p1' }, { comp: r2.id, pin: 'p1' });
    const wb = s.wire({ comp: r3.id, pin: 'p1' }, { comp: r1.id, pin: 'p2' });
    // wb's endpoint (120,100) lands in the middle of wa's straight run
    s.setWirePath(wb.id, [{ x: 120, y: 200 }]);
    const xs = s.wireCrossings();
    expect(xs).toHaveLength(1);
    expect(xs[0]).toMatchObject({ x: 120, y: 100, endpoint: true, w1: wa.id, w2: wb.id });
  });
});

describe('capacitor', () => {
  it('has a two-pin footprint', () => {
    const fp = footprintFor('cap', { uf: 100 });
    expect(fp.pins.map((p) => p.name)).toEqual(['p1', 'p2']);
  });

  it('is an open circuit in the netlist: no net merge, no faults', () => {
    const nl = new Netlist(new GpioBus());
    nl.addComponent('mcu', 'mcu', { board: 'wemos-d1-mini', pins: ['D2', 'GND'] });
    nl.addComponent('r1', 'resistor', { resistance: 1000 });
    nl.addComponent('c1', 'cap');
    nl.addWire('mcu.D2', 'r1.p1');
    nl.addWire('r1.p2', 'c1.p1');
    nl.addWire('c1.p2', 'mcu.GND');
    const res = nl.resolve();
    expect(res.faults).toHaveLength(0);
    expect(nl.netOf('c1.p1')).not.toBe(nl.netOf('c1.p2'));
  });
});

describe('body-blocked routing in a schematic', () => {
  it('sequential wire routing never cuts through a placed body', () => {
    const s = new Schematic();
    const r1 = s.add('resistor', 0, 60, { resistance: 220 });
    const r2 = s.add('resistor', 400, 60, { resistance: 220 });
    // wall of parts right between the two pins
    const blockers = [160, 190, 220].map((x) => s.add('resistor', x, 30, { resistance: 220 }));
    void blockers;
    const w = s.wire({ comp: r1.id, pin: 'p2' }, { comp: r2.id, pin: 'p1' });
    const path = s.wireRoutes().get(w.id)!;
    const bodies: Rect[] = [...s.components.values()].map((c) => s.bodyRect(c));
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1];
      const q = path[i];
      const inside = bodies.some((b) =>
        a.y === q.y
          ? a.y > b.y && a.y < b.y + b.h &&
            Math.min(a.x, q.x) < b.x + b.w && Math.max(a.x, q.x) > b.x
          : a.x > b.x && a.x < b.x + b.w &&
            Math.min(a.y, q.y) < b.y + b.h && Math.max(a.y, q.y) > b.y,
      );
      expect(inside).toBe(false);
    }
  });
});
