import { describe, expect, it } from 'vitest';
import { gridStep, snapToGrid, visibleCells } from '../gui/canvas/grid';

describe('gridStep', () => {
  it('uses the 10-unit base step at zoom >= ~1', () => {
    expect(gridStep(1)).toBe(10);
    expect(gridStep(2)).toBe(10);
  });

  it('steps up on a 1-2-5 ladder when zoomed out', () => {
    expect(gridStep(0.9)).toBe(20);
    expect(gridStep(0.4)).toBe(50);
    expect(gridStep(0.1)).toBe(100);
  });

  it('never drops below the base step when zoomed in', () => {
    expect(gridStep(4)).toBe(10);
  });

  it('keeps screen spacing at or above the minimum', () => {
    for (const z of [0.09, 0.1, 0.15, 0.3, 0.7, 1, 2.5]) {
      expect(gridStep(z) * z).toBeGreaterThanOrEqual(10 - 1e-9);
    }
  });
});

describe('snapToGrid', () => {
  it('snaps to the nearest multiple', () => {
    expect(snapToGrid({ x: 44, y: -6 }, 10)).toEqual({ x: 40, y: -10 });
    expect(snapToGrid({ x: 45, y: 4 }, 10)).toEqual({ x: 50, y: 0 });
  });
});

describe('visibleCells', () => {
  it('returns world bounds expanded to step multiples', () => {
    const r = visibleCells({ x0: 5, y0: 12, x1: 46, y1: 18 }, 10);
    expect(r).toEqual({ x0: 0, y0: 10, x1: 50, y1: 20 });
  });

  it('handles negative coordinates', () => {
    const r = visibleCells({ x0: -25, y0: -1, x1: -5, y1: 4 }, 10);
    expect(r).toEqual({ x0: -30, y0: -10, x1: 0, y1: 10 });
  });
});
