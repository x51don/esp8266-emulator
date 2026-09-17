/**
 * The schematic canvas: owns the viewport, pointer interaction state and the
 * rAF loop. React state is only touched for things the DOM chrome needs
 * (selection count, faults); the 60 fps path is imperative.
 */

import { useEffect, useRef } from 'react';
import { Esp8266Machine } from '../../core/machine';
import { nearestPin } from '../canvas/hit';
import { renderScene } from '../canvas/renderer';
import { snapToGrid } from '../canvas/grid';
import type { Schematic, TerminalRef } from '../canvas/schematic';
import { SimDriver } from '../sim/driver';
import { Viewport, type Pt } from '../canvas/viewport';

export interface CanvasHandles {
  viewport: Viewport;
  fitTo: () => void;
}

interface Props {
  schematic: Schematic;
  machine: Esp8266Machine;
  running: boolean;
  speed: number;
  onEdit: () => void; // schematic changed -> App re-syncs netlist + persists
  api: React.MutableRefObject<CanvasHandles | null>;
}

type Tool =
  | { kind: 'idle' }
  | { kind: 'pan'; lastX: number; lastY: number }
  | { kind: 'move'; ids: string[]; startWorld: Pt; startPos: Map<string, Pt> }
  | { kind: 'wire'; from: TerminalRef; cursor: Pt };

export function SchematicCanvas({ schematic, machine, running, speed, onEdit, api }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const vpRef = useRef(new Viewport());
  const driverRef = useRef(new SimDriver(machine, { speed }));
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
        vpRef.current.fit(schematic.bounds(), el.clientWidth, el.clientHeight, 60);
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

  // ---- events ----
  const onPointerDown = (e: React.PointerEvent): void => {
    (e.target as Element).setPointerCapture(e.pointerId);
    const w = toWorld(e);

    // running buttons: momentary press
    if (runningRef.current) {
      const id = findComponent(w);
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
    } else if (tool.kind === 'move') {
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
        if (selectionRef.current.size === 0) return;
        for (const id of selectionRef.current) schematic.remove(id);
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
    };
    try {
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
      />
    </div>
  );
}
