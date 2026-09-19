/**
 * Schematic: the document model of the drawn circuit. Pure data + geometry
 * (no DOM, no canvas): what the renderer draws and what the interaction
 * layer mutates. `syncNetlist` projects it into the electrical Netlist that
 * the machine solves, so the document is always the single source of truth.
 *
 * Conventions:
 * - 1 world unit = 1 fine grid; components snap to 10.
 * - Every component has an origin pin; rotation turns the footprint around it
 *   (clockwise on a y-down screen).
 * - Exactly one 'board' component represents the ESP8266 board; on the
 *   netlist it is always the 'mcu' component, whatever its document id is.
 */

import { getBoard } from '../../core/boards';
import type { Netlist } from '../../peripherals/netlist';
import { routeWiresSequential, type Dir, type WireRouteInput } from './routes';
import type { Pt, Rect } from './viewport';

export type Rot = 0 | 90 | 180 | 270;

export interface PlacedComponent {
  id: string;
  type: string; // 'board' | 'led' | 'resistor' | 'button' | ...
  x: number;
  y: number;
  rot: Rot;
  /** mirror the symbol horizontally about the body centre (before rot) */
  flip?: boolean;
  params: Record<string, unknown>;
}

export interface TerminalRef {
  comp: string;
  pin: string;
}

export interface WireSeg {
  id: string;
  a: TerminalRef;
  b: TerminalRef;
  /** manual waypoints (world) set by dragging a segment; auto-route off */
  custom?: Pt[];
  /** F14: explicit wire colour (hex); undefined = auto by net role */
  color?: string;
}

/** Where two wire paths cross; `w2` is drawn on top (gets the hop glyph). */
export interface Crossing {
  x: number;
  y: number;
  w1: string;
  w2: string;
  /** true when one path's endpoint touches the other's interior (T-junction) */
  endpoint: boolean;
}

export interface Footprint {
  pins: Array<{ name: string; x: number; y: number }>;
  body: Rect; // local (unrotated) bounding box of the symbol
}

/** Rotate a local offset clockwise (y-down screen). */
export function rotatePoint(p: Pt, rot: Rot): Pt {
  const z = (v: number): number => (v === 0 ? 0 : v); // kill -0
  switch (rot) {
    case 90: return { x: z(-p.y), y: p.x };
    case 180: return { x: z(-p.x), y: z(-p.y) };
    case 270: return { x: p.y, y: z(-p.x) };
    default: return { x: p.x, y: p.y };
  }
}

const PIN_GAP = 20;

/** Board footprint geometry (shared with the example presets, audit H1). */
export const BOARD_PITCH = 20;
export const BOARD_RIGHT_X = 160;

export function footprintFor(type: string, params: Record<string, unknown>): Footprint {
  switch (type) {
    case 'led':
      return {
        pins: [{ name: 'a', x: 0, y: 0 }, { name: 'k', x: PIN_GAP, y: 0 }],
        body: { x: -6, y: -14, w: PIN_GAP + 12, h: 28 },
      };
    case 'resistor':
      return {
        pins: [{ name: 'p1', x: 0, y: 0 }, { name: 'p2', x: PIN_GAP, y: 0 }],
        body: { x: 2, y: -8, w: PIN_GAP - 4, h: 16 },
      };
    case 'button':
      return {
        pins: [{ name: 'p1', x: 0, y: 0 }, { name: 'p2', x: PIN_GAP, y: 0 }],
        body: { x: -4, y: -12, w: PIN_GAP + 8, h: 24 },
      };
    case 'buzzer':
      return {
        pins: [{ name: '+', x: 0, y: 0 }, { name: '-', x: PIN_GAP, y: 0 }],
        body: { x: -2, y: -14, w: PIN_GAP + 4, h: 28 },
      };
    case 'battery':
      return {
        pins: [{ name: '+', x: 0, y: 0 }, { name: '-', x: PIN_GAP, y: 0 }],
        body: { x: -6, y: -16, w: PIN_GAP + 12, h: 32 },
      };
    case 'pot':
      return {
        pins: [{ name: 'p1', x: 0, y: 0 }, { name: 'w', x: 10, y: -20 }, { name: 'p2', x: 20, y: 0 }],
        body: { x: -6, y: -8, w: 32, h: 16 },
      };
    case 'ldr':
      return {
        pins: [{ name: 'p1', x: 0, y: 0 }, { name: 'p2', x: PIN_GAP, y: 0 }],
        body: { x: -4, y: -12, w: PIN_GAP + 8, h: 24 },
      };
    case 'cap':
      return {
        pins: [{ name: 'p1', x: 0, y: 0 }, { name: 'p2', x: PIN_GAP, y: 0 }],
        body: { x: -8, y: -12, w: PIN_GAP + 16, h: 24 },
      };
    case 'dht':
      return {
        pins: [{ name: 'vcc', x: 0, y: 0 }, { name: 'data', x: 0, y: PIN_GAP }, { name: 'gnd', x: 0, y: 2 * PIN_GAP }],
        body: { x: -14, y: -14, w: 84, h: 74 },
      };
    case 'servo':
      return {
        pins: [{ name: 'sig', x: 0, y: 0 }, { name: 'vcc', x: 0, y: PIN_GAP }, { name: 'gnd', x: 0, y: 2 * PIN_GAP }],
        body: { x: -14, y: -14, w: 94, h: 74 },
      };
    case 'hcsr':
      return {
        pins: [
          { name: 'vcc', x: 0, y: 0 }, { name: 'trig', x: 0, y: PIN_GAP },
          { name: 'echo', x: 0, y: 2 * PIN_GAP }, { name: 'gnd', x: 0, y: 3 * PIN_GAP },
        ],
        body: { x: -14, y: -14, w: 94, h: 94 },
      };
    case 'relay':
      return {
        pins: [
          { name: 'coilp', x: 0, y: 0 }, { name: 'coiln', x: 0, y: PIN_GAP },
          { name: 'sw', x: 80, y: -20 }, { name: 'no', x: 100, y: 20 }, { name: 'nc', x: 100, y: 60 },
        ],
        body: { x: -14, y: -30, w: 134, h: 110 },
      };
    case 'oled':
      return {
        pins: [
          { name: 'vcc', x: 0, y: 0 }, { name: 'gnd', x: 0, y: PIN_GAP },
          { name: 'sda', x: 0, y: 2 * PIN_GAP }, { name: 'scl', x: 0, y: 3 * PIN_GAP },
        ],
        body: { x: -14, y: -14, w: 158, h: 118 },
      };
    case 'neopixel':
      return {
        pins: [{ name: 'din', x: 0, y: 0 }, { name: 'vcc', x: 0, y: PIN_GAP }, { name: 'gnd', x: 0, y: 2 * PIN_GAP }],
        body: { x: -14, y: -14, w: 158, h: 62 },
      };
    case 'board': {
      const board = getBoard(String(params.board ?? 'wemos-d1-mini'));
      const PITCH = BOARD_PITCH;
      const RIGHT_X = BOARD_RIGHT_X;
      const pins = board.rails.map((r) => ({
        name: r.name,
        x: r.side === 'left' ? 0 : RIGHT_X,
        y: r.row * PITCH,
      }));
      const rows = board.rails.reduce((m, r) => Math.max(m, r.row), 0);
      return {
        pins,
        body: { x: -16, y: -16, w: RIGHT_X + 32, h: rows * PITCH + 32 },
      };
    }
    default:
      throw new Error(`no footprint for component type '${type}'`);
  }
}

interface DocShape {
  comps: PlacedComponent[];
  wires: WireSeg[];
  seq: Record<string, number>;
  wireSeq: number;
}

/**
 * F14 net roles driving the default wire colours. Classification is purely
 * topological (which pins the copper touches), so it works with no solver
 * run: power = a positive rail/battery +, gnd = any ground pin, signal =
 * everything else. A net that is both power and gnd is a short; the solver
 * faults it and we paint it power-red.
 */
export type NetRole = 'power' | 'gnd' | 'signal';

/** Electronics convention, tuned for the dark theme: power red, GND white. */
export const WIRE_ROLE_COLORS: Record<NetRole, string> = {
  power: '#ff5252',
  gnd: '#e8eef5',
  signal: '#4ade80',
};

const GND_PIN = /^(gnd\d*|g|vss|vee|-)$/i;
const PWR_PIN = /^(vcc\d*|vdd|vin|vs|vu|vbat|5v|3v3|3\.3v|\+)$/i;

function pinRole(ref: TerminalRef): NetRole | null {
  if (PWR_PIN.test(ref.pin)) return 'power';
  if (GND_PIN.test(ref.pin)) return 'gnd';
  return null;
}

/**
 * The role of the wire's whole net: wires merge nets through shared pins,
 * so the classification floods across every wire touching the same terminal
 * (but never through components - a resistor separates two nets).
 */
export function netRoleOf(sc: Schematic, wireId: string): NetRole {
  return sc.netRoles().get(wireId) ?? 'signal';
}

export class Schematic {
  components = new Map<string, PlacedComponent>();
  wires = new Map<string, WireSeg>();
  private seq: Record<string, number> = {};
  private wireSeq = 0;
  private routesCache: Map<string, Pt[]> | null = null;
  private crossingsCache: Crossing[] | null = null;
  private roleCache: Map<string, NetRole> | null = null;
  private dragging = false;

  /** Public change counter (P1.3): the canvas frame loop skips renderScene
   *  while this, the viewport and the interaction state are unchanged. */
  version = 0;

  /** Invalidate the derived wire-route cache; every mutator calls this.
   *  During a drag session (beginDrag..endDrag) invalidation is deferred so
   *  the expensive route recompute runs once on commit, not per pointermove. */
  private touch(): void {
    this.version++;
    if (this.dragging) return;
    this.routesCache = null;
    this.crossingsCache = null;
    this.roleCache = null;
  }

  /** Freeze derived caches for a drag session (P1.2 cheap drag). */
  beginDrag(): void {
    this.dragging = true;
  }

  /** Commit a drag (or any change): rebuild routes/crossings on next read. */
  endDrag(): void {
    this.dragging = false;
    this.touch();
  }

  add(type: string, x: number, y: number, params: Record<string, unknown> = {}, id?: string): PlacedComponent {
    if (id === undefined) {
      this.seq[type] = (this.seq[type] ?? 0) + 1;
      id = `${type}-${this.seq[type]}`;
    } else if (this.components.has(id)) {
      throw new Error(`component id '${id}' already exists`);
    }
    this.seq[type] = Math.max(this.seq[type] ?? 0, numericSuffix(id, type));
    const comp: PlacedComponent = { id, type, x, y, rot: 0, params };
    footprintFor(type, params); // validate type early
    this.components.set(id, comp);
    this.touch();
    return comp;
  }

  addBoard(boardId: string, x: number, y: number, id = 'board'): PlacedComponent {
    getBoard(boardId); // throws for unknown boards
    return this.add('board', x, y, { board: boardId }, id);
  }

  component(id: string): PlacedComponent | undefined {
    return this.components.get(id);
  }

  boardComponent(): PlacedComponent | undefined {
    for (const c of this.components.values()) if (c.type === 'board') return c;
    return undefined;
  }

  remove(id: string): void {
    if (!this.components.delete(id)) return;
    for (const [wid, w] of this.wires) {
      if (w.a.comp === id || w.b.comp === id) this.wires.delete(wid);
    }
    this.touch();
  }

  move(id: string, x: number, y: number): void {
    const c = this.components.get(id);
    if (c) {
      c.x = x;
      c.y = y;
    }
    this.touch();
  }

  rotate(id: string): void {
    const c = this.components.get(id);
    if (c) c.rot = (((c.rot + 90) % 360) as Rot);
    this.touch();
  }

  /** Toggle the horizontal mirror of a component. */
  flip(id: string): void {
    const c = this.components.get(id);
    if (c) c.flip = !c.flip;
    this.touch();
  }

  /** Live-tune a parameter (pot ratio, sensor values, dialog edits).
   *  Parameters feed the footprint (board model, strip size), so the derived
   *  route/crossing caches must be invalidated unconditionally. */
  setParam(id: string, key: string, value: unknown): void {
    const c = this.components.get(id);
    if (!c) return;
    c.params[key] = value;
    this.touch();
  }

  /** Change the placed MCU board model; validates the id and rebuilds pins. */
  setBoard(boardId: string): void {
    getBoard(boardId); // unknown board -> throw before mutating
    const c = this.boardComponent();
    if (!c) throw new Error('no board component on the schematic');
    c.params.board = boardId;
    this.touch();
  }

  wire(a: TerminalRef, b: TerminalRef): WireSeg {
    if (a.comp === b.comp && a.pin === b.pin) {
      throw new Error('a wire cannot connect a terminal to itself');
    }
    for (const w of this.wires.values()) {
      const samePair =
        (eq(w.a, a) && eq(w.b, b)) || (eq(w.a, b) && eq(w.b, a));
      if (samePair) throw new Error(`wire between ${t(a)} and ${t(b)} already exists`);
    }
    const id = `w${++this.wireSeq}`;
    const seg: WireSeg = { id, a, b };
    this.wires.set(id, seg);
    this.touch();
    return seg;
  }

  removeWire(id: string): void {
    this.wires.delete(id);
    this.touch();
  }

  wireOf(id: string): WireSeg | undefined {
    return this.wires.get(id);
  }

  /** F14: paint one wire; `undefined` returns it to the automatic colour. */
  setWireColor(id: string, color: string | undefined): void {
    const w = this.wires.get(id);
    if (!w) return;
    if (color === undefined) delete w.color;
    else w.color = color;
    this.version++; // colour is not a topology change; keep routes cached
  }

  /** Role of every wire, derived once per change (F14). */
  netRoles(): Map<string, NetRole> {
    if (this.roleCache) return this.roleCache;
    // net id per terminal: DSU over wire endpoints
    const parent = new Map<string, string>(); // missing entry == its own root
    const find = (k: string): string => {
      let root = k;
      for (;;) {
        const p = parent.get(root);
        if (p === undefined || p === root) break;
        root = p;
      }
      let cur = k;
      for (;;) {
        const p = parent.get(cur);
        if (p === undefined || p === root) break;
        parent.set(cur, root);
        cur = p;
      }
      return root;
    };
    const key = (c: TerminalRef): string => `${c.comp}.${c.pin}`;
    for (const w of this.wires.values()) {
      const ra = find(key(w.a));
      const rb = find(key(w.b));
      if (ra !== rb) parent.set(ra, rb);
    }
    // best (highest-ranked) role seen per net
    const rank: Record<NetRole, number> = { signal: 0, gnd: 1, power: 2 };
    const netRole = new Map<string, NetRole>();
    const bump = (k: string, r: NetRole): void => {
      const root = find(k);
      const cur = netRole.get(root) ?? 'signal';
      if (rank[r] > rank[cur]) netRole.set(root, r);
    };
    for (const c of this.components.values()) {
      for (const p of footprintFor(c.type, c.params).pins) {
        const role = pinRole({ comp: c.id, pin: p.name });
        if (role) bump(`${c.id}.${p.name}`, role);
      }
    }
    const out = new Map<string, NetRole>();
    for (const w of this.wires.values())
      out.set(w.id, netRole.get(find(key(w.a))) ?? 'signal');
    this.roleCache = out;
    return out;
  }

  /** All pins of every component with their world positions (hit-testing). */
  allPinWorlds(): Array<TerminalRef & Pt> {
    const out: Array<TerminalRef & Pt> = [];
    for (const c of this.components.values()) {
      for (const p of footprintFor(c.type, c.params).pins) {
        const w = this.pinWorld({ comp: c.id, pin: p.name });
        out.push({ comp: c.id, pin: p.name, x: w.x, y: w.y });
      }
    }
    return out;
  }

  pinWorld(ref: TerminalRef): Pt {
    const c = this.components.get(ref.comp);
    if (!c) throw new Error(`no component '${ref.comp}'`);
    const fp = footprintFor(c.type, c.params);
    const pin = fp.pins.find((p) => p.name === ref.pin);
    if (!pin) throw new Error(`component '${ref.comp}' has no pin '${ref.pin}'`);
    const lp = c.flip
      ? { x: 2 * fp.body.x + fp.body.w - pin.x, y: pin.y }
      : { x: pin.x, y: pin.y };
    const r = rotatePoint(lp, c.rot);
    return { x: c.x + r.x, y: c.y + r.y };
  }

  /** Ids of components whose body overlaps the world rect (selection). */
  componentsIn(rect: Rect): string[] {
    const out: string[] = [];
    for (const c of this.components.values()) {
      const b = this.bodyRect(c);
      if (b.x < rect.x + rect.w && rect.x < b.x + b.w && b.y < rect.y + rect.h && rect.y < b.y + b.h) {
        out.push(c.id);
      }
    }
    return out;
  }

  bodyRect(c: PlacedComponent): Rect {
    const fp = footprintFor(c.type, c.params);
    // rotate the 4 body corners; axis-aligned hull is enough for picking
    const corners = [
      { x: fp.body.x, y: fp.body.y },
      { x: fp.body.x + fp.body.w, y: fp.body.y },
      { x: fp.body.x, y: fp.body.y + fp.body.h },
      { x: fp.body.x + fp.body.w, y: fp.body.y + fp.body.h },
    ].map((p) => rotatePoint(p, c.rot));
    const xs = corners.map((p) => p.x);
    const ys = corners.map((p) => p.y);
    const x0 = Math.min(...xs) + c.x;
    const y0 = Math.min(...ys) + c.y;
    return { x: x0, y: y0, w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  }

  /** Body rects of all components except the given ids (wire-routing obstacles). */
  bodyRects(exclude: string[] = []): Rect[] {
    const skip = new Set(exclude);
    const out: Rect[] = [];
    for (const c of this.components.values())
      if (!skip.has(c.id)) out.push(this.bodyRect(c));
    return out;
  }

  /**
   * Routing obstacles for a wire between two terminals: every body except
   * the endpoints' OWN small bodies. Big endpoint bodies (the board) stay -
   * a wire leaving a board pin must still route around the board.
   */
  wireObstacles(a: TerminalRef, b: TerminalRef): Rect[] {
    const out: Rect[] = [];
    for (const c of this.components.values()) {
      const rect = this.bodyRect(c);
      if ((c.id === a.comp || c.id === b.comp) && rect.w <= 44 && rect.h <= 44) continue;
      out.push(rect);
    }
    return out;
  }

  /**
   * Routed polylines for every wire (id -> path), derived state cached until
   * the document changes. Wires route in document order around bodies and
   * each other, so the renderer, the hit-testing and automation all share
   * exactly one truth about where a wire is drawn.
   */
  wireRoutes(): Map<string, Pt[]> {
    if (this.routesCache) return this.routesCache;
    const ids: string[] = [];
    const inputs: WireRouteInput[] = [];
    const map0 = new Map<string, Pt[]>();
    // body rects once per rebuild (P1.2): per-wire obstacle lists are
    // filtered views of this pool instead of fresh footprintFor walks.
    const pool: Array<{ id: string; rect: Rect }> = [];
    for (const c of this.components.values()) pool.push({ id: c.id, rect: this.bodyRect(c) });
    for (const w of this.wires.values()) {
      let a: Pt;
      let b: Pt;
      try {
        a = this.pinWorld(w.a);
        b = this.pinWorld(w.b);
      } catch {
        continue; // dangling reference mid-edit: skip until fixed
      }
      if (w.custom && w.custom.length) map0.set(w.id, manualPath(a, w.custom, b));
      ids.push(w.id);
      if (w.custom && w.custom.length) continue;
      const bodies = pool
        .filter(({ id, rect }) =>
          !((id === w.a.comp || id === w.b.comp) && rect.w <= 44 && rect.h <= 44))
        .map(({ rect }) => rect);
      inputs.push({
        a, b,
        da: pinExitDir(this, w.a, a),
        db: pinExitDir(this, w.b, b),
        obstacles: bodies,
        bodies,
      });
    }
    // single Map in document order (crossing glyphs rely on the draw order)
    const map = new Map<string, Pt[]>();
    for (const id of ids) map.set(id, map0.get(id) ?? []);
    routeWiresSequential(inputs).forEach((path, i) => map.set(ids[i], path));
    this.routesCache = map;
    this.crossingsCache = findCrossings(map);
    return map;
  }

  /** Crossings between every pair of routed wires (valid after wireRoutes). */
  wireCrossings(): Crossing[] {
    this.wireRoutes();
    return this.crossingsCache ?? [];
  }

  /** Pin a manual route on a wire (interior waypoints, world coords). */
  setWirePath(id: string, pts: Pt[]): void {
    const w = this.wires.get(id);
    if (!w) return;
    w.custom = pts.map((p) => ({ x: p.x, y: p.y }));
    this.touch();
  }

  clearWirePath(id: string): void {
    const w = this.wires.get(id);
    if (!w || w.custom === undefined) return;
    delete w.custom;
    this.touch();
  }

  bounds(): Rect {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const c of this.components.values()) {
      const b = this.bodyRect(c);
      x0 = Math.min(x0, b.x);
      y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.w);
      y1 = Math.max(y1, b.y + b.h);
    }
    if (!Number.isFinite(x0)) return { x: 0, y: 0, w: 0, h: 0 };
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  // ---------- netlist projection ----------

  /** Netlist id for a document component: the board is always 'mcu'. */
  private nlId(compId: string): string {
    return this.components.get(compId)?.type === 'board' ? 'mcu' : compId;
  }

  private nlTerminal(ref: TerminalRef): string {
    return `${this.nlId(ref.comp)}.${ref.pin}`;
  }

  /** Rebuild the given netlist from this document (idempotent). */
  syncNetlist(nl: Netlist): void {
    nl.clear();
    for (const c of this.components.values()) {
      if (c.type === 'board') {
        const board = getBoard(String(c.params.board));
        nl.addComponent('mcu', 'mcu', { board: board.id, pins: board.rails.map((r) => r.name) });
      } else {
        nl.addComponent(c.id, c.type, { ...c.params });
      }
    }
    for (const w of this.wires.values()) {
      nl.addWire(this.nlTerminal(w.a), this.nlTerminal(w.b));
    }
  }

  // ---------- persistence ----------

  toJSON(): string {
    const doc: DocShape = {
      comps: [...this.components.values()],
      wires: [...this.wires.values()],
      seq: this.seq,
      wireSeq: this.wireSeq,
    };
    return JSON.stringify(doc);
  }

  static fromJSON(text: string): Schematic {
    const raw: unknown = JSON.parse(text);
    const s = new Schematic();
    if (!isDocShape(raw)) throw new Error('invalid schematic document');
    for (const c of raw.comps) {
      if (!isComp(c)) throw new Error('invalid schematic document: malformed component');
      if (c.type === 'board') getBoard(String(c.params.board)); // unknown board id -> throw
      else {
        try {
          footprintFor(c.type, c.params);
        } catch {
          throw new Error(`unknown component type '${c.type}'`);
        }
      }
      s.components.set(c.id, c);
    }
    for (const w of raw.wires) {
      if (!isWire(w)) throw new Error('invalid schematic document: malformed wire');
      s.wires.set(w.id, w);
    }
    s.seq = raw.seq ?? {};
    s.wireSeq = typeof raw.wireSeq === 'number' ? raw.wireSeq : 0;
    return s;
  }
}

// ---- document shape guards: bad imports die at load, not inside rAF render ----

/** hex colour only - no `url()` or other CSS tricks in saved documents */
export const WIRE_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isRot = (v: unknown): v is Rot => v === 0 || v === 90 || v === 180 || v === 270;

function isDocShape(v: unknown): v is DocShape {
  const d = v as DocShape;
  return isObj(v) && Array.isArray(d.comps) && Array.isArray(d.wires);
}

function isComp(v: unknown): v is PlacedComponent {
  if (!isObj(v)) return false;
  return (
    typeof v.id === 'string' &&
    typeof v.type === 'string' &&
    isNum(v.x) &&
    isNum(v.y) &&
    isRot(v.rot) &&
    isObj(v.params) &&
    (v.flip === undefined || typeof v.flip === 'boolean')
  );
}

function isTerminalRef(v: unknown): v is TerminalRef {
  return isObj(v) && typeof v.comp === 'string' && typeof v.pin === 'string';
}

function isWire(v: unknown): v is WireSeg {
  if (!isObj(v)) return false;
  if (typeof v.id !== 'string' || !isTerminalRef(v.a) || !isTerminalRef(v.b)) return false;
  if (v.color !== undefined && !WIRE_COLOR_RE.test(String(v.color)))
    throw new Error(`invalid wire colour '${String(v.color).slice(0, 24)}'`);
  if (v.custom === undefined) return true;
  return (
    Array.isArray(v.custom) &&
    v.custom.every((p) => isObj(p) && isNum(p.x) && isNum(p.y))
  );
}

/** The direction a wire leaves a pin: straight away from the body centre. */
export function pinExitDir(sc: Schematic, ref: TerminalRef, pos: Pt): Dir {
  const c = sc.component(ref.comp);
  if (!c) return 'right';
  const b = sc.bodyRect(c);
  const dx = pos.x - (b.x + b.w / 2);
  const dy = pos.y - (b.y + b.h / 2);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'down' : 'up';
}

function eq(a: TerminalRef, b: TerminalRef): boolean {
  return a.comp === b.comp && a.pin === b.pin;
}

function t(r: TerminalRef): string {
  return `${r.comp}.${r.pin}`;
}

/** Keep the auto-id counter ahead of manually-named ids like 'led-7'. */
function numericSuffix(id: string, type: string): number {
  const m = id.match(new RegExp(`^${type}-(\\d+)$`));
  return m ? Number(m[1]) : 0;
}

/** Chain a -> waypoints -> b with orthogonal elbow joins. */
export function manualPath(a: Pt, pts: Pt[], b: Pt): Pt[] {
  const chain = [a, ...pts, b];
  const out: Pt[] = [chain[0]];
  for (let i = 1; i < chain.length; i++) {
    const p = out[out.length - 1];
    const q = chain[i];
    if (p.x !== q.x && p.y !== q.y) out.push({ x: q.x, y: p.y });
    if (q.x !== out[out.length - 1].x || q.y !== out[out.length - 1].y) out.push(q);
  }
  return out;
}

function segCross(p: Pt, q: Pt, r: Pt, t: Pt): Pt | null {
  const pqV = p.x === q.x;
  const rsV = r.x === t.x;
  if (pqV === rsV) return null; // parallel or diagonal
  if (pqV) [p, q, r, t] = [r, t, p, q]; // keep p..q horizontal
  // now p..q horizontal, r..t vertical
  const x = r.x;
  const y = p.y;
  const M = 0.5;
  if (Math.min(p.x, q.x) + M < x && x < Math.max(p.x, q.x) - M &&
      Math.min(r.y, t.y) + M < y && y < Math.max(r.y, t.y) - M)
    return { x, y };
  return null;
}

function nearVertex(path: Pt[], p: Pt): boolean {
  return path.some((v) => Math.abs(v.x - p.x) < 2 && Math.abs(v.y - p.y) < 2);
}

/** Perpendicular crossings of wire paths; endpoints touching count too. */
export function findCrossings(routes: Map<string, Pt[]>): Crossing[] {
  const ids = [...routes.keys()];
  const out: Crossing[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const pa = routes.get(ids[i])!;
      const pb = routes.get(ids[j])!;
      for (let ai = 0; ai + 1 < pa.length; ai++) {
        for (let bi = 0; bi + 1 < pb.length; bi++) {
          const p = segCross(pa[ai], pa[ai + 1], pb[bi], pb[bi + 1]);
          if (!p) continue;
          if (nearVertex(pa, p) || nearVertex(pb, p)) continue;
          out.push({ x: p.x, y: p.y, w1: ids[i], w2: ids[j], endpoint: false });
        }
      }
      // T-junctions: endpoint of one lying strictly inside the other.
      // A vertex whose own path runs along the touched segment merely overlaps
      // it (two wires sharing a row); that is one drawn line, not a junction.
      const tTouch = (path: Pt[], other: Pt[], pathId: string, otherId: string): void => {
        for (let k = 0; k < path.length; k++) {
          const e = path[k];
          if (nearVertex(other, e)) continue;
          const adjH =
            (k > 0 && path[k - 1].y === e.y) || (k + 1 < path.length && path[k + 1].y === e.y);
          const adjV =
            (k > 0 && path[k - 1].x === e.x) || (k + 1 < path.length && path[k + 1].x === e.x);
          for (let m = 0; m + 1 < other.length; m++) {
            const r = other[m];
            const t = other[m + 1];
            if (!adjV && r.x === t.x && e.x === r.x && Math.min(r.y, t.y) < e.y && e.y < Math.max(r.y, t.y))
              out.push({ x: e.x, y: e.y, w1: otherId, w2: pathId, endpoint: true });
            if (!adjH && r.y === t.y && e.y === r.y && Math.min(r.x, t.x) < e.x && e.x < Math.max(r.x, t.x))
              out.push({ x: e.x, y: e.y, w1: otherId, w2: pathId, endpoint: true });
          }
        }
      };
      tTouch(pa, pb, ids[i], ids[j]);
      tTouch(pb, pa, ids[j], ids[i]);
    }
  }
  return out;
}
