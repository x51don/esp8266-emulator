/**
 * The schematic canvas: owns the viewport, pointer interaction state and the
 * rAF loop. React state is only touched for things the DOM chrome needs
 * (selection count, faults); the 60 fps path is imperative.
 */

import { useEffect, useMemo, useRef } from 'react';
import { Esp8266Machine } from '../../core/machine';
import { nearestPin, polylineHit } from '../canvas/hit';
import { renderScene } from '../canvas/renderer';
import { snapToGrid } from '../canvas/grid';
import type { Schematic, TerminalRef } from '../canvas/schematic';
import { SimDriver } from '../sim/driver';
import { Viewport, type Pt } from '../canvas/viewport';

export interface CanvasHandles {
  viewport: Viewport;
  fitTo: () => void;
}

/** Native dialogs can be silenced for automation. */
export function confirmOr(msg: string): boolean {
  if ((window as unknown as Record<string, unknown>).__noConfirm) return true;
  return window.confirm(msg);
}

interface Props {
  schematic: Schematic;
  machine: Esp8266Machine;
  running: boolean;
  speed: number;
  boardId: string;
  onEdit: () => void; // schematic changed -> App re-syncs netlist + persists
  onConfigure: (id: string) => void; // dbl-click a component -> properties
  api: React.MutableRefObject<CanvasHandles | null>;
}

type Tool =
  | { kind: 'idle' }
  | { kind: 'pan'; lastX: number; lastY: number }
  | { kind: 'move'; ids: string[]; startWorld: Pt; startPos: Map<string, Pt> }
  | { kind: 'wire'; from: TerminalRef; cursor: Pt }
  | { kind: 'tune'; id: string }
  | {
      kind: 'seg';
      id: string;
      path: Pt[];
      i: number;
      axis: 'x' | 'y';
      start: number;
    };

const TUNABLE = new Set(['pot', 'ldr', 'dht', 'hcsr']);

export function SchematicCanvas({ schematic, machine, running, speed, boardId, onEdit, onConfigure, api }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const vpRef = useRef(new Viewport());
  // one driver per machine instance: the App recreates the machine on board
  // switch, and a stale driver would pump a dead simulation.
  const driver = useMemo(() => new SimDriver(machine, { speed }), [machine]); // eslint-disable-line react-hooks/exhaustive-deps
  const driverRef = useRef<SimDriver>(driver);
  driverRef.current = driver;
  const toolRef = useRef<Tool>({ kind: 'idle' });
  const hoverPinRef = useRef<TerminalRef | null>(null);
  const selectionRef = useRef<Set<string>>(new Set());
  const runningRef = useRef(running);
  runningRef.current = running;

  // ---- handle for the App (zoom to fit etc.) ----
  useEffect(() => {
    api.current = {
      viewport: vpRef.current,
      fitTo: () => {
        const el = canvasRef.current;
        if (!el) return;
        vpRef.current.fit(schematic.bounds(), el.clientWidth, el.clientHeight, 60, 1.15);
      },
    };
    return () => {
      api.current = null;
    };
  }, [schematic, api]);

  // ---- run/stop drives the sim driver ----
  useEffect(() => {
    driverRef.current.speed = speed;
  }, [speed, running]);
  useEffect(() => {
    if (running) driverRef.current.start();
    else driverRef.current.stop();
  }, [running]);

  // ---- render + interaction loop ----
  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    let raf = 0;

    const resize = (): void => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
    };

    let lastMs = -1;
    const frame = (nowMs: number): void => {
      resize();
      if (lastMs >= 0 && runningRef.current) driverRef.current.frame(nowMs - lastMs);
      lastMs = nowMs;
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const tool = toolRef.current;
      renderScene(ctx, {
        schematic,
        viewport: vpRef.current,
        width: canvas.clientWidth,
        height: canvas.clientHeight,
        circuit: runningRef.current ? machine.circuit() : null,
        running: runningRef.current,
        selection: selectionRef.current,
        hoverPin: hoverPinRef.current,
        dragWire:
          tool.kind === 'wire'
            ? { from: tool.from, cursor: tool.cursor }
            : null,
        machine: runningRef.current ? machine : null,
      });
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [schematic, machine]);

  // ---- pointer helpers ----
  const toWorld = (e: React.PointerEvent): Pt => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return vpRef.current.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
  };

  const pinsForHit = () =>
    schematic.allPinWorlds().map((p) => ({ id: `${p.comp}.${p.pin}`, x: p.x, y: p.y }));

  const findPin = (w: Pt): TerminalRef | null => {
    const radius = Math.max(8, 10 / vpRef.current.zoom);
    const hit = nearestPin(pinsForHit(), w, radius);
    if (hit === null) return null;
    const dot = hit.indexOf('.');
    return { comp: hit.slice(0, dot), pin: hit.slice(dot + 1) };
  };

  const findComponent = (w: Pt): string | null => {
    // topmost = last added wins
    const ids = [...schematic.components.keys()].reverse();
    for (const id of ids) {
      const c = schematic.component(id)!;
      const b = schematic.bodyRect(c);
      if (w.x >= b.x && w.x < b.x + b.w && w.y >= b.y && w.y < b.y + b.h) return id;
    }
    return null;
  };

  /** Wire whose routed polyline passes near w (double-click to remove). */
  const findWire = (w: Pt): string | null => {
    const tol = 6 / vpRef.current.zoom;
    for (const wire of schematic.wires.values()) {
      const path = schematic.wireRoutes().get(wire.id);
      if (!path) continue;
      if (polylineHit(path, w, tol)) return wire.id;
    }
    return null;
  };

  /** nearest wire segment under the cursor, for manual-route dragging */
  const findWireSeg = (w: Pt): { id: string; i: number; path: Pt[] } | null => {
    const tol = 6 / vpRef.current.zoom;
    let best: { id: string; i: number; path: Pt[]; d: number } | null = null;
    const dist = (p: Pt, a: Pt, b: Pt): number => {
      const vx = b.x - a.x;
      const vy = b.y - a.y;
      const len2 = vx * vx + vy * vy || 1;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2));
      return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
    };
    for (const wire of schematic.wires.values()) {
      const path = schematic.wireRoutes().get(wire.id);
      if (!path) continue;
      for (let i = 0; i + 1 < path.length; i++) {
        const d = dist(w, path[i], path[i + 1]);
        if (d <= tol && (!best || d < best.d)) best = { id: wire.id, i, path, d };
      }
    }
    return best;
  };

  // dbl-click a wire -> confirm -> remove just that wire
  const onDoubleClick = (e: React.MouseEvent): void => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const w = vpRef.current.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    const id = findWire(w);
    if (id) {
      if (!confirmOr('Remove this wire?')) return;
      schematic.removeWire(id);
      onEdit();
      return;
    }
    const comp = findComponent(w);
    if (comp) onConfigure(comp);
  };

  // ---- events ----
  const onPointerDown = (e: React.PointerEvent): void => {
    try {
      (e.target as Element).setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointers (automation) have no capture handle */
    }
    const w = toWorld(e);

    // running buttons: momentary press
    if (runningRef.current) {
      const id = findComponent(w);
      if (id && TUNABLE.has(schematic.component(id)!.type)) {
        toolRef.current = { kind: 'tune', id };
        applyTune(id, w);
        return;
      }
      if (id && schematic.component(id)!.type === 'button') {
        machine.press(id, true);
        const release = (): void => {
          machine.press(id, false);
          window.removeEventListener('pointerup', release);
        };
        window.addEventListener('pointerup', release);
        return;
      }
    }

    const pin = findPin(w);
    if (pin && !runningRef.current) {
      toolRef.current = { kind: 'wire', from: pin, cursor: snapToGrid(w, 10) };
      return;
    }
    const id = findComponent(w);
    if (id && !runningRef.current) {
      if (e.shiftKey) {
        if (selectionRef.current.has(id)) selectionRef.current.delete(id);
        else selectionRef.current.add(id);
      } else if (!selectionRef.current.has(id)) {
        selectionRef.current = new Set([id]);
      }
      const startPos = new Map<string, Pt>();
      for (const sid of selectionRef.current) {
        const c = schematic.component(sid)!;
        startPos.set(sid, { x: c.x, y: c.y });
      }
      toolRef.current = { kind: 'move', ids: [...selectionRef.current], startWorld: w, startPos };
      return;
    }
    // alt+click a wire: drop its manual route, back to auto
    if (e.altKey) {
      const hit = findWireSeg(w);
      if (hit) {
        schematic.clearWirePath(hit.id);
        onEdit();
        return;
      }
    }
    // drag a wire segment sideways: pin a manual route onto the wire
    const seg = findWireSeg(w);
    if (seg) {
      const p = seg.path[seg.i];
      const q = seg.path[seg.i + 1];
      const vertical = p.x === q.x;
      toolRef.current = {
        kind: 'seg', id: seg.id, path: seg.path.map((pt) => ({ x: pt.x, y: pt.y })),
        i: seg.i, axis: vertical ? 'x' : 'y', start: vertical ? w.x : w.y,
      };
      return;
    }
    selectionRef.current = runningRef.current ? selectionRef.current : new Set();
    toolRef.current = { kind: 'pan', lastX: e.clientX, lastY: e.clientY };
  };

  const onPointerMove = (e: React.PointerEvent): void => {
    const w = toWorld(e);
    const tool = toolRef.current;
    if (tool.kind === 'pan') {
      vpRef.current.panBy(e.clientX - tool.lastX, e.clientY - tool.lastY);
      tool.lastX = e.clientX;
      tool.lastY = e.clientY;
    } else if (tool.kind === 'wire') {
      tool.cursor = snapToGrid(w, 10);
      hoverPinRef.current = findPin(w);
    } else if (tool.kind === 'seg') {
      const delta = snapToGrid({ x: w.x - tool.start, y: w.y - tool.start }, 10);
      const d = tool.axis === 'x' ? delta.x : delta.y;
      const pts = tool.path.map((pt) => ({ x: pt.x, y: pt.y }));
      const a = pts[tool.i];
      const b = pts[tool.i + 1];
      if (tool.axis === 'x') {
        const base = tool.path[tool.i].x;
        a.x = base + d;
        b.x = base + d;
      } else {
        const base = tool.path[tool.i].y;
        a.y = base + d;
        b.y = base + d;
      }
      // keep shifted terminal points as waypoints: the wire leaves the pin
      // and jumps to the dragged segment instead of the pin moving
      const same = (p1: Pt, p2: Pt): boolean => p1.x === p2.x && p1.y === p2.y;
      const custom = pts.slice(1, pts.length - 1);
      if (!same(pts[0], tool.path[0])) custom.unshift(pts[0]);
      const lastP = pts[pts.length - 1];
      if (!same(lastP, tool.path[tool.path.length - 1])) custom.push(lastP);
      schematic.setWirePath(tool.id, custom);
    } else if (tool.kind === 'tune') {
      applyTune(tool.id, w);
    } else if (tool.kind === 'move') {
      const dx = w.x - tool.startWorld.x;
      const dy = w.y - tool.startWorld.y;
      for (const id of tool.ids) {
        const start = tool.startPos.get(id)!;
        const snapped = snapToGrid({ x: start.x + dx, y: start.y + dy }, 10);
        schematic.move(id, snapped.x, snapped.y);
      }
    } else {
      hoverPinRef.current = findPin(w);
    }
  };

  /** Drag-to-value on sensor bodies while the machine runs. */
  const applyTune = (id: string, w: Pt): void => {
    const c = schematic.component(id);
    if (!c) return;
    const b = schematic.bodyRect(c);
    const fx = Math.min(1, Math.max(0, (w.x - b.x) / b.w));
    const fy = Math.min(1, Math.max(0, (w.y - b.y) / b.h));
    if (c.type === 'pot') schematic.setParam(id, 'ratio', Math.round(fx * 100) / 100);
    else if (c.type === 'ldr') schematic.setParam(id, 'lux', Math.round(Math.pow(10, 1 + 4 * fx)));
    else if (c.type === 'hcsr') schematic.setParam(id, 'cm', Math.round(2 + 398 * fx));
    else if (c.type === 'dht') {
      schematic.setParam(id, 'tempC', Math.round(50 * fx * 2) / 2);
      schematic.setParam(id, 'humPct', Math.round(100 - 90 * fy));
    }
    // push into the live netlist so sketches see the value right away
    machine.netlist.addComponent(id, c.type, c.params);
  };

  const onPointerUp = (): void => {
    const tool = toolRef.current;
    if (tool.kind === 'wire') {
      const target = findPin(tool.cursor);
      if (target && (target.comp !== tool.from.comp || target.pin !== tool.from.pin)) {
        try {
          schematic.wire(tool.from, target);
          onEdit();
        } catch {
          /* duplicate wire: ignore the second attempt */
        }
      }
    } else if (tool.kind === 'move' || tool.kind === 'tune' || tool.kind === 'seg') {
      onEdit();
    }
    toolRef.current = { kind: 'idle' };
  };

  useEffect(() => {
    const canvas = canvasRef.current!;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      vpRef.current.zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - rect.left, e.clientY - rect.top);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);

  // keyboard: delete/rotate work whenever the canvas host has focus-ish
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement).isContentEditable) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const sel = [...selectionRef.current];
        if (sel.length === 0) return;
        let wires = 0;
        for (const w of schematic.wires.values())
          if (sel.includes(w.a.comp) || sel.includes(w.b.comp)) wires++;
        const msg = `Remove ${sel.length} component(s)` + (wires ? ` and ${wires} connected wire(s)` : '') + '?';
        if (!confirmOr(msg)) return;
        for (const id of sel) schematic.remove(id);
        selectionRef.current = new Set();
        onEdit();
      } else if (e.key === 'r' || e.key === 'R') {
        for (const id of selectionRef.current) schematic.rotate(id);
        if (selectionRef.current.size) onEdit();
      } else if (e.key === 'Escape') {
        toolRef.current = { kind: 'idle' };
        selectionRef.current = new Set();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [schematic, onEdit]);

  // palette drop
  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault();
    const type = e.dataTransfer.getData('application/x-component');
    if (!type) return;
    const rect = canvasRef.current!.getBoundingClientRect();
    const world = vpRef.current.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    const snapped = snapToGrid(world, 10);
    const defaults: Record<string, Record<string, unknown>> = {
      led: { resistance: 220, forwardV: 2, color: 'amber' },
      resistor: { resistance: 220 },
      button: {},
      buzzer: {},
      battery: { volts: 9 },
      pot: { ratio: 0.5 },
      ldr: { lux: 300 },
      cap: { uf: 100 },
      dht: { model: 'DHT22', tempC: 23.5, humPct: 61 },
      servo: {},
      relay: {},
      oled: { addr: 0x3c },
      neopixel: { count: 8 },
      hcsr: { cm: 20 },
    };
    try {
      if (type === 'board') {
        // exactly one board per document: drop re-places it, or adds it back
        // after a delete
        const existing = schematic.boardComponent();
        if (existing) schematic.move(existing.id, snapped.x, snapped.y);
        else schematic.addBoard(boardId, snapped.x, snapped.y);
        onEdit();
        return;
      }
      const params = { ...(defaults[type] ?? {}) };
      if (type === 'led') {
        // LED ships with a series resistor baked into the symbol params;
        // the netlist models the LED itself, so drop a resistor beside it.
        schematic.add(type, snapped.x, snapped.y, { forwardV: params.forwardV });
        const r = schematic.add('resistor', snapped.x - 40, snapped.y, { resistance: params.resistance });
        const last = [...schematic.components.keys()].at(-1)!;
        schematic.wire({ comp: last, pin: 'k' }, { comp: r.id, pin: 'p2' });
      } else {
        schematic.add(type, snapped.x, snapped.y, params);
      }
      onEdit();
    } catch {
      /* invalid type dropped: ignore */
    }
  };

  return (
    <div ref={hostRef} className="canvas-host" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={onDoubleClick}
      />
    </div>
  );
}
