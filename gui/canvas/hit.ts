/**
 * Hit testing in world coordinates. All pure: the interaction layer feeds
 * screen points converted through the Viewport first.
 */

import type { Pt, Rect } from './viewport';

export function pointInRect(p: Pt, r: Rect): boolean {
  return p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h;
}

export function rectIntersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Distance from p to segment a-b, clamped to the segment. */
export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function pointNearSegment(p: Pt, a: Pt, b: Pt, tol: number): boolean {
  return distToSegment(p, a, b) <= tol;
}

export interface PinPoint {
  id: string;
  x: number;
  y: number;
}

/** Closest pin within `radius`, earlier list entry wins ties (stable picks). */
export function nearestPin(pins: PinPoint[], p: Pt, radius: number): string | null {
  let best: string | null = null;
  let bestD = radius;
  for (const pin of pins) {
    const d = Math.hypot(p.x - pin.x, p.y - pin.y);
    if (d <= bestD && (best === null || d < bestD)) {
      best = pin.id;
      bestD = d;
    }
  }
  return best;
}
