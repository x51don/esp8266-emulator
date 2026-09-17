import { describe, expect, it } from 'vitest';
import { pointInRect, rectIntersects, pointNearSegment, nearestPin } from '../gui/canvas/hit';

describe('pointInRect', () => {
  const r = { x: 10, y: 20, w: 100, h: 50 };
  it('inclusive on the origin edges, exclusive on the far edges', () => {
    expect(pointInRect({ x: 10, y: 20 }, r)).toBe(true);
    expect(pointInRect({ x: 109, y: 69 }, r)).toBe(true);
    expect(pointInRect({ x: 110, y: 20 }, r)).toBe(false);
    expect(pointInRect({ x: 9, y: 40 }, r)).toBe(false);
  });
});

describe('rectIntersects', () => {
  it('detects overlap and rejects touching edges', () => {
    expect(rectIntersects({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 })).toBe(true);
    expect(rectIntersects({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 5, h: 5 })).toBe(false);
  });
});

describe('pointNearSegment', () => {
  const a = { x: 0, y: 0 };
  const b = { x: 100, y: 0 };
  it('hits the middle and the endpoints (within tolerance)', () => {
    expect(pointNearSegment({ x: 50, y: 3 }, a, b, 5)).toBe(true);
    expect(pointNearSegment({ x: -3, y: 0 }, a, b, 5)).toBe(true); // beyond a, within tol
    expect(pointNearSegment({ x: 50, y: 6 }, a, b, 5)).toBe(false);
  });
  it('clamps to the segment, not the infinite line', () => {
    expect(pointNearSegment({ x: 150, y: 0 }, a, b, 5)).toBe(false);
  });
  it('handles degenerate segments (points)', () => {
    expect(pointNearSegment({ x: 2, y: 2 }, { x: 0, y: 0 }, { x: 0, y: 0 }, 3)).toBe(true);
    expect(pointNearSegment({ x: 5, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, 3)).toBe(false);
  });
});

describe('nearestPin', () => {
  const pins = [
    { id: 'a', x: 0, y: 0 },
    { id: 'b', x: 40, y: 0 },
  ];
  it('returns the closest pin within radius', () => {
    expect(nearestPin(pins, { x: 35, y: 0 }, 8)).toBe('b');
    expect(nearestPin(pins, { x: 20, y: 0 }, 8)).toBeNull();
  });
  it('ties resolve to the earlier pin (stable)', () => {
    expect(nearestPin(pins, { x: 20, y: 0 }, 25)).toBe('a');
  });
});
