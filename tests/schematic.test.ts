import { describe, expect, it } from 'vitest';
import { getBoard } from '../core/boards';
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

describe('wireObstacles', () => {
  it('keeps big endpoint bodies (board) but drops small own bodies', () => {
    const sc = new Schematic();
    sc.addBoard('wemos-d1-mini', 0, 0);
    const led = sc.add('led', 300, 0, {});
    const obs = sc.wireObstacles({ comp: 'board', pin: 'D4' }, { comp: led.id, pin: 'a' });
    // board body stays (the wire must leave around it), the LED's own tiny body is out
    expect(obs.some((r) => r.w > 100)).toBe(true);
    expect(obs.some((r) => r.w < 44 && r.h < 44 && r.x > 200)).toBe(false);
  });
});

describe('wireRoutes', () => {
  it('caches until the document changes', () => {
    const sc = new Schematic();
    sc.addBoard('wemos-d1-mini', 0, 0);
    const r = sc.add('resistor', 300, 0, {});
    sc.wire({ comp: 'board', pin: 'D4' }, { comp: r.id, pin: 'p1' });
    const a = sc.wireRoutes();
    expect(sc.wireRoutes()).toBe(a);
    sc.move(r.id, 300, 40);
    expect(sc.wireRoutes()).not.toBe(a);
  });

  it('skips dangling wires instead of throwing', () => {
    const sc = new Schematic();
    sc.addBoard('wemos-d1-mini', 0, 0);
    const r = sc.add('resistor', 300, 0, {});
    const good = sc.wire({ comp: 'board', pin: 'D4' }, { comp: r.id, pin: 'p1' });
    sc.wires.set('ghost', { id: 'ghost', a: { comp: 'nope', pin: 'x' }, b: { comp: 'board', pin: 'GND' } });
    const routes = sc.wireRoutes();
    expect(routes.has(good.id)).toBe(true);
    expect(routes.has('ghost')).toBe(false);
  });
});

describe('Schematic JSON validation (P0.4)', () => {
  const doc = (over: Record<string, unknown>) =>
    JSON.stringify({ comps: [], wires: [], seq: {}, wireSeq: 0, ...over });

  it('rejects an unknown component type with a clear error', () => {
    const bad = doc({ comps: [{ id: 'x1', type: 'toaster', x: 0, y: 0, rot: 0, params: {} }] });
    expect(() => Schematic.fromJSON(bad)).toThrow(/unknown component type/i);
  });

  it('rejects non-object and missing-field documents instead of TypeError later', () => {
    expect(() => Schematic.fromJSON('{}')).toThrow(/invalid schematic document/i);
    expect(() => Schematic.fromJSON('[]')).toThrow(/invalid schematic document/i);
    expect(() => Schematic.fromJSON(doc({ comps: [{ id: 'a' }] }))).toThrow(/invalid schematic document/i);
  });

  it('rejects garbage coordinates, rot and wire endpoints', () => {
    expect(() =>
      Schematic.fromJSON(doc({ comps: [{ id: 'a', type: 'led', x: '5', y: 0, rot: 0, params: {} }] })),
    ).toThrow(/invalid schematic document/i);
    expect(() =>
      Schematic.fromJSON(doc({ comps: [{ id: 'a', type: 'led', x: 0, y: 0, rot: 45, params: {} }] })),
    ).toThrow(/invalid schematic document/i);
    const led = [{ id: 'a', type: 'led', x: 0, y: 0, rot: 0, params: {} }];
    expect(() =>
      Schematic.fromJSON(doc({ comps: led, wires: [{ id: 'w1', a: { comp: 'a' }, b: { comp: 'a', pin: 'k' } }] })),
    ).toThrow(/invalid schematic document/i);
  });

  it('a board component with an unknown board id is rejected', () => {
    expect(() =>
      Schematic.fromJSON(doc({ comps: [{ id: 'board', type: 'board', x: 0, y: 0, rot: 0, params: { board: 'rpi-9' } }] })),
    ).toThrow(/unknown board/i);
  });

  it('accepts a hand-written but valid document', () => {
    const ok = doc({
      comps: [{ id: 'led-1', type: 'led', x: 10, y: 20, rot: 90, params: { forwardV: 2 } }],
      wires: [{ id: 'w1', a: { comp: 'led-1', pin: 'a' }, b: { comp: 'led-1', pin: 'k' } }],
    });
    const s = Schematic.fromJSON(ok);
    expect(s.components.size).toBe(1);
    expect(s.wires.size).toBe(1);
  });
});

describe('document mutation coherence (P0.5)', () => {
  const wiredBoard = () => {
    const s = new Schematic();
    s.addBoard('wemos-d1-mini', 0, 0, 'board');
    const led = s.add('led', 400, 0, { forwardV: 2 });
    // D8 sits at row 2 on Wemos but row 6 on NodeMCU: the route endpoint must
    // move when the model changes, or the route cache is stale.
    const w = s.wire({ comp: 'board', pin: 'D8' }, { comp: led.id, pin: 'a' });
    s.wireRoutes(); // populate the route cache
    return { s, w };
  };

  it('setParam invalidates the route cache', () => {
    const { s, w } = wiredBoard();
    const before = JSON.stringify(s.wireRoutes().get(w.id));
    s.setParam('board', 'board', 'nodemcu-v3');
    const after = s.wireRoutes().get(w.id);
    expect(JSON.stringify(after)).not.toBe(before);
    expect(after?.[0].y).toBe(getBoard('nodemcu-v3').rails.find((r) => r.name === 'D8')!.row * 20);
  });

  it('setBoard swaps the model, touches the cache and validates the id', () => {
    const { s } = wiredBoard();
    const yBefore = s.pinWorld({ comp: 'board', pin: 'D8' }).y;
    s.setBoard('nodemcu-v3');
    expect(s.pinWorld({ comp: 'board', pin: 'D8' }).y).not.toBe(yBefore);
    expect(() => s.setBoard('rpi-zero')).toThrow(/unknown board/i);
  });
});

describe('cheap drag (P1.2)', () => {
  it('routes stay frozen between beginDrag and endDrag', () => {
    const s = new Schematic();
    s.addBoard('wemos-d1-mini', 0, 0, 'board');
    const led = s.add('led', 300, 0, { forwardV: 2 });
    const w = s.wire({ comp: 'board', pin: 'D5' }, { comp: led.id, pin: 'a' });
    const map0 = s.wireRoutes();
    const arr0 = map0.get(w.id)!;

    s.beginDrag();
    s.move(led.id, 600, 300);
    s.rotate(led.id);
    const during = s.wireRoutes();
    expect(during).toBe(map0); // same object: nothing was recomputed
    expect(during.get(w.id)).toBe(arr0);

    s.endDrag();
    const after = s.wireRoutes();
    expect(after).not.toBe(map0);
    expect(after.get(w.id)).not.toBe(arr0);
    // committed route ends at the NEW pin position
    const pin = s.pinWorld({ comp: led.id, pin: 'a' });
    const end = after.get(w.id)!.at(-1)!;
    expect(Math.abs(end.x - pin.x) <= 1 && Math.abs(end.y - pin.y) <= 1).toBe(true);
  });

  it('endDrag without beginDrag still commits (touch semantics)', () => {
    const s = new Schematic();
    s.addBoard('wemos-d1-mini', 0, 0, 'board');
    const led = s.add('led', 300, 0, {});
    const w = s.wire({ comp: 'board', pin: 'D5' }, { comp: led.id, pin: 'a' });
    const map0 = s.wireRoutes();
    s.endDrag();
    expect(s.wireRoutes()).not.toBe(map0); // behaves like a plain invalidation
    void w;
  });
});

describe('document version signal (P1.3)', () => {
  it('bumps on every mutation, never on reads', () => {
    const s = new Schematic();
    const v0 = s.version;
    s.addBoard('wemos-d1-mini', 0, 0, 'board');
    expect(s.version).toBeGreaterThan(v0);
    const v1 = s.version;
    const led = s.add('led', 300, 0, {});
    expect(s.version).toBeGreaterThan(v1);
    const v2 = s.version;
    const w = s.wire({ comp: 'board', pin: 'D5' }, { comp: led.id, pin: 'a' });
    expect(s.version).toBeGreaterThan(v2);
    s.move(led.id, 320, 20);
    expect(s.version).toBeGreaterThan(v2);
    const v3 = s.version;
    s.wireRoutes();
    s.wireCrossings();
    s.component(led.id);
    expect(s.version).toBe(v3); // reads do not dirty
    s.endDrag();
    void w;
  });
});

describe('component labels (F3.2)', () => {
  it('a label round-trips through toJSON/fromJSON', () => {
    const sc = new Schematic();
    sc.addBoard('wemos-d1-mini', 0, 0);
    const led = sc.add('led', 100, 0, { forwardV: 2 });
    sc.setLabel(led.id, 'STATUS');
    const back = Schematic.fromJSON(sc.toJSON());
    expect(back.component(led.id)!.label).toBe('STATUS');
  });

  it('a non-string label is a malformed document', () => {
    const sc = new Schematic();
    sc.addBoard('wemos-d1-mini', 0, 0);
    const doc = JSON.parse(sc.toJSON());
    doc.comps[0].label = { evil: true };
    expect(() => Schematic.fromJSON(JSON.stringify(doc))).toThrow(/malformed/);
  });

  it('setLabel("") clears the label; missing ids are a no-op', () => {
    const sc = new Schematic();
    sc.addBoard('wemos-d1-mini', 0, 0);
    const b = sc.add('button', 100, 0, {});
    sc.setLabel(b.id, 'KEY');
    expect(sc.component(b.id)!.label).toBe('KEY');
    sc.setLabel(b.id, '');
    expect(sc.component(b.id)!.label).toBeUndefined();
    sc.setLabel('nope', 'x'); // must not throw
  });
});
