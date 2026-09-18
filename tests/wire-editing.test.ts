import { describe, expect, it } from 'vitest';
import { Netlist } from '../peripherals/netlist';
import { GpioBus } from '../peripherals/gpio';
import { findCrossings, footprintFor, manualPath, Schematic } from '../gui/canvas/schematic';
import { pathThroughRects, routeWiresSequential } from '../gui/canvas/routes';
import type { Rect } from '../gui/canvas/routes';
import type { Pt } from '../gui/canvas/viewport';

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

describe('horizontal flip', () => {
  it('mirrors pins about the body centre', () => {
    const s = new Schematic();
    const led = s.add('led', 100, 100, {});
    s.flip(led.id);
    // led body x=-6 w=32 -> centre x=10; a(0,0)<->k(20,0)
    expect(s.pinWorld({ comp: led.id, pin: 'a' })).toEqual({ x: 120, y: 100 });
    expect(s.pinWorld({ comp: led.id, pin: 'k' })).toEqual({ x: 100, y: 100 });
    // a second flip restores the original positions
    s.flip(led.id);
    expect(s.pinWorld({ comp: led.id, pin: 'a' })).toEqual({ x: 100, y: 100 });
    expect(s.pinWorld({ comp: led.id, pin: 'k' })).toEqual({ x: 120, y: 100 });
  });

  it('flip applies before rotation', () => {
    const s = new Schematic();
    const r = s.add('resistor', 200, 150, { resistance: 1 });
    s.rotate(r.id); // 90 deg
    s.flip(r.id);
    // resistor body x=2 w=16 -> centre 10; p1(0,0)->(20,0)->rot90->(0,20)
    expect(s.pinWorld({ comp: r.id, pin: 'p1' })).toEqual({ x: 200, y: 170 });
    // p2(20,0)->(0,0)->rot90->(0,0)
    expect(s.pinWorld({ comp: r.id, pin: 'p2' })).toEqual({ x: 200, y: 150 });
  });

  it('flip round-trips through the document', () => {
    const s = new Schematic();
    const d = s.add('dht', 100, 100, {});
    s.flip(d.id);
    const t = Schematic.fromJSON(s.toJSON());
    expect(t.component(d.id)!.flip).toBe(true);
    expect(t.pinWorld({ comp: d.id, pin: 'data' })).toEqual(s.pinWorld({ comp: d.id, pin: 'data' }));
  });

  it('routing honours flipped stub directions', () => {
    const s = new Schematic();
    const a = s.add('resistor', 100, 100, { resistance: 1 });
    const b = s.add('resistor', 300, 100, { resistance: 1 });
    s.flip(a.id); // p2 now leaves to the LEFT of the body
    const w = s.wire({ comp: a.id, pin: 'p2' }, { comp: b.id, pin: 'p1' });
    const path = s.wireRoutes().get(w.id)!;
    expect(path[0]).toEqual({ x: 100, y: 100 }); // mirrored p2 sits at body's left
    expect(path[0].x < 120).toBe(true);
  });
});

describe('route hygiene', () => {
  it('paths never reverse back on themselves', () => {
    // preset-like chain: two pins on one row with a body between them
    const s = new Schematic();
    const b = s.addBoard('wemos-d1-mini', 300, 100);
    const r = s.add('resistor', 120, 180, { resistance: 220 });
    const led = s.add('led', 20, 180, {});
    const ws = [
      s.wire({ comp: led.id, pin: 'k' }, { comp: r.id, pin: 'p1' }),
      s.wire({ comp: r.id, pin: 'p2' }, { comp: b.id, pin: 'D4' }),
      s.wire({ comp: led.id, pin: 'a' }, { comp: b.id, pin: 'GND' }),
    ];
    for (const w of ws) {
      const p = s.wireRoutes().get(w.id)!;
      for (let i = 1; i < p.length - 1; i++) {
        const a = p[i - 1];
        const m = p[i];
        const q = p[i + 1];
        const horiz = (u: Pt, v: Pt): boolean => u.y === v.y;
        const vert = (u: Pt, v: Pt): boolean => u.x === v.x;
        // three consecutive points on one axis moving out and back = reversal
        const collinear = (horiz(a, m) && horiz(m, q)) || (vert(a, m) && vert(m, q));
        const reverses =
          (horiz(a, q) && (m.x - a.x) * (q.x - m.x) < 0) ||
          (vert(a, q) && (m.y - a.y) * (q.y - m.y) < 0);
        expect(collinear && reverses).toBe(false);
      }
    }
  });

  it('collinear overlapping wires are not crossings', () => {
    const s = new Schematic();
    const r1 = s.add('resistor', 100, 100, { resistance: 1 });
    const r2 = s.add('resistor', 300, 100, { resistance: 1 });
    const r3 = s.add('resistor', 160, 140, { resistance: 1 });
    const r4 = s.add('resistor', 360, 140, { resistance: 1 });
    const wa = s.wire({ comp: r1.id, pin: 'p2' }, { comp: r2.id, pin: 'p1' });
    const wb = s.wire({ comp: r3.id, pin: 'p2' }, { comp: r4.id, pin: 'p1' });
    s.setWirePath(wa.id, [{ x: 200, y: 100 }, { x: 200, y: 140 }]);
    s.setWirePath(wb.id, [{ x: 200, y: 130 }, { x: 200, y: 200 }, { x: 240, y: 200 }]);
    // wa ends horizontal at y=100..; both share vertical x=200 runs overlapping
    const routes = new Map([
      [wa.id, [{ x: 120, y: 100 }, { x: 200, y: 100 }, { x: 200, y: 140 }, { x: 300, y: 140 }]],
      [wb.id, [{ x: 180, y: 80 }, { x: 200, y: 80 }, { x: 200, y: 120 }, { x: 380, y: 120 }]],
    ]);
    void wa; void wb;
    const xs = findCrossings(routes).filter(
      (c) => !(c.x === 200 && c.y >= 80 && c.y <= 140),
    );
    // the collinear overlap on x=200 (y 100..120) must NOT produce crossings
    const overlap = findCrossings(routes).filter((c) => c.x === 200 && c.y > 80 && c.y < 140);
    expect(overlap.length).toBe(0);
    void xs;
  });
});

describe('route hygiene 2', () => {
  it('a wire never pierces an unrelated body, however its last stub is exempt', () => {
    const resistorBody = { x: 2, y: 172, w: 16, h: 16 };
    const outs = routeWiresSequential([
      { a: { x: 20, y: 180 }, b: { x: -120, y: 180 }, da: 'right', db: 'left', obstacles: [] },
      {
        a: { x: -100, y: 180 }, b: { x: 320, y: 180 }, da: 'right', db: 'left',
        obstacles: [resistorBody, { x: -121, y: 179, w: 142, h: 2 }],
        bodies: [resistorBody],
      },
    ]);
    const hits = pathThroughRects(outs[1], [resistorBody], false, false);
    expect(hits.length).toBe(0);
  });
});
