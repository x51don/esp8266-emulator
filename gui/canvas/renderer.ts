/**
 * Canvas renderer. One entry point: renderScene(ctx, scene). Reads only,
 * never mutates the scene. Coordinates: convert world -> screen through the
 * viewport for every vertex; line widths stay crisp in screen space.
 */

import type { ResolveResult } from '../../peripherals/netlist';
import { footprintFor, type PlacedComponent, type Schematic, type TerminalRef, pinExitDir, WIRE_ROLE_COLORS, type WireSeg } from './schematic';
import { gridStep, visibleCells } from './grid';
import { getBoard } from '../../core/boards';
import { routeWire } from './routes';
import type { Pt, Viewport } from './viewport';

export interface DragWireState {
  from: TerminalRef;
  cursor: Pt;
}

import type { Esp8266Machine } from '../../core/machine';

export interface RenderScene {
  schematic: Schematic;
  viewport: Viewport;
  width: number; // css pixels
  height: number;
  circuit: ResolveResult | null; // null while the machine is not running
  running: boolean;
  selection: ReadonlySet<string>;
  hoverPin: TerminalRef | null;
  /** Wire id under the pointer (P2 hover highlight; Del removes it). */
  hoverWire: string | null;
  dragWire: DragWireState | null;
  /** Palette part hovering over the canvas mid-DnD (P2 ghost preview). */
  ghost: { type: string; x: number; y: number } | null;
  machine: Esp8266Machine | null; // state view (servos, panels, strips)
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
  ctx.save();

  // Background + grid come from an offscreen bitmap (P1.3) keyed by camera,
  // size and dpr: hover/drag frames copy pixels instead of re-stroking
  // hundreds of grid lines. The bitmap always covers the whole canvas, so
  // the drawImage doubles as the clear.
  drawGridCached(ctx, s);

  const pins = pinMap(s.schematic);
  // layer order: board bodies, wires (over the board, under small parts),
  // parts, then the in-progress wire
  for (const c of s.schematic.components.values()) if (c.type === 'board') drawComponent(ctx, s, c);
  drawWires(ctx, s, pins);
  for (const c of s.schematic.components.values()) if (c.type !== 'board') drawComponent(ctx, s, c);
  for (const c of s.schematic.components.values()) if (c.type === 'board') drawBoardPins(ctx, s, c);
  drawDragWire(ctx, s, pins);
  drawGhost(ctx, s);

  ctx.restore();
}

let gridCanvas: HTMLCanvasElement | null = null;
let gridSig = '';

function drawGridCached(ctx: CanvasRenderingContext2D, s: RenderScene): void {
  // the caller installs a dpr transform; read it back instead of re-deriving
  const dpr = ctx.getTransform().a || 1;
  const vp = s.viewport;
  const sig = `${vp.camX}|${vp.camY}|${vp.zoom}|${s.width}|${s.height}|${dpr}`;
  if (gridCanvas && gridSig === sig) {
    ctx.drawImage(gridCanvas, 0, 0, s.width, s.height);
    return;
  }
  if (!gridCanvas) gridCanvas = document.createElement('canvas');
  const w = Math.max(1, Math.round(s.width * dpr));
  const h = Math.max(1, Math.round(s.height * dpr));
  if (gridCanvas.width !== w || gridCanvas.height !== h) {
    gridCanvas.width = w;
    gridCanvas.height = h;
  }
  const g = gridCanvas.getContext('2d');
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = C.bg;
  g.fillRect(0, 0, s.width, s.height);
  drawGrid(g, s);
  gridSig = sig;
  ctx.drawImage(gridCanvas, 0, 0, s.width, s.height);
}

// ---------- helpers ----------

function pinMap(sc: Schematic): Map<string, Pt> {
  const m = new Map<string, Pt>();
  for (const p of sc.allPinWorlds()) m.set(`${p.comp}.${p.pin}`, p);
  return m;
}

/** Wire exit direction: away from the component body center. */


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

/**
 * F14: fault wins, then the wire's explicit colour, then the automatic net
 * role (power red / GND white / signal green). A live HIGH net adds a yellow
 * glow on top of the role colour instead of replacing it.
 */
function wireColor(s: RenderScene, w: WireSeg): string {
  if (w.color) return w.color;
  return WIRE_ROLE_COLORS[s.schematic.netRoles().get(w.id) ?? 'signal'];
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
    const fault = netFaulted(s, ta) || netFaulted(s, tb);
    const hot =
      (netLevel(s, ta) ?? 0) > 1.65 || (netLevel(s, tb) ?? 0) > 1.65;
    const base = fault ? C.wireFault : wireColor(s, w);
    const path = s.schematic.wireRoutes().get(w.id) ?? [a, b];
    if (s.hoverWire === w.id) {
      // hover halo: thicker selection-coloured underlay under the normal stroke
      ctx.strokeStyle = C.select;
      ctx.lineWidth = 5;
      strokeWorld(ctx, s, path);
    }
    ctx.strokeStyle = base;
    ctx.lineWidth = 2;
    strokeWorld(ctx, s, path);
    if (hot && !fault) {
      ctx.save();
      ctx.strokeStyle = C.wireHot;
      ctx.globalAlpha = 0.55;
      strokeWorld(ctx, s, path);
      ctx.restore();
    }
  }
  drawCrossingGlyphs(ctx, s);
}

/** Direction (screen space) of the path segment running through a point. */
function dirAtPoint(path: Pt[], p: Pt, s: RenderScene): number | null {
  for (let i = 0; i + 1 < path.length; i++) {
    const a = s.viewport.worldToScreen(path[i].x, path[i].y);
    const b = s.viewport.worldToScreen(path[i + 1].x, path[i + 1].y);
    const horiz = a.y === b.y;
    const lo = horiz ? Math.min(a.x, b.x) : Math.min(a.y, b.y);
    const hi = horiz ? Math.max(a.x, b.x) : Math.max(a.y, b.y);
    const along = horiz ? p.x : p.y;
    const fixed = horiz ? a.y : a.x;
    const fixedP = horiz ? a : b;
    const fixedHere = horiz ? p.y : p.x;
    if (Math.abs(fixed - fixedHere) < 1 && along > lo - 1 && along < hi + 1) {
      void fixedP;
      return horiz ? 0 : Math.PI / 2;
    }
  }
  return null;
}

/**
 * Crossovers of two wires that are NOT connected: a hop (semicircle) rides
 * the later-drawn wire. Same-net crossings are real solder joints and get a
 * dot instead.
 */
function drawCrossingGlyphs(ctx: CanvasRenderingContext2D, s: RenderScene): void {
  const crossings = s.schematic.wireCrossings();
  if (crossings.length === 0) return;
  const routes = s.schematic.wireRoutes();
  const term = (w: { a: { comp: string; pin: string }; b: { comp: string; pin: string } }): (string | undefined)[] => [
    s.circuit?.netOf.get(netTerminal(s, `${w.a.comp}.${w.a.pin}`)),
    s.circuit?.netOf.get(netTerminal(s, `${w.b.comp}.${w.b.pin}`)),
  ];
  for (const cx of crossings) {
    const w1 = s.schematic.wires.get(cx.w1);
    const w2 = s.schematic.wires.get(cx.w2);
    const p1 = routes.get(cx.w1);
    const p2 = routes.get(cx.w2);
    if (!w1 || !w2 || !p1 || !p2) continue;
    const sp = s.viewport.worldToScreen(cx.x, cx.y);
    const n1 = term(w1);
    const same = n1.some((n) => n !== undefined && term(w2).includes(n));
    ctx.fillStyle = C.bg;
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, 5.5, 0, Math.PI * 2);
    ctx.fill();
    const d1 = dirAtPoint(p1, sp, s);
    const d2 = dirAtPoint(p2, sp, s);
    if (same) {
      ctx.strokeStyle = wireColor(s, w1);
      ctx.lineWidth = 2;
      for (const d of [d1, d2]) {
        if (d === null) continue;
        ctx.beginPath();
        ctx.moveTo(sp.x - Math.cos(d) * 6, sp.y - Math.sin(d) * 6);
        ctx.lineTo(sp.x + Math.cos(d) * 6, sp.y + Math.sin(d) * 6);
        ctx.stroke();
      }
      ctx.fillStyle = C.pin;
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, 3, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    if (d1 !== null) {
      ctx.strokeStyle = wireColor(s, w1);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(sp.x - Math.cos(d1) * 6, sp.y - Math.sin(d1) * 6);
      ctx.lineTo(sp.x + Math.cos(d1) * 6, sp.y + Math.sin(d1) * 6);
      ctx.stroke();
    }
    if (d2 !== null) {
      // semicircle whose endpoints sit on w2's line, bulging across w1's line
      const start = d2 === 0 ? 0 : -Math.PI / 2;
      ctx.strokeStyle = wireColor(s, w2);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, 4, start, start + Math.PI, false);
      ctx.stroke();
    }
  }
}

function drawDragWire(ctx: CanvasRenderingContext2D, s: RenderScene, pins: Map<string, Pt>): void {
  if (!s.dragWire) return;
  const a = pins.get(`${s.dragWire.from.comp}.${s.dragWire.from.pin}`);
  if (!a) return;
  ctx.strokeStyle = C.select;
  ctx.setLineDash([6, 4]);
  ctx.lineWidth = 2;
  strokeWorld(ctx, s, routeWire(a, s.dragWire.cursor, pinExitDir(s.schematic, s.dragWire.from, a)));
  ctx.setLineDash([]);
}

/** Dashed snapped outline of the part a palette drag would drop here. */
function drawGhost(ctx: CanvasRenderingContext2D, s: RenderScene): void {
  if (!s.ghost) return;
  let fp;
  try {
    fp = footprintFor(s.ghost.type, {});
  } catch {
    return; // unknown type: the drop will be refused, no ghost
  }
  const tl = s.viewport.worldToScreen(s.ghost.x + fp.body.x, s.ghost.y + fp.body.y);
  const br = s.viewport.worldToScreen(
    s.ghost.x + fp.body.x + fp.body.w, s.ghost.y + fp.body.y + fp.body.h);
  ctx.save();
  ctx.globalAlpha = 0.7;
  ctx.setLineDash([4, 3]);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = C.select;
  ctx.fillStyle = 'rgba(77, 163, 255, 0.12)';
  ctx.fillRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
  ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
  ctx.setLineDash([]);
  ctx.fillStyle = C.select;
  ctx.font = '11px monospace';
  ctx.fillText(s.ghost.type, tl.x, tl.y - 4);
  ctx.restore();
}

function drawComponent(ctx: CanvasRenderingContext2D, s: RenderScene, c: PlacedComponent): void {
  const fp = footprintFor(c.type, c.params);
  const body = s.schematic.bodyRect(c);
  const p0 = s.viewport.worldToScreen(body.x, body.y);
  const bw = body.w * s.viewport.zoom;
  const bh = body.h * s.viewport.zoom;

  if (c.type === 'board') drawBoard(ctx, s, c);
  else if (c.type === 'led') drawLed(ctx, s, c);
  else if (c.type === 'diode' || c.type === 'zener') drawDiode(ctx, s, c);
  else if (c.type === 'transistor') drawTransistor(ctx, s, c);
  else if (c.type === 'mosfet') drawMosfet(ctx, s, c);
  else if (c.type === 'resistor') drawResistor(ctx, s, c, body);
  else if (c.type === 'button') drawButton(ctx, s, c, body);
  else if (c.type === 'buzzer') drawBox(ctx, s, body, 'BUZZ', '#4a3a5a');
  else if (c.type === 'battery') drawBox(ctx, s, body, `${c.params.volts ?? 9}V`, '#405066');
  else if (c.type === 'pot') drawPot(ctx, s, c, body);
  else if (c.type === 'cap') drawCap(ctx, s, c, body);
  else if (c.type === 'ldr') drawChip(ctx, s, c, body, 'LDR', `${Math.round(Number(c.params.lux ?? 300))} lx`, '#33301f');
  else if (c.type === 'dht') drawChip(ctx, s, c, body, `DHT${String(c.params.model ?? 'DHT22').replace('DHT', '')}`, `${c.params.tempC ?? 22}\u00b0C  ${c.params.humPct ?? 50}%`, '#1c2836');
  else if (c.type === 'hcsr') drawHcsr(ctx, s, c, body);
  else if (c.type === 'servo') drawServo(ctx, s, c, body);
  else if (c.type === 'relay') drawRelay(ctx, s, c, body);
  else if (c.type === 'oled') drawOled(ctx, s, c, body);
  else if (c.type === 'neopixel') drawNeopixel(ctx, s, c, body);
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

// ---------- ESPHome-style parts ----------

function boxScreen(s: RenderScene, body: { x: number; y: number; w: number; h: number }) {
  const p0 = s.viewport.worldToScreen(body.x, body.y);
  const z = s.viewport.zoom;
  return { x: p0.x, y: p0.y, w: body.w * z, h: body.h * z, z };
}

/** GPIO number the net of comp.pin currently belongs to, or null. */
function pinGpio(s: RenderScene, compId: string, pin: string): number | null {
  if (!s.circuit) return null;
  const net = s.circuit.netOf.get(netTerminal(s, `${compId}.${pin}`));
  if (net === undefined) return null;
  const board = s.schematic.boardComponent();
  if (!board) return null;
  const bd = getBoard(String(board.params.board ?? 'wemos-d1-mini'));
  for (const p of footprintFor('board', board.params).pins) {
    if (s.circuit.netOf.get(netTerminal(s, `${board.id}.${p.name}`)) !== net) continue;
    const g = bd.gpioFor(p.name);
    if (g !== null) return g;
  }
  return null;
}

function chipBox(
  ctx: CanvasRenderingContext2D, s: RenderScene, body: { x: number; y: number; w: number; h: number },
  fill: string,
): ReturnType<typeof boxScreen> {
  const b = boxScreen(s, body);
  ctx.fillStyle = fill;
  ctx.strokeStyle = C.bodyEdge;
  roundRect(ctx, b.x, b.y, b.w, b.h, 5);
  ctx.fill();
  ctx.stroke();
  return b;
}

function chipText(
  ctx: CanvasRenderingContext2D,
  b: { x: number; y: number; w: number; h: number; z: number },
  title: string, value: string, color = C.text,
): void {
  ctx.fillStyle = C.silk;
  ctx.font = `${Math.max(8, 10 * b.z)}px ui-monospace, monospace`;
  ctx.textAlign = 'center';
  ctx.fillText(title, b.x + b.w / 2, b.y + 13 * b.z);
  ctx.fillStyle = color;
  ctx.font = `${Math.max(9, 11 * b.z)}px ui-monospace, monospace`;
  ctx.fillText(value, b.x + b.w / 2, b.y + b.h / 2 + 7 * b.z);
  ctx.textAlign = 'left';
}

function drawCap(ctx: CanvasRenderingContext2D, s: RenderScene, c: PlacedComponent, body: { x: number; y: number; w: number; h: number }): void {
  const b = boxScreen(s, body);
  const mid = b.x + b.w / 2;
  ctx.strokeStyle = C.silk;
  ctx.lineWidth = 2;
  const f = c.flip ? -1 : 1; // curved plate faces p2; mirror with flip
  ctx.beginPath();
  ctx.moveTo(mid - 3 * f * b.z, b.y + 2 * b.z);
  ctx.lineTo(mid - 3 * f * b.z, b.y + b.h - 2 * b.z);
  ctx.moveTo(mid + 3 * f * b.z, b.y + 4 * b.z);
  ctx.arcTo(mid + 9 * f * b.z, b.y + b.h / 2, mid + 3 * f * b.z, b.y + b.h - 4 * b.z, 6 * b.z);
  ctx.stroke();
  ctx.lineWidth = 1;
  const uf = Number(c.params.uf ?? 100);
  ctx.fillStyle = C.text;
  ctx.textAlign = 'center';
  ctx.font = `${Math.max(8, 10 * b.z)}px ui-monospace, monospace`;
  ctx.fillText(uf >= 1000 ? `${uf / 1000}mF` : `${uf}uF`, mid, b.y - 4 * b.z);
  ctx.textAlign = 'left';
}

function drawPot(ctx: CanvasRenderingContext2D, s: RenderScene, c: PlacedComponent, body: { x: number; y: number; w: number; h: number }): void {
  const b = boxScreen(s, body);
  ctx.fillStyle = '#2a2418';
  ctx.strokeStyle = C.bodyEdge;
  roundRect(ctx, b.x, b.y, b.w, b.h, 3);
  ctx.fill();
  ctx.stroke();
  const ratio = Math.min(1, Math.max(0, Number(c.params.ratio ?? 0.5)));
  const wx = c.flip ? b.x + b.w - ratio * b.w : b.x + ratio * b.w;
  ctx.strokeStyle = C.text;
  ctx.beginPath();
  ctx.moveTo(wx, b.y - 6 * b.z);
  ctx.lineTo(wx, b.y);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(wx, b.y + b.h + 5 * b.z, 3 * b.z, 0, Math.PI * 2);
  ctx.fillStyle = C.wireHot;
  ctx.fill();
  ctx.fillStyle = C.silk;
  ctx.textAlign = 'center';
  ctx.font = `${Math.max(8, 10 * b.z)}px ui-monospace, monospace`;
  ctx.fillText(`${Math.round(ratio * 100)}%`, b.x + b.w / 2, b.y - 10 * b.z);
  ctx.textAlign = 'left';
}

function drawChip(
  ctx: CanvasRenderingContext2D, s: RenderScene, c: PlacedComponent,
  body: { x: number; y: number; w: number; h: number }, title: string, value: string, fill: string,
): void {
  const b = chipBox(ctx, s, body, fill);
  chipText(ctx, b, title, value);
  void c;
}

function drawHcsr(ctx: CanvasRenderingContext2D, s: RenderScene, c: PlacedComponent, body: { x: number; y: number; w: number; h: number }): void {
  const b = chipBox(ctx, s, body, '#20304a');
  chipText(ctx, b, 'HC-SR04', `${c.params.cm ?? 20} cm`, '#9fd0ff');
  // two ultrasonic transducers
  ctx.strokeStyle = '#5b7ba6';
  for (const fx of [0.32, 0.68]) {
    ctx.beginPath();
    ctx.arc(b.x + b.w * fx, b.y + b.h * 0.68, b.h * 0.13, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawServo(ctx: CanvasRenderingContext2D, s: RenderScene, c: PlacedComponent, body: { x: number; y: number; w: number; h: number }): void {
  const b = chipBox(ctx, s, body, '#42304f');
  const gpio = pinGpio(s, c.id, 'sig');
  const deg = gpio !== null ? (s.machine?.servoAngles().get(gpio) ?? 90) : 90;
  chipText(ctx, b, 'SG90 SERVO', `${Math.round(deg)}\u00b0`, '#e6d2ff');
  const cx = b.x + b.w * 0.5;
  const cy = b.y + b.h * 0.62;
  const a = Math.PI - (deg / 180) * Math.PI; // 0\u00b0 left, 180\u00b0 right
  ctx.strokeStyle = '#e6d2ff';
  ctx.lineWidth = 2 * b.z;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(a) * b.w * 0.3, cy - Math.sin(a) * b.h * 0.3);
  ctx.stroke();
  ctx.lineWidth = 1;
}

function drawRelay(ctx: CanvasRenderingContext2D, s: RenderScene, c: PlacedComponent, body: { x: number; y: number; w: number; h: number }): void {
  const b = chipBox(ctx, s, body, '#33272a');
  const nv = (pin: string): number => {
    if (!s.circuit) return 0;
    const net = s.circuit.netOf.get(netTerminal(s, `${c.id}.${pin}`));
    return net === undefined ? 0 : s.circuit.netVoltage.get(net) ?? 0;
  };
  const on = nv('coilp') > 2 && nv('coiln') < 1.65;
  chipText(ctx, b, 'RELAY', on ? 'CLOSED' : 'open', on ? C.wireHot : C.text);
  const swp = s.schematic.pinWorld({ comp: c.id, pin: 'sw' });
  const otp = s.schematic.pinWorld({ comp: c.id, pin: on ? 'no' : 'nc' });
  const sw = s.viewport.worldToScreen(swp.x, swp.y);
  const out = s.viewport.worldToScreen(otp.x, otp.y);
  ctx.strokeStyle = on ? C.wireHot : C.silk;
  ctx.lineWidth = 2 * b.z;
  ctx.beginPath();
  ctx.moveTo(sw.x, sw.y);
  ctx.lineTo(out.x, out.y);
  ctx.stroke();
  ctx.lineWidth = 1;
}

function drawOled(ctx: CanvasRenderingContext2D, s: RenderScene, c: PlacedComponent, body: { x: number; y: number; w: number; h: number }): void {
  const b = chipBox(ctx, s, body, '#10151d');
  const m = 10 * b.z;
  const sx = b.x + m + 6 * b.z;
  const sy = b.y + m;
  const sw = b.w - 2 * m - 12 * b.z;
  const sh = b.h - 2 * m;
  ctx.fillStyle = '#04070b';
  roundRect(ctx, sx, sy, sw, sh, 3);
  ctx.fill();
  ctx.strokeStyle = '#2c3a4d';
  ctx.stroke();
  const frame = s.machine?.oledFrames().get(c.id);
  if (frame?.fb) {
    // P3.5: visible 128x64 pixels (SSD1306 page layout) as one path
    ctx.fillStyle = '#cfe9ff';
    const pw = sw / 128;
    const ph = sh / 64;
    for (let y = 0; y < 64; y++) {
      for (let byte = 0; byte < 16; byte++) {
        const b = frame.fb[(y << 4) + byte];
        if (!b) continue;
        for (let bit = 0; bit < 8; bit++) {
          if (b & (1 << bit)) {
            ctx.fillRect(sx + ((byte << 3) + bit) * pw, sy + y * ph, pw + 0.5, ph + 0.5);
          }
        }
      }
    }
  }
  const cells = frame?.cells;
  if (cells) {
    ctx.fillStyle = '#6ef7a5';
    ctx.font = `${Math.max(7, Math.min(10, 9 * b.z))}px ui-monospace, monospace`;
    ctx.textBaseline = 'top';
    const lh = sh / 8;
    for (let i = 0; i < 8; i++) {
      const row = cells[i].trimEnd();
      if (row) ctx.fillText(row, sx + 3 * b.z, sy + 2 * b.z + i * lh);
    }
    ctx.textBaseline = 'alphabetic';
  }
  ctx.fillStyle = C.silk;
  ctx.font = `${Math.max(8, 10 * b.z)}px ui-monospace, monospace`;
  ctx.fillText('OLED 0.96\u2033 I2C', b.x + 2, b.y - 5 * b.z);
}

function drawNeopixel(ctx: CanvasRenderingContext2D, s: RenderScene, c: PlacedComponent, body: { x: number; y: number; w: number; h: number }): void {
  const b = chipBox(ctx, s, body, '#1c232e');
  const gpio = pinGpio(s, c.id, 'din');
  const strip = gpio !== null ? s.machine?.strips().get(gpio) : undefined;
  const physical = strip?.physical ?? Number(c.params.count ?? 8);
  const n = Math.min(physical, 16);
  for (let i = 0; i < n; i++) {
    const rgb = strip?.pixels[i] ?? 0;
    ctx.fillStyle = rgb ? `#${rgb.toString(16).padStart(6, '0')}` : '#26303d';
    ctx.beginPath();
    const px = c.flip ? b.x + b.w - ((i + 0.5) * b.w) / n : b.x + ((i + 0.5) * b.w) / n;
    ctx.arc(px, b.y + b.h * 0.55, Math.min(5 * b.z, b.w / n / 2.4), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = C.silk;
  ctx.font = `${Math.max(8, 10 * b.z)}px ui-monospace, monospace`;
  ctx.fillText(`NEOPIXEL x${physical}`, b.x + 2, b.y - 5 * b.z);
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

/** Diode / Zener: triangle + bar along the a->k axis, Z-bend for the Zener. */
function drawDiode(ctx: CanvasRenderingContext2D, s: RenderScene, c: PlacedComponent): void {
  const a = s.schematic.pinWorld({ comp: c.id, pin: 'a' });
  const k = s.schematic.pinWorld({ comp: c.id, pin: 'k' });
  const qa = s.viewport.worldToScreen(a.x, a.y);
  const qk = s.viewport.worldToScreen(k.x, k.y);
  const state = s.circuit?.semis.get(c.id);
  const on = state?.on ?? false;
  const burnt = state?.burnt ?? false;

  ctx.save();
  ctx.translate(qa.x, qa.y);
  ctx.rotate(Math.atan2(qk.y - qa.y, qk.x - qa.x));
  const len = Math.hypot(qk.x - qa.x, qk.y - qa.y);
  const r = Math.max(5, len * 0.2);
  const cx = len / 2;

  if (on && !burnt) {
    const glow = ctx.createRadialGradient(cx, 0, 1, cx, 0, r * 3.4);
    glow.addColorStop(0, 'rgba(120,255,170,0.35)');
    glow.addColorStop(1, 'rgba(120,255,170,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, 0, r * 3.4, 0, Math.PI * 2);
    ctx.fill();
  }

  const stroke = burnt ? '#c05050' : on ? '#8ff0b0' : '#8494ab';
  ctx.strokeStyle = stroke;
  ctx.fillStyle = burnt ? '#3a1d1d' : on ? 'rgba(143,240,176,0.35)' : 'rgba(132,148,171,0.12)';
  ctx.lineWidth = 1.6;
  ctx.beginPath(); // leads
  ctx.moveTo(0, 0);
  ctx.lineTo(cx - r, 0);
  ctx.moveTo(cx + r, 0);
  ctx.lineTo(len, 0);
  ctx.stroke();
  ctx.beginPath(); // triangle
  ctx.moveTo(cx - r, -r);
  ctx.lineTo(cx - r, r);
  ctx.lineTo(cx + r * 0.15, 0);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.beginPath(); // cathode bar (+ Z-bends for the Zener)
  ctx.moveTo(cx + r * 0.15, -r * 1.1);
  ctx.lineTo(cx + r * 0.15, r * 1.1);
  if (c.type === 'zener') {
    ctx.moveTo(cx + r * 0.15 - r * 0.55, -r * 1.1);
    ctx.lineTo(cx + r * 0.15, -r * 0.35);
    ctx.moveTo(cx + r * 0.15, r * 0.35);
    ctx.lineTo(cx + r * 0.15 + r * 0.55, r * 1.1);
  }
  ctx.stroke();
  if (state?.mode === 'rev') {
    ctx.fillStyle = '#9fb6d4'; // breakdown direction hint (k -> a)
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('\u2264Vz', cx, -r - 6);
  }
  ctx.restore();
}

/** Bipolar transistor: base bar, collector/emitter fans, arrow on the emitter. */
function drawTransistor(ctx: CanvasRenderingContext2D, s: RenderScene, c: PlacedComponent): void {
  const pb = s.schematic.pinWorld({ comp: c.id, pin: 'b' });
  const pc = s.schematic.pinWorld({ comp: c.id, pin: 'c' });
  const pe = s.schematic.pinWorld({ comp: c.id, pin: 'e' });
  const qb = s.viewport.worldToScreen(pb.x, pb.y);
  const qc = s.viewport.worldToScreen(pc.x, pc.y);
  const qe = s.viewport.worldToScreen(pe.x, pe.y);
  const state = s.circuit?.semis.get(c.id);
  const on = state?.on ?? false;
  const burnt = state?.burnt ?? false;
  const npn = String(c.params.polarity ?? 'npn') !== 'pnp';

  ctx.save();
  // work in a frame where the base is left and C/E stack vertically
  const mx = (qc.x + qe.x) / 2;
  const my = (qc.y + qe.y) / 2;
  ctx.translate(qb.x, qb.y);
  ctx.rotate(Math.atan2(my - qb.y, mx - qb.x));
  const span = Math.hypot(qc.x - qe.x, qc.y - qe.y) / 2; // half C-E distance
  const bx = Math.hypot(mx - qb.x, my - qb.y); // base -> bar distance
  const r = Math.max(9, Math.min(span * 1.35, bx * 0.8));
  const barX = bx * 0.62;

  if (on && !burnt) {
    const glow = ctx.createRadialGradient(barX, 0, 1, barX, 0, r * 2.6);
    glow.addColorStop(0, 'rgba(120,255,170,0.3)');
    glow.addColorStop(1, 'rgba(120,255,170,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(barX, 0, r * 2.6, 0, Math.PI * 2);
    ctx.fill();
  }

  const stroke = burnt ? '#c05050' : on ? '#8ff0b0' : '#8494ab';
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.6;
  ctx.beginPath(); // case circle
  ctx.arc(barX - r * 0.15, 0, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath(); // base lead + vertical bar
  ctx.moveTo(0, 0);
  ctx.lineTo(barX, 0);
  ctx.moveTo(barX, -r * 0.62);
  ctx.lineTo(barX, r * 0.62);
  ctx.stroke();
  // collector: bar -> top of circle -> out
  const topY = Math.max(-span, -r * 0.62) - r * 0.2;
  ctx.beginPath();
  ctx.moveTo(barX, topY * 0.55);
  ctx.lineTo(barX + r * 0.75, topY * 1.25);
  ctx.lineTo(mx - qb.x, topY * 1.25 > -span ? -span : topY * 1.25);
  ctx.stroke();
  // emitter: bar -> bottom (arrow toward the bar for PNP, away for NPN)
  const botY = r * 0.62 + r * 0.45;
  ctx.beginPath();
  ctx.moveTo(barX, r * 0.45);
  ctx.lineTo(barX + r * 0.75, botY * 1.1);
  ctx.lineTo(mx - qb.x, Math.max(span, botY * 1.1));
  ctx.stroke();
  const t = 0.6; // arrow position along the emitter fan segment
  const ax = barX + (r * 0.75 - barX) * 0 + r * 0.75 * t + barX * (1 - t);
  const ay = r * 0.45 + (botY * 1.1 - r * 0.45) * t;
  const dirx = r * 0.75 / Math.hypot(r * 0.75, botY * 1.1 - r * 0.45);
  const diry = (botY * 1.1 - r * 0.45) / Math.hypot(r * 0.75, botY * 1.1 - r * 0.45);
  const sgn = npn ? 1 : -1; // NPN arrow points away from the base (down-out)
  const alen = 4.5;
  const px = -diry * sgn;
  const py = dirx * sgn;
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(ax - sgn * dirx * alen + px * alen * 0.7, ay - sgn * diry * alen + py * alen * 0.7);
  ctx.moveTo(ax, ay);
  ctx.lineTo(ax - sgn * dirx * alen - px * alen * 0.7, ay - sgn * diry * alen - py * alen * 0.7);
  ctx.stroke();

  ctx.fillStyle = '#9fb6d4';
  ctx.font = '9px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.fillText(npn ? 'BC547' : 'BC557', barX - r * 0.15, r + 10);
  ctx.restore();
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

function drawMosfet(ctx: CanvasRenderingContext2D, s: RenderScene, c: PlacedComponent): void {
  const pg = s.schematic.pinWorld({ comp: c.id, pin: 'g' });
  const pd = s.schematic.pinWorld({ comp: c.id, pin: 'd' });
  const ps = s.schematic.pinWorld({ comp: c.id, pin: 's' });
  const qg = s.viewport.worldToScreen(pg.x, pg.y);
  const qd = s.viewport.worldToScreen(pd.x, pd.y);
  const qs = s.viewport.worldToScreen(ps.x, ps.y);
  const state = s.circuit?.semis.get(c.id);
  const on = state?.on ?? false;
  const burnt = state?.burnt ?? false;

  ctx.save();
  // same rotated frame as the transistor: gate left, D/S stacked right
  const mx = (qd.x + qs.x) / 2;
  const my = (qd.y + qs.y) / 2;
  ctx.translate(qg.x, qg.y);
  ctx.rotate(Math.atan2(my - qg.y, mx - qg.x));
  const span = Math.hypot(qd.x - qs.x, qd.y - qs.y) / 2;
  const gx = Math.hypot(mx - qg.x, my - qg.y) * 0.55; // insulated gate plate
  const chx = gx + 4; // channel plate
  const ex = mx - qg.x; // drain/source column

  if (on && !burnt) {
    const glow = ctx.createRadialGradient(chx, 0, 1, chx, 0, span * 2.4);
    glow.addColorStop(0, 'rgba(120,255,170,0.3)');
    glow.addColorStop(1, 'rgba(120,255,170,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(chx, 0, span * 2.4, 0, Math.PI * 2);
    ctx.fill();
  }

  const stroke = burnt ? '#c05050' : on ? '#8ff0b0' : '#8494ab';
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.6;
  ctx.beginPath(); // gate lead + plate (no contact: the gate is insulated)
  ctx.moveTo(0, 0);
  ctx.lineTo(gx, 0);
  ctx.moveTo(gx, -span * 0.85);
  ctx.lineTo(gx, span * 0.85);
  ctx.stroke();
  ctx.beginPath(); // channel plate, broken mid-way like the datasheet symbol
  ctx.moveTo(chx, -span * 0.85);
  ctx.lineTo(chx, -2);
  ctx.moveTo(chx, 2);
  ctx.lineTo(chx, span * 0.85);
  ctx.stroke();
  ctx.beginPath(); // drain: channel top -> pin
  ctx.moveTo(chx, -span * 0.6);
  ctx.lineTo(ex, -span);
  ctx.stroke();
  ctx.beginPath(); // source: channel bottom -> pin
  ctx.moveTo(chx, span * 0.6);
  ctx.lineTo(ex, span);
  ctx.stroke();
  // N-channel arrow on the source stub, pointing toward the channel
  const ax = chx + (ex - chx) * 0.45;
  const ay = span * 0.6 + (span - span * 0.6) * 0.45;
  const adx = ex - chx;
  const ady = span - span * 0.6;
  const al = Math.hypot(adx, ady) || 1;
  const ux = adx / al;
  const uy = ady / al;
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(ax - ux * 5 - uy * 3.2, ay - uy * 5 + ux * 3.2);
  ctx.moveTo(ax, ay);
  ctx.lineTo(ax - ux * 5 + uy * 3.2, ay - uy * 5 - ux * 3.2);
  ctx.stroke();
  ctx.fillStyle = stroke;
  ctx.font = '8px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.fillText('IRL540N', (gx + ex) / 2, span + 11);
  ctx.restore();
}
