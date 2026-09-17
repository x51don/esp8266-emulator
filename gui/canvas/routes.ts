/**
 * Orthogonal (Manhattan) wire routing: deterministic, grid-friendly paths
 * between two terminals, honouring each pin's exit direction. Pure math;
 * the renderer just strokes the returned polyline.
 */

import type { Pt } from './viewport';

export type Dir = 'up' | 'down' | 'left' | 'right';

const STUB = 20; // how far a wire leaves a pin before bending
const snap10 = (v: number): number => Math.round(v / 10) * 10;

const step = (p: Pt, d: Dir): Pt =>
  d === 'up' ? { x: p.x, y: p.y - STUB }
  : d === 'down' ? { x: p.x, y: p.y + STUB }
  : d === 'left' ? { x: p.x - STUB, y: p.y }
  : { x: p.x + STUB, y: p.y };

const horizontal = (d?: Dir): boolean => d === 'left' || d === 'right';
const dedupe = (pts: Pt[]): Pt[] =>
  pts.filter((p, i) => i === 0 || p.x !== pts[i - 1].x || p.y !== pts[i - 1].y);

export function routeWire(a: Pt, b: Pt, da?: Dir, db?: Dir): Pt[] {
  // Straight run when on one axis and the pins face along it (or face-free).
  if (a.y === b.y && (da === undefined || db === undefined ||
      ((da === 'right' || db === 'right') && b.x > a.x) ||
      ((da === 'left' || db === 'left') && b.x < a.x))) {
    return [a, b];
  }
  if (a.x === b.x && (da === undefined || db === undefined ||
      ((da === 'down' || db === 'down') && b.y > a.y) ||
      ((da === 'up' || db === 'up') && b.y < a.y))) {
    return [a, b];
  }

  const a1 = da ? step(a, da) : a;
  const b1 = db ? step(b, db) : b;
  const aFlat = !da || horizontal(da);
  const bFlat = !db || horizontal(db);

  let pts: Pt[];
  if (aFlat && bFlat) {
    const xm = snap10((a1.x + b1.x) / 2); // vertical bus between the stubs
    pts = [a, a1, { x: xm, y: a1.y }, { x: xm, y: b1.y }, b1, b];
  } else if (!aFlat && !bFlat) {
    const ym = snap10((a1.y + b1.y) / 2); // horizontal bus
    pts = [a, a1, { x: a1.x, y: ym }, { x: b1.x, y: ym }, b1, b];
  } else if (aFlat) {
    pts = [a, a1, { x: b1.x, y: a1.y }, b1, b]; // L: horizontal then vertical
  } else {
    pts = [a, a1, { x: b1.x, y: a1.y }, b1, b]; // L: vertical then horizontal
  }
  return dedupe(pts);
}
