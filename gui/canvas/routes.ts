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

// ---------- A* grid router (last-resort, body-guaranteed) ----------
//
// The candidate router above is cheap and produces pretty paths, but in
// dense layouts no candidate may be clean; instead of pushing a wire through
// a component body we hand the pair to an orthogonal A* on a 10 px node
// grid: bodies are hard cells, other wires are soft (costly) cells, so the
// grid path may cross a wire but never cuts a body.

const BEND = 8; // turning costs eight straight steps
const CROSS = 30; // passing through a prior wire's outline

function astarRoute(
  a: Pt, b: Pt, da: Dir | undefined, db: Dir | undefined,
  hard: Rect[], soft: Rect[],
): Pt[] | null {
  const M = 140;
  let x0 = Math.min(a.x, b.x) - M;
  let y0 = Math.min(a.y, b.y) - M;
  let x1 = Math.max(a.x, b.x) + M;
  let y1 = Math.max(a.y, b.y) + M;
  for (const r of hard) {
    x0 = Math.min(x0, r.x - M); y0 = Math.min(y0, r.y - M);
    x1 = Math.max(x1, r.x + r.w + M); y1 = Math.max(y1, r.y + r.h + M);
  }
  let cell = 10;
  while (((x1 - x0) / cell) * ((y1 - y0) / cell) > 70000) cell *= 2;
  x0 = Math.floor(x0 / cell) * cell;
  y0 = Math.floor(y0 / cell) * cell;
  const W = Math.ceil((x1 - x0) / cell) + 1;
  const H = Math.ceil((y1 - y0) / cell) + 1;
  const N = W * H;
  if (N > 120000) return null;
  const blocked = new Uint8Array(N);
  const hit = (x: number, y: number, r: Rect, pad: number): boolean =>
    x > r.x - pad && x < r.x + r.w + pad && y > r.y - pad && y < r.y + r.h + pad;
  const gx = (x: number): number => Math.round((x - x0) / cell);
  const gy = (y: number): number => Math.round((y - y0) / cell);
  const node = (i: number): Pt => ({ x: x0 + (i % W) * cell, y: y0 + Math.floor(i / W) * cell });
  const inGrid = (nx: number, ny: number): boolean => nx >= 0 && ny >= 0 && nx < W && ny < H;
  for (const r of hard) {
    const nx0 = Math.max(0, gx(r.x - PAD)); const nx1 = Math.min(W - 1, gx(r.x + r.w + PAD));
    const ny0 = Math.max(0, gy(r.y - PAD)); const ny1 = Math.min(H - 1, gy(r.y + r.h + PAD));
    for (let ny = ny0; ny <= ny1; ny++)
      for (let nx = nx0; nx <= nx1; nx++)
        if (hit(x0 + nx * cell, y0 + ny * cell, r, PAD)) blocked[ny * W + nx] = 1;
  }
  const pen = new Float64Array(N);
  if (soft.length) {
    for (let i = 0; i < N; i++) {
      const p = node(i);
      for (const r of soft) if (hit(p.x, p.y, r, 0)) { pen[i] = CROSS; break; }
    }
  }
  const DIRS: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const dirIdx = (d?: Dir): number =>
    d === 'right' ? 0 : d === 'left' ? 1 : d === 'down' ? 2 : d === 'up' ? 3 : -1;
  const start = gy(a.y) * W + gx(a.x);
  const goal = gy(b.y) * W + gx(b.x);
  if (!inGrid(gx(a.x), gy(a.y)) || !inGrid(gx(b.x), gy(b.y))) return null;
  // punch the pin stubs: the wire physically leaves the pin that way, so the
  // stub cell is always passable even when it sits on a body edge
  const punch = (from: number, d: number): number => {
    const p = node(from);
    const n = DIRS[d];
    const nx = gx(p.x + n[0] * cell); const ny = gy(p.y + n[1] * cell);
    if (!inGrid(nx, ny)) return from;
    blocked[ny * W + nx] = 0;
    return ny * W + nx;
  };
  const punchBack = (to: number, d: number): number => {
    // cell on the +d side of `to`; approaching it means moving in -d
    const p = node(to);
    const n = DIRS[d];
    const nx = gx(p.x + n[0] * cell); const ny = gy(p.y + n[1] * cell);
    if (!inGrid(nx, ny)) return to;
    blocked[ny * W + nx] = 0;
    return ny * W + nx;
  };
  let first = start;
  if (da !== undefined) first = punch(start, dirIdx(da));
  let lastBeforeGoal = goal;
  if (db !== undefined) lastBeforeGoal = punch(goal, (dirIdx(db) + 2) % 4);
  // (the cell the wire must come from is the one on the +db side of the pin)
  if (db !== undefined) lastBeforeGoal = punchBack(goal, dirIdx(db));
  blocked[start] = 0;
  blocked[goal] = 0;

  const cost = new Float64Array(N).fill(Infinity);
  const prev = new Int32Array(N).fill(-1);
  const dir = new Int8Array(N).fill(-1);
  // lazy binary heap of (f, idx)
  const heap: number[] = [];
  const fscore = new Map<number, number>();
  const push = (f: number, i: number): void => {
    heap.push(f, i);
    let c = heap.length / 2 - 1;
    while (c > 0) {
      const par = Math.floor((c - 1) / 2);
      if (heap[par * 2] <= heap[c * 2]) break;
      [heap[par * 2], heap[par * 2 + 1], heap[c * 2], heap[c * 2 + 1]] =
        [heap[c * 2], heap[c * 2 + 1], heap[par * 2], heap[par * 2 + 1]];
      c = par;
    }
  };
  const pop = (): number => {
    const top = heap[1];
    const n = heap.length / 2 - 1;
    heap[1] = heap[n * 2 + 1]; heap[0] = heap[n * 2];
    heap.length -= 2;
    let i = 0;
    for (;;) {
      const l = i * 2 + 1; const r = l + 1; let m = i;
      if (l * 2 < heap.length && heap[l * 2] < heap[m * 2]) m = l;
      if (r * 2 < heap.length && heap[r * 2] < heap[m * 2]) m = r;
      if (m === i) break;
      [heap[i * 2], heap[i * 2 + 1], heap[m * 2], heap[m * 2 + 1]] =
        [heap[m * 2], heap[m * 2 + 1], heap[i * 2], heap[i * 2 + 1]];
      i = m;
    }
    return top;
  };
  cost[start] = 0;
  fscore.set(start, 0);
  push(0, start);
  const h = (i: number): number => {
    const p = node(i);
    const q = node(goal);
    return Math.abs(p.x - q.x) + Math.abs(p.y - q.y);
  };
  let found = -1;
  while (heap.length) {
    const cur = pop();
    const curF = fscore.get(cur);
    if (curF === undefined) continue; // stale heap duplicate
    fscore.delete(cur);
    if (cur === goal) { found = cur; break; }
    const cp = node(cur);
    for (let d = 0; d < 4; d++) {
      const nx = gx(cp.x + DIRS[d][0] * cell);
      const ny = gy(cp.y + DIRS[d][1] * cell);
      if (!inGrid(nx, ny)) continue;
      const ni = ny * W + nx;
      if (blocked[ni]) continue;
      if (cur === start && first !== start && d !== dirIdx(da)) continue;
      if (cur === lastBeforeGoal && goal !== lastBeforeGoal && d !== (dirIdx(db) + 2) % 4) continue;
      const g =
        cost[cur] + 1 + pen[ni] +
        (dir[cur] !== -1 && dir[cur] !== d ? BEND : 0);
      if (g < cost[ni]) {
        cost[ni] = g;
        prev[ni] = cur;
        dir[ni] = d;
        const f = g + h(ni);
        fscore.set(ni, f);
        push(f, ni);
      }
    }
  }
  if (found < 0) return null;
  const chain: Pt[] = [];
  for (let i = found; i !== -1; i = prev[i]) chain.push(node(i));
  chain.reverse();
  // drop collinear nodes, attach the exact terminals with orthogonal joins
  const pts: Pt[] = [a];
  const keep = chain.filter((p, i) =>
    i === 0 || i === chain.length - 1 ||
    !((chain[i - 1].x === p.x && p.x === chain[i + 1].x) ||
      (chain[i - 1].y === p.y && p.y === chain[i + 1].y)));
  const join = (from: Pt, to: Pt): Pt | null => {
    if (from.x === to.x || from.y === to.y) return null;
    return keep.length && keep[0].x === to.x ? { x: keep[0].x, y: from.y } : { x: from.x, y: to.y };
  };
  const j1 = join(a, keep[0] ?? b);
  if (j1) pts.push(j1);
  pts.push(...keep);
  const tail = pts[pts.length - 1];
  if (tail.x !== b.x && tail.y !== b.y) pts.push({ x: b.x, y: tail.y });
  pts.push(b);
  return dedupe(pts);
}

/** Public probe: which rects does this path cut through? */
export function pathThroughRects(
  path: Pt[], rects: Rect[], stubA = false, stubB = false,
): Rect[] {
  return pathHits(path, rects, stubA, stubB);
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

// ---------- multi-wire routing ----------

export interface WireRouteInput {
  a: Pt;
  b: Pt;
  da?: Dir;
  db?: Dir;
  obstacles?: Rect[];
  /** component bodies only (no prior wires): what A* must never cross */
  bodies?: Rect[];
}

/** Thin outline rects of a polyline's segments (soft obstacles). */
export function wireRects(path: Pt[], half = 1): Rect[] {
  const out: Rect[] = [];
  for (let i = 0; i + 1 < path.length; i++) {
    const p = path[i];
    const q = path[i + 1];
    out.push({
      x: Math.min(p.x, q.x) - half,
      y: Math.min(p.y, q.y) - half,
      w: Math.abs(q.x - p.x) + half * 2,
      h: Math.abs(q.y - p.y) + half * 2,
    });
  }
  return out;
}

/**
 * Route a batch of wires in document order: every wire avoids the bodies and
 * the already-routed paths of the earlier ones, so drawn wires stop lying on
 * top of each other. Soft obstacles touching a terminal are dropped, letting
 * wires fan out of a shared pin instead of being shoved away from their own
 * stub neighbourhood.
 */
export function routeWiresSequential(inputs: WireRouteInput[]): Pt[][] {
  const paths: Pt[][] = [];
  const prior: Rect[] = [];
  for (const w of inputs) {
    const near = (r: Rect, p: Pt): boolean =>
      p.x >= r.x - STUB && p.x <= r.x + r.w + STUB && p.y >= r.y - STUB && p.y <= r.y + r.h + STUB;
    const obs = (w.obstacles ?? []).concat(prior.filter((r) => !near(r, w.a) && !near(r, w.b)));
    let path = routeWire(w.a, w.b, w.da, w.db, obs);
    const bodies = w.bodies ?? [];
    const through = pathThroughRects(
      path, bodies,
      path.length > 2 && w.da !== undefined,
      path.length > 2 && w.db !== undefined,
    );
    if (bodies.length && through.length > 0) {
      // no clean candidate existed: guarantee body-free via the grid
      const g = astarRoute(w.a, w.b, w.da, w.db, bodies, prior);
      if (g) path = g;
    }
    paths.push(path);
    prior.push(...wireRects(path));
  }
  return paths;
}
