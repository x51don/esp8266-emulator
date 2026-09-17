/**
 * Grid math: pick a world-space step that stays readable at any zoom,
 * snap positions to it, and expand a view to whole cells for drawing.
 */

import type { Pt } from './viewport';

export interface WorldBounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const LADDER = [1, 2, 5]; // 10, 20, 50, 100, 200, ...
const BASE = 10;

/**
 * Smallest BASE*k*10^n world step whose on-screen spacing reaches `minPx`.
 * At zoom >= 1 this is the base step; zooming out climbs the 1-2-5 ladder.
 */
export function gridStep(zoom: number, minPx = 10): number {
  let exp = 0;
  for (;;) {
    for (const k of LADDER) {
      const step = BASE * k * 10 ** exp;
      if (step * zoom >= minPx) return step;
    }
    exp++;
    if (exp > 9) return BASE * 10 ** 9; // absurd zoom guard
  }
}

/** Round a point to the nearest multiple of `step`. */
export function snapToGrid(p: Pt, step: number): Pt {
  const r = (v: number): number => Math.round(v / step) * step;
  return { x: r(p.x), y: r(p.y) };
}

/** Expand world bounds outwards to whole step multiples (draw range). */
export function visibleCells(b: WorldBounds, step: number): WorldBounds {
  const norm = (v: number): number => (Object.is(v, -0) ? 0 : v);
  return {
    x0: norm(Math.floor(b.x0 / step) * step),
    y0: norm(Math.floor(b.y0 / step) * step),
    x1: norm(Math.ceil(b.x1 / step) * step),
    y1: norm(Math.ceil(b.y1 / step) * step),
  };
}
