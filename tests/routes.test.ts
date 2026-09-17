import { describe, expect, it } from 'vitest';
import { routeWire } from '../gui/canvas/routes';

describe('routeWire (orthogonal Manhattan routing)', () => {
  it('straight horizontal line stays two points', () => {
    expect(routeWire({ x: 0, y: 0 }, { x: 100, y: 0 })).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ]);
  });

  it('straight vertical line stays two points', () => {
    expect(routeWire({ x: 50, y: 0 }, { x: 50, y: 90 })).toEqual([
      { x: 50, y: 0 },
      { x: 50, y: 90 },
    ]);
  });

  it('offset pins get an orthogonal Z with stubs on both ends', () => {
    const pts = routeWire({ x: 0, y: 0 }, { x: 100, y: 40 }, 'right', 'left');
    // starts going right, ends coming from the left
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    expect(pts[1]).toEqual({ x: 20, y: 0 });
    expect(pts[pts.length - 2]).toEqual({ x: 80, y: 40 });
    expect(pts[pts.length - 1]).toEqual({ x: 100, y: 40 });
    // strictly orthogonal
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      expect(a.x === b.x || a.y === b.y).toBe(true);
    }
  });

  it('respects pin exit directions (down then around)', () => {
    const pts = routeWire({ x: 0, y: 0 }, { x: 40, y: 60 }, 'down', 'up');
    expect(pts[1]).toEqual({ x: 0, y: 20 });
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      expect(a.x === b.x || a.y === b.y).toBe(true);
    }
  });

  it('collinear same-direction stubs never produce a crossing detour', () => {
    const pts = routeWire({ x: 0, y: 0 }, { x: -60, y: 0 }, 'left', 'right');
    expect(pts).toEqual([{ x: 0, y: 0 }, { x: -60, y: 0 }]);
  });

  it('snaps the mid-jog (bus line) to the 10-unit grid', () => {
    const pts = routeWire({ x: 0, y: 5 }, { x: 97, y: 53 }, 'right', 'left');
    // the middle segment is the bus: one vertical, its x on the grid
    const mid = pts[Math.floor(pts.length / 2) - 1];
    const mid2 = pts[Math.floor(pts.length / 2)];
    expect(mid.x).toBe(mid2.x);
    expect(mid.x % 10).toBe(0);
  });
});
