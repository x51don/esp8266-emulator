/**
 * Orthogonal (Manhattan) wire routing: deterministic, grid-friendly paths
 * between two terminals, honouring each pin's exit direction and optionally
 * routing around component bodies (obstacles). Pure math; the renderer just
 * strokes the returned polyline.
 */

import type { Pt } from './viewport';

export type Dir = 'up' | 'down' | 'left' | 'right';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const STUB = 20; // how far a wire leaves a pin before bending
const PAD = 6; // keep paths this far from obstacle edges
const snap10 = (v: number): number => Math.round(v / 10) * 10;

const step = (p: Pt, d: Dir): Pt =>
  d === 'up' ? { x: p.x, y: p.y - STUB }
  : d === 'down' ? { x: p.x, y: p.y + STUB }
  : d === 'left' ? { x: p.x - STUB, y: p.y }
  : { x: p.x + STUB, y: p.y };

const horizontal = (d?: Dir): boolean => d === 'left' || d === 'right';
const dedupe = (pts: Pt[]): Pt[] =>
  pts.filter((p, i) => i === 0 || p.x !== pts[i - 1].x || p.y !== pts[i - 1].y);

/** True when the orthogonal segment passes strictly through the rect. */
export function segmentHitsRect(p: Pt, q: Pt, r: Rect): boolean {
  const x0 = r.x;
  const x1 = r.x + r.w;
  const y0 = r.y;
  const y1 = r.y + r.h;
  if (p.y === q.y) {
    const y = p.y;
    if (y <= y0 || y >= y1) return false;
    return Math.max(p.x, q.x) > x0 && Math.min(p.x, q.x) < x1;
  }
  if (p.x === q.x) {
    const x = p.x;
    if (x <= x0 || x >= x1) return false;
    return Math.max(p.y, q.y) > y0 && Math.min(p.y, q.y) < y1;
  }
  return false;
}

/** Middle-segment hits (exit stubs excluded when the path carries them). */
function pathHits(path: Pt[], obstacles: Rect[], stubA: boolean, stubB: boolean): Rect[] {
  const hits: Rect[] = [];
  const first = stubA ? 1 : 0;
  const last = path.length - 2 - (stubB ? 1 : 0);
  for (let i = first; i <= last; i++) {
    for (const r of obstacles) {
      if (segmentHitsRect(path[i], path[i + 1], r) && !hits.includes(r)) hits.push(r);
    }
  }
  return hits;
}

/**
 * Push every offending middle segment to the nearer open side of the rect,
 * repeating until the path is clean or the pass budget runs out.
 */
function detour(path: Pt[], obstacles: Rect[], stubA: boolean, stubB: boolean): Pt[] {
  let pts = path;
  for (let pass = 0; pass < 6; pass++) {
    const hits = pathHits(pts, obstacles, stubA, stubB);
    if (hits.length === 0) return pts;
    const r = hits[0];
    const first = stubA ? 1 : 0;
    const last = pts.length - 2 - (stubB ? 1 : 0);
    const out: Pt[] = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const p = pts[i];
      const q = pts[i + 1];
      const isMiddle = i >= first && i <= last;
      out.push(p);
      if (isMiddle && segmentHitsRect(p, q, r)) {
        if (p.y === q.y) {
          const top = r.y - PAD;
          const bot = r.y + r.h + PAD;
          const side = Math.abs(p.y - top) <= Math.abs(p.y - bot) ? top : bot;
          if (p.x !== q.x) out.push({ x: p.x, y: side }, { x: q.x, y: side });
          else out.push({ x: p.x, y: side });
        } else {
          const left = r.x - PAD;
          const right = r.x + r.w + PAD;
          const side = Math.abs(p.x - left) <= Math.abs(p.x - right) ? left : right;
          if (p.y !== q.y) out.push({ x: side, y: p.y }, { x: side, y: q.y });
          else out.push({ x: side, y: p.y });
        }
      }
    }
    out.push(pts[pts.length - 1]);
    pts = dedupe(out);
  }
  return pts;
}

function routeSimple(a: Pt, b: Pt, da?: Dir, db?: Dir): Pt[] {
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

/** Push a stub endpoint out of every obstacle it sits inside. */
function extendStub(p: Pt, d: Dir | undefined, obstacles: Rect[]): Pt {
  if (!d) return p;
  let q = p;
  for (let i = 0; i < 4; i++) {
    let moved = false;
    for (const r of obstacles) {
      if (q.x > r.x && q.x < r.x + r.w && q.y > r.y && q.y < r.y + r.h) {
        q =
          d === 'up' ? { x: q.x, y: r.y - PAD }
          : d === 'down' ? { x: q.x, y: r.y + r.h + PAD }
          : d === 'left' ? { x: r.x - PAD, y: q.y }
          : { x: r.x + r.w + PAD, y: q.y };
        moved = true;
      }
    }
    if (!moved) break;
  }
  return q;
}

/** All candidate topologies for the terminal pair, nicest first. */
function candidates(a1: Pt, b1: Pt, obstacles: Rect[]): Pt[][] {
  const busXs = [snap10((a1.x + b1.x) / 2)];
  const busYs = [snap10((a1.y + b1.y) / 2)];
  for (const r of obstacles) {
    busXs.push(r.x - PAD * 2, r.x + r.w + PAD * 2);
    busYs.push(r.y - PAD * 2, r.y + r.h + PAD * 2);
  }
  const out: Pt[][] = [];
  const push = (pts: Pt[]): void => {
    out.push(dedupe(pts));
  };
  const mid = [a1, b1];
  for (const xm of busXs) push([a1, { x: xm, y: a1.y }, { x: xm, y: b1.y }, b1]);
  for (const ym of busYs) push([a1, { x: a1.x, y: ym }, { x: b1.x, y: ym }, b1]);
  push([a1, { x: b1.x, y: a1.y }, b1]);
  push([a1, { x: a1.x, y: b1.y }, b1]);
  void mid;
  return out.filter((pts) => pts.length > 2);
}

export function routeWire(a: Pt, b: Pt, da?: Dir, db?: Dir, obstacles: Rect[] = []): Pt[] {
  const base = routeSimple(a, b, da, db);
  if (obstacles.length === 0) return base;
  const stubA = da !== undefined;
  const stubB = db !== undefined;
  if (pathHits(base, obstacles, base.length > 2 ? stubA : false, base.length > 2 ? stubB : false)
      .length === 0)
    return base;

  // build candidates between (possibly extended) stub ends, prefix/suffix them
  const a1 = extendStub(da ? step(a, da) : a, da, obstacles);
  const b1 = extendStub(db ? step(b, db) : db ? b : b, db, obstacles);
  const prefix = a1.x === a.x && a1.y === a.y ? [] : [a1];
  const suffix = b1.x === b.x && b1.y === b.y ? [] : [b1];
  const wrap = (mid: Pt[]): Pt[] => dedupe([a, ...prefix, ...mid.slice(1, -1), ...suffix, b]);

  let best: Pt[] | null = null;
  let bestHits = pathHits(base, obstacles, false, false).length;
  for (const core of candidates(a1, b1, obstacles)) {
    const cand = wrap(core);
    const fixed = detour(cand, obstacles, true, true);
    const hits = pathHits(fixed, obstacles, true, true).length;
    if (hits === 0) return dedupe(fixed);
    if (hits < bestHits) {
      bestHits = hits;
      best = fixed;
    }
  }
  if (best) return dedupe(best);
  return dedupe(detour(base, obstacles, stubA, stubB));
}
