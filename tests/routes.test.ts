import { describe, expect, it } from 'vitest';
import { routeWire, segmentHitsRect, type Rect } from '../gui/canvas/routes';

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
describe('obstacle-aware routing', () => {
  const board: Rect = { x: -16, y: -16, w: 192, h: 216 };
  // midpoint of every non-stub segment (stubs skipped when dirs given)
  const middlesInside = (path: { x: number; y: number }[], r: Rect): boolean => {
    for (let i = 1; i < path.length - 2; i++) {
      const m = { x: (path[i].x + path[i + 1].x) / 2, y: (path[i].y + path[i + 1].y) / 2 };
      if (m.x > r.x && m.x < r.x + r.w && m.y > r.y && m.y < r.y + r.h) return true;
    }
    return false;
  };

  it('segmentHitsRect: crossing vs grazing', () => {
    const r: Rect = { x: 0, y: 0, w: 10, h: 10 };
    expect(segmentHitsRect({ x: -5, y: 5 }, { x: 15, y: 5 }, r)).toBe(true);
    expect(segmentHitsRect({ x: -5, y: 10 }, { x: 15, y: 10 }, r)).toBe(false); // boundary
    expect(segmentHitsRect({ x: 20, y: 0 }, { x: 20, y: 10 }, r)).toBe(false); // beside
  });

  it('straight run through a box is pushed around it', () => {
    const box: Rect = { x: 40, y: -10, w: 20, h: 20 };
    const path = routeWire({ x: 0, y: 0 }, { x: 100, y: 0 }, undefined, undefined, [box]);
    expect(path.length).toBeGreaterThan(2);
    expect(middlesInside(path, box)).toBe(false);
    // still orthogonal
    for (let i = 1; i < path.length; i++)
      expect(path[i].x === path[i - 1].x || path[i].y === path[i - 1].y).toBe(true);
  });

  it('wire between two left-side board pins goes around the board', () => {
    const path = routeWire({ x: 0, y: 60 }, { x: 0, y: 100 }, 'left', 'left', [board]);
    expect(middlesInside(path, board)).toBe(false);
    expect(path.some((p) => p.x <= -16)).toBe(true);
  });

  it('clean straight wire is untouched when obstacles exist elsewhere', () => {
    const path = routeWire({ x: -100, y: -100 }, { x: -40, y: -100 }, undefined, undefined, [board]);
    expect(path).toEqual([{ x: -100, y: -100 }, { x: -40, y: -100 }]);
  });

  it('L-path whose corner crosses the board falls back around it', () => {
    const path = routeWire({ x: 0, y: 40 }, { x: 300, y: 260 }, 'up', 'right', [board]);
    expect(middlesInside(path, board)).toBe(false);
  });
});
});
