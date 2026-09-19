/**
 * F14: wire colouring.
 *  - every wire net auto-classifies as power / gnd / signal from the pins it
 *    touches (board rails, battery terminals, VCC/GND part pins);
 *  - defaults follow the electronics convention: power = red, GND = white,
 *    signal = green;
 *  - an explicit per-wire colour beats the auto classification and survives
 *    save/load; junk colours are rejected at import.
 */
import { describe, expect, it } from 'vitest';
import { Schematic, WIRE_ROLE_COLORS, netRoleOf } from '../gui/canvas/schematic';

function bench(): Schematic {
  const s = new Schematic();
  s.addBoard('wemos-d1-mini', 0, 0, 'b1');
  return s;
}

describe('net role classification (F14)', () => {
  it('power: a wire touching a positive board rail is power', () => {
    const s = bench();
    const r = s.add('resistor', 300, 0);
    const w = s.wire({ comp: 'b1', pin: '3V3' }, { comp: r.id, pin: 'p1' });
    expect(netRoleOf(s, w.id)).toBe('power');
  });

  it('gnd: a wire touching GND is gnd even when it also touches a part', () => {
    const s = bench();
    const r = s.add('resistor', 300, 100);
    const w = s.wire({ comp: 'b1', pin: 'GND' }, { comp: r.id, pin: 'p2' });
    expect(netRoleOf(s, w.id)).toBe('gnd');
  });

  it('signal: a GPIO-driven wire is signal', () => {
    const s = bench();
    const led = s.add('led', 300, 200);
    const w = s.wire({ comp: 'b1', pin: 'D1' }, { comp: led.id, pin: 'a' });
    expect(netRoleOf(s, w.id)).toBe('signal');
  });

  it('the role spreads across the whole wire net, not just one hop', () => {
    const s = bench();
    const r = s.add('resistor', 300, 0);
    const j = s.add('resistor', 400, 0);
    // GND -> r.p1 ; r.p2 dangling ; a second wire chained at r.p1 via a jumper wire
    const w1 = s.wire({ comp: 'b1', pin: 'GND' }, { comp: r.id, pin: 'p1' });
    const w2 = s.wire({ comp: r.id, pin: 'p1' }, { comp: j.id, pin: 'p1' });
    expect(netRoleOf(s, w1.id)).toBe('gnd');
    expect(netRoleOf(s, w2.id)).toBe('gnd'); // same net through the shared pin
  });

  it('battery terminals: + is power, - is gnd', () => {
    const s = bench();
    const bat = s.add('battery', 200, 0);
    const r = s.add('resistor', 300, 0);
    const wp = s.wire({ comp: bat.id, pin: '+' }, { comp: r.id, pin: 'p1' });
    const r2 = s.add('resistor', 300, 60);
    const wg = s.wire({ comp: bat.id, pin: '-' }, { comp: r2.id, pin: 'p1' });
    expect(netRoleOf(s, wp.id)).toBe('power');
    expect(netRoleOf(s, wg.id)).toBe('gnd');
  });

  it('VCC/GND named part pins classify too (dht)', () => {
    const s = bench();
    const dht = s.add('dht', 300, 0);
    const wp = s.wire({ comp: dht.id, pin: 'vcc' }, { comp: 'b1', pin: 'D2' });
    const wg = s.wire({ comp: dht.id, pin: 'gnd' }, { comp: 'b1', pin: 'D3' });
    expect(netRoleOf(s, wp.id)).toBe('power');
    expect(netRoleOf(s, wg.id)).toBe('gnd');
  });

  it('a wire with both a rail and GND (a real short) still colours as power', () => {
    const s = bench();
    const w = s.wire({ comp: 'b1', pin: '5V' }, { comp: 'b1', pin: 'GND' });
    expect(netRoleOf(s, w.id)).toBe('power');
  });

  it('dangling / unknown pins fall back to signal', () => {
    const s = bench();
    const a = s.add('resistor', 300, 0);
    const b = s.add('resistor', 400, 0);
    const w = s.wire({ comp: a.id, pin: 'p1' }, { comp: b.id, pin: 'p2' });
    expect(netRoleOf(s, w.id)).toBe('signal');
  });

  it('default palette: power red, GND white, signal green', () => {
    expect(WIRE_ROLE_COLORS.power).toMatch(/^#f/i); // red family
    expect(WIRE_ROLE_COLORS.power).toBe('#ff5252');
    expect(WIRE_ROLE_COLORS.gnd).toBe('#e8eef5');
    expect(WIRE_ROLE_COLORS.signal).toBe('#4ade80');
  });
});

describe('explicit wire colour (F14)', () => {
  it('setWireColor stores and clears', () => {
    const s = bench();
    const a = s.add('resistor', 0, 100);
    const b = s.add('led', 100, 100);
    const w = s.wire({ comp: a.id, pin: 'p1' }, { comp: b.id, pin: 'a' });
    s.setWireColor(w.id, '#00e5ff');
    expect(s.wireOf(w.id)!.color).toBe('#00e5ff');
    s.setWireColor(w.id, undefined);
    expect(s.wireOf(w.id)!.color).toBeUndefined();
  });

  it('colour survives a save/load round trip', () => {
    const s = bench();
    const a = s.add('resistor', 0, 100);
    const b = s.add('led', 100, 100);
    const w = s.wire({ comp: a.id, pin: 'p1' }, { comp: b.id, pin: 'a' });
    s.setWireColor(w.id, '#a020f0');
    const back = Schematic.fromJSON(s.toJSON());
    expect(back.wireOf(w.id)!.color).toBe('#a020f0');
  });

  it('import rejects junk colours instead of painting with them', () => {
    const s = bench();
    const a = s.add('resistor', 0, 100);
    const b = s.add('led', 100, 100);
    const w = s.wire({ comp: a.id, pin: 'p1' }, { comp: b.id, pin: 'a' });
    s.setWireColor(w.id, '#00e5ff');
    const bad = JSON.parse(s.toJSON());
    bad.wires[0].color = 'url(javascript:1)';
    expect(() => Schematic.fromJSON(JSON.stringify(bad))).toThrow(/colour|color/i);
  });
});
