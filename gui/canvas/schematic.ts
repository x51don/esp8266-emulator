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
import type { Pt, Rect } from './viewport';

export type Rot = 0 | 90 | 180 | 270;

export interface PlacedComponent {
  id: string;
  type: string; // 'board' | 'led' | 'resistor' | 'button' | ...
  x: number;
  y: number;
  rot: Rot;
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
    case 'board': {
      const board = getBoard(String(params.board ?? 'wemos-d1-mini'));
      const PITCH = 20;
      const RIGHT_X = 160;
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

export class Schematic {
  components = new Map<string, PlacedComponent>();
  wires = new Map<string, WireSeg>();
  private seq: Record<string, number> = {};
  private wireSeq = 0;

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
  }

  move(id: string, x: number, y: number): void {
    const c = this.components.get(id);
    if (c) {
      c.x = x;
      c.y = y;
    }
  }

  rotate(id: string): void {
    const c = this.components.get(id);
    if (c) c.rot = (((c.rot + 90) % 360) as Rot);
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
    return seg;
  }

  removeWire(id: string): void {
    this.wires.delete(id);
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
    const pin = footprintFor(c.type, c.params).pins.find((p) => p.name === ref.pin);
    if (!pin) throw new Error(`component '${ref.comp}' has no pin '${ref.pin}'`);
    const r = rotatePoint({ x: pin.x, y: pin.y }, c.rot);
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
    const doc = JSON.parse(text) as DocShape;
    const s = new Schematic();
    for (const c of doc.comps) s.components.set(c.id, c);
    for (const w of doc.wires) s.wires.set(w.id, w);
    s.seq = doc.seq ?? {};
    s.wireSeq = doc.wireSeq ?? 0;
    return s;
  }
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
