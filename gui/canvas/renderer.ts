/**
 * Canvas renderer. One entry point: renderScene(ctx, scene). Reads only,
 * never mutates the scene. Coordinates: convert world -> screen through the
 * viewport for every vertex; line widths stay crisp in screen space.
 */

import type { ResolveResult } from '../../peripherals/netlist';
import { footprintFor, type PlacedComponent, type Schematic, type TerminalRef } from './schematic';
import { gridStep, visibleCells } from './grid';
import { routeWire, type Dir } from './routes';
import type { Pt, Viewport } from './viewport';

export interface DragWireState {
  from: TerminalRef;
  cursor: Pt;
}

export interface RenderScene {
  schematic: Schematic;
  viewport: Viewport;
  width: number; // css pixels
  height: number;
  circuit: ResolveResult | null; // null while the machine is not running
  running: boolean;
  selection: ReadonlySet<string>;
  hoverPin: TerminalRef | null;
  dragWire: DragWireState | null;
}

const C = {
  bg: '#0d1117',
  gridMinor: '#161d27',
  gridMajor: '#1d2735',
  wire: '#5b6b7f',
  wireHot: '#f5c518',
  wireFault: '#ff5252',
  body: '#232c3a',
  bodyEdge: '#38455a',
  board: '#14352f',
  boardEdge: '#1f6f5c',
  silk: '#8fb8ad',
  pin: '#7fd4c1',
  pinHot: '#ffffff',
  text: '#c9d4e3',
  select: '#4da3ff',
  ledOff: '#3a2a2a',
};

export function renderScene(ctx: CanvasRenderingContext2D, s: RenderScene): void {
  const { width, height } = s;
  ctx.save();
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, width, height);

  drawGrid(ctx, s);

  const pins = pinMap(s.schematic);
  // layer order: board bodies, wires (over the board, under small parts),
  // parts, then the in-progress wire
  for (const c of s.schematic.components.values()) if (c.type === 'board') drawComponent(ctx, s, c);
  drawWires(ctx, s, pins);
  for (const c of s.schematic.components.values()) if (c.type !== 'board') drawComponent(ctx, s, c);
  for (const c of s.schematic.components.values()) if (c.type === 'board') drawBoardPins(ctx, s, c);
  drawDragWire(ctx, s, pins);

  ctx.restore();
}

// ---------- helpers ----------

function pinMap(sc: Schematic): Map<string, Pt> {
  const m = new Map<string, Pt>();
  for (const p of sc.allPinWorlds()) m.set(`${p.comp}.${p.pin}`, p);
  return m;
}

/** Wire exit direction: away from the component body center. */
function pinDir(sc: Schematic, ref: TerminalRef, pos: Pt): Dir {
  const c = sc.component(ref.comp);
  if (!c) return 'right';
  const b = sc.bodyRect(c);
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const dx = pos.x - cx;
  const dy = pos.y - cy;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'down' : 'up';
}

// ---------- layers ----------

function drawGrid(ctx: CanvasRenderingContext2D, s: RenderScene): void {
  const step = gridStep(s.viewport.zoom);
  const tl = s.viewport.screenToWorld(0, 0);
  const br = s.viewport.screenToWorld(s.width, s.height);
  const b = visibleCells({ x0: tl.x, y0: tl.y, x1: br.x, y1: br.y }, step);
  const major = step * 5;
  ctx.lineWidth = 1;
  for (let x = b.x0; x <= b.x1; x += step) {
    const isMajor = Math.round(x / major) * major === x;
    ctx.strokeStyle = isMajor ? C.gridMajor : C.gridMinor;
    const sx = Math.round(s.viewport.worldToScreen(x, 0).x) + 0.5;
    ctx.beginPath();
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, s.height);
    ctx.stroke();
  }
  for (let y = b.y0; y <= b.y1; y += step) {
    const isMajor = Math.round(y / major) * major === y;
    ctx.strokeStyle = isMajor ? C.gridMajor : C.gridMinor;
    const sy = Math.round(s.viewport.worldToScreen(0, y).y) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, sy);
    ctx.lineTo(s.width, sy);
    ctx.stroke();
  }
}

function netLevel(s: RenderScene, terminal: string): number | null {
  if (!s.circuit) return null;
  const net = s.circuit.netOf.get(terminal);
  if (net === undefined) return null;
  const v = s.circuit.netVoltage.get(net);
  return v === undefined ? null : v;
}

function netFaulted(s: RenderScene, terminal: string): boolean {
  if (!s.circuit) return false;
  const net = s.circuit.netOf.get(terminal);
  return net !== undefined && s.circuit.faults.some((f) => f.net === net);
}

function drawWires(ctx: CanvasRenderingContext2D, s: RenderScene, pins: Map<string, Pt>): void {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const w of s.schematic.wires.values()) {
    const a = pins.get(`${w.a.comp}.${w.a.pin}`);
    const b = pins.get(`${w.b.comp}.${w.b.pin}`);
    if (!a || !b) continue; // component deleted mid-frame
    const ta = `${w.a.comp}.${w.a.pin}`;
    const tb = `${w.b.comp}.${w.b.pin}`;
    const hot =
      (netLevel(s, ta) ?? 0) > 1.65 || (netLevel(s, tb) ?? 0) > 1.65;
    ctx.strokeStyle = netFaulted(s, ta) || netFaulted(s, tb)
      ? C.wireFault
      : hot ? C.wireHot : C.wire;
    ctx.lineWidth = 2;
    const path = routeWire(a, b, pinDir(s.schematic, w.a, a), pinDir(s.schematic, w.b, b));
    strokeWorld(ctx, s, path);
  }
}

function drawDragWire(ctx: CanvasRenderingContext2D, s: RenderScene, pins: Map<string, Pt>): void {
  if (!s.dragWire) return;
  const a = pins.get(`${s.dragWire.from.comp}.${s.dragWire.from.pin}`);
  if (!a) return;
  ctx.strokeStyle = C.select;
  ctx.setLineDash([6, 4]);
  ctx.lineWidth = 2;
  strokeWorld(ctx, s, routeWire(a, s.dragWire.cursor, pinDir(s.schematic, s.dragWire.from, a)));
  ctx.setLineDash([]);
}

function drawComponent(ctx: CanvasRenderingContext2D, s: RenderScene, c: PlacedComponent): void {
  const fp = footprintFor(c.type, c.params);
  const body = s.schematic.bodyRect(c);
  const p0 = s.viewport.worldToScreen(body.x, body.y);
  const bw = body.w * s.viewport.zoom;
  const bh = body.h * s.viewport.zoom;

  if (c.type === 'board') drawBoard(ctx, s, c);
  else if (c.type === 'led') drawLed(ctx, s, c);
  else if (c.type === 'resistor') drawResistor(ctx, s, c, body);
  else if (c.type === 'button') drawButton(ctx, s, c, body);
  else if (c.type === 'buzzer') drawBox(ctx, s, body, 'BUZZ', '#4a3a5a');
  else if (c.type === 'battery') drawBox(ctx, s, body, `${c.params.volts ?? 9}V`, '#405066');
  else drawBox(ctx, s, body, c.type, C.body);

  if (s.selection.has(c.id)) {
    ctx.strokeStyle = C.select;
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(p0.x - 4, p0.y - 4, bw + 8, bh + 8);
    ctx.setLineDash([]);
  }

  // pins (on top, always grabbable); board pins draw in a later pass so
  // wires never hide them
  if (c.type === 'board') return;
  for (const p of fp.pins) {
    const w = s.schematic.pinWorld({ comp: c.id, pin: p.name });
    const q = s.viewport.worldToScreen(w.x, w.y);
    const hovered =
      s.hoverPin && s.hoverPin.comp === c.id && s.hoverPin.pin === p.name;
    ctx.fillStyle = hovered ? C.pinHot : C.pin;
    ctx.beginPath();
    ctx.arc(q.x, q.y, hovered ? 5 : 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawBoard(ctx: CanvasRenderingContext2D, s: RenderScene, c: PlacedComponent): void {
  const body = s.schematic.bodyRect(c);
  const p0 = s.viewport.worldToScreen(body.x, body.y);
  const bw = body.w * s.viewport.zoom;
  const bh = body.h * s.viewport.zoom;
  ctx.fillStyle = C.board;
  ctx.strokeStyle = C.boardEdge;
  ctx.lineWidth = 1.5;
  roundRect(ctx, p0.x, p0.y, bw, bh, 8);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = C.silk;
  ctx.font = `${Math.min(14, Math.max(11, 12 * s.viewport.zoom))}px ui-monospace, monospace`;
  ctx.textBaseline = 'alphabetic';
  const boardName = String(c.params.board ?? '').includes('nodemcu') ? 'NodeMCU v3' : 'Wemos D1 mini';
  ctx.fillText(boardName, p0.x + 2, p0.y - 6);

  // silk labels beside every pin
  const fp = footprintFor('board', c.params);
  ctx.font = `${Math.max(9, Math.min(12, 11 * s.viewport.zoom))}px ui-monospace, monospace`;
  for (const p of fp.pins) {
    const w = s.schematic.pinWorld({ comp: c.id, pin: p.name });
    const q = s.viewport.worldToScreen(w.x, w.y);
    const left = p.x <= 80;
    ctx.fillStyle = C.silk;
    ctx.textAlign = left ? 'right' : 'left';
    ctx.fillText(p.name, q.x + (left ? -9 : 9), q.y);
  }
  ctx.textAlign = 'left';

}

function drawBoardPins(ctx: CanvasRenderingContext2D, s: RenderScene, c: PlacedComponent): void {
  const fp = footprintFor('board', c.params);
  for (const p of fp.pins) {
    const w = s.schematic.pinWorld({ comp: c.id, pin: p.name });
    const q = s.viewport.worldToScreen(w.x, w.y);
    const t = `${c.id}.${p.name}`;
    const level = s.circuit?.pinLevels.get(netTerminal(s, t));
    ctx.fillStyle = level === undefined ? C.pin : level ? C.wireHot : '#2c3a4d';
    ctx.beginPath();
    ctx.arc(q.x, q.y, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Document terminal 'board.D2' -> netlist terminal 'mcu.D2'. */
function netTerminal(s: RenderScene, docTerminal: string): string {
  const dot = docTerminal.indexOf('.');
  const comp = docTerminal.slice(0, dot);
  return s.schematic.component(comp)?.type === 'board'
    ? `mcu${docTerminal.slice(dot)}`
    : docTerminal;
}

function drawLed(ctx: CanvasRenderingContext2D, s: RenderScene, c: PlacedComponent): void {
  const a = s.schematic.pinWorld({ comp: c.id, pin: 'a' });
  const k = s.schematic.pinWorld({ comp: c.id, pin: 'k' });
  const qa = s.viewport.worldToScreen(a.x, a.y);
  const qk = s.viewport.worldToScreen(k.x, k.y);
  const state = s.circuit?.leds.get(c.id);
  const on = state?.on ?? false;
  const burnt = state?.burnt ?? false;
  const bright = state?.brightness ?? 0;

  ctx.save();
  ctx.translate(qa.x, qa.y);
  ctx.rotate(Math.atan2(qk.y - qa.y, qk.x - qa.x));
  const len = Math.hypot(qk.x - qa.x, qk.y - qa.y);
  const r = Math.max(6, len * 0.22);
  const cx = len / 2;

  if (on && !burnt) {
    const glow = ctx.createRadialGradient(cx, 0, 1, cx, 0, r * 4);
    const color = c.params.color === 'red' ? '255,80,80' : '255,180,60';
    glow.addColorStop(0, `rgba(${color},${0.55 * bright + 0.15})`);
    glow.addColorStop(1, 'rgba(255,180,60,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, 0, r * 4, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = burnt ? '#552222' : on ? '#ffcf6a' : C.ledOff;
  ctx.strokeStyle = burnt ? '#883333' : '#d8a04a';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(cx, 0, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.strokeStyle = on ? '#ffe9b8' : '#6d7d92';
  ctx.beginPath(); // anode -> triangle -> cathode bar
  ctx.moveTo(0, 0);
  ctx.lineTo(cx - r, 0);
  ctx.moveTo(cx + r, 0);
  ctx.lineTo(len, 0);
  ctx.stroke();
  ctx.fillStyle = on ? '#ffe9b8' : '#6d7d92';
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.6, -r * 0.7);
  ctx.lineTo(cx + r * 0.4, 0);
  ctx.lineTo(cx - r * 0.6, r * 0.7);
  ctx.closePath();
  ctx.fill();
  ctx.fillRect(cx + r * 0.4, -r * 0.8, 2.5, r * 1.6);
  ctx.restore();
}

function drawResistor(
  ctx: CanvasRenderingContext2D,
  s: RenderScene,
  c: PlacedComponent,
  body: { x: number; y: number; w: number; h: number },
): void {
  const a = s.schematic.pinWorld({ comp: c.id, pin: 'p1' });
  const b = s.schematic.pinWorld({ comp: c.id, pin: 'p2' });
  const qa = s.viewport.worldToScreen(a.x, a.y);
  const qb = s.viewport.worldToScreen(b.x, b.y);
  ctx.strokeStyle = '#9fb3c8';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(qa.x, qa.y);
  ctx.lineTo(qb.x, qb.y);
  ctx.stroke();
  const p0 = s.viewport.worldToScreen(body.x, body.y);
  ctx.fillStyle = '#4a5a70';
  roundRect(ctx, p0.x + body.w * s.viewport.zoom * 0.2, p0.y, body.w * s.viewport.zoom * 0.6, body.h * s.viewport.zoom, 3);
  ctx.fill();
  labelAt(ctx, s, `${formatResistance(c.params.resistance)}`, {
    x: (qa.x + qb.x) / 2,
    y: p0.y - 6,
  });
}

function drawButton(
  ctx: CanvasRenderingContext2D,
  s: RenderScene,
  c: PlacedComponent,
  body: { x: number; y: number; w: number; h: number },
): void {
  const closed = !!s.circuit && closedSwitch(s, c.id);
  const p0 = s.viewport.worldToScreen(body.x, body.y);
  ctx.fillStyle = closed ? '#2e7d5b' : C.body;
  ctx.strokeStyle = C.bodyEdge;
  roundRect(ctx, p0.x, p0.y, body.w * s.viewport.zoom, body.h * s.viewport.zoom, 4);
  ctx.fill();
  ctx.stroke();
  labelAt(ctx, s, closed ? 'PRESSED' : 'BTN', {
    x: p0.x + (body.w * s.viewport.zoom) / 2,
    y: p0.y - 6,
  });
}

function closedSwitch(s: RenderScene, id: string): boolean {
  // The netlist owns switch state; a closed button has p1 and p2 on one net.
  const c = s.circuit;
  if (!c) return false;
  const a = c.netOf.get(`${id}.p1`);
  const b = c.netOf.get(`${id}.p2`);
  return a !== undefined && a === b;
}

function drawBox(
  ctx: CanvasRenderingContext2D,
  s: RenderScene,
  body: { x: number; y: number; w: number; h: number },
  text: string,
  fill: string,
): void {
  const p0 = s.viewport.worldToScreen(body.x, body.y);
  ctx.fillStyle = fill;
  ctx.strokeStyle = C.bodyEdge;
  roundRect(ctx, p0.x, p0.y, body.w * s.viewport.zoom, body.h * s.viewport.zoom, 4);
  ctx.fill();
  ctx.stroke();
  labelAt(ctx, s, text, {
    x: p0.x + (body.w * s.viewport.zoom) / 2,
    y: p0.y - 6,
  });
}

// ---------- primitives ----------

function strokeWorld(ctx: CanvasRenderingContext2D, s: RenderScene, pts: Pt[]): void {
  ctx.beginPath();
  pts.forEach((p, i) => {
    const q = s.viewport.worldToScreen(p.x, p.y);
    if (i === 0) ctx.moveTo(q.x, q.y);
    else ctx.lineTo(q.x, q.y);
  });
  ctx.stroke();
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function labelAt(ctx: CanvasRenderingContext2D, s: RenderScene, text: string, at: Pt): void {
  ctx.fillStyle = C.text;
  ctx.font = `${Math.max(9, Math.min(13, 10 * s.viewport.zoom))}px ui-monospace, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(text, at.x, at.y);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

function formatResistance(r: unknown): string {
  const v = Number(r);
  if (!Number.isFinite(v)) return '?';
  if (v >= 1e6) return `${v / 1e6}M`;
  if (v >= 1e3) return `${v / 1e3}k`;
  return `${v}`;
}
