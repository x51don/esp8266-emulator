/**
 * Circuit solver for the virtual breadboard.
 *
 * Electrical model (digital-ish, not SPICE):
 * - wires and closed buttons are 0-ohm links; resistors conduct with R;
 * - voltage sources: rails (GND/3V3/5V) and MCU pins pushing out; weak-high
 *   is an INPUT_PULLUP (30k). LED/buzzer pins are endpoints (current stops);
 * - for every terminal we find the best reachable source (max voltage, then
 *   min path resistance) - enough for the tree-shaped circuits users draw;
 * - an LED conducts when source(anode) - sink(cathode) exceeds Vf; current is
 *   Ohm's law over the total path resistance. No resistance => "burnt";
 * - a net (DSU over 0-ohm links) carries one logic level for wire coloring;
 * - strong sources with different voltages on one net => short/contention.
 */

import { getBoard } from '../core/boards';
import type { GpioBus, DriveState } from './gpio';

export interface ComponentDef {
  id: string;
  type: 'mcu' | 'resistor' | 'led' | 'button' | 'buzzer' | (string & {});
  params: Record<string, unknown>;
}

interface Wire {
  id: string;
  a: string; // terminal id `${compId}.${pin}`
  b: string;
}

interface Source {
  v: number;        // volts
  rInternal: number;
  strong: boolean;
  duty: number;     // 1 for static, <1 for PWM (scales LED current)
  rail?: string;    // rail name when this source is a power rail
}

export interface LedState {
  on: boolean;
  burnt: boolean;
  currentMa: number;
  brightness: number; // 0..1, duty-averaged
}

export interface Fault {
  kind: 'short' | 'contention';
  message: string;
  net: string;
}

export interface ResolveResult {
  leds: Map<string, LedState>;
  /** logic level every MCU signal pin sees (what digitalRead() will return) */
  pinLevels: Map<string, 0 | 1>;
  /** levels imposed on MCU pins by OTHER drivers only (for the GPIO bus) */
  externals: Map<string, 0 | 1>;
  faults: Fault[];
  netOf: Map<string, string>;
  netVoltage: Map<string, number>;
}

const PULLUP_R = 30_000;
const VF_DEFAULT = 2;
const ON_MA = 0.05;
const BURN_MA = 50;
const RAIL_V: Record<string, number> = { GND: 0, '3V3': 3.3, '5V': 5, VIN: 5, '3.3V': 3.3 };

const term = (compId: string, pin: string) => `${compId}.${pin}`;

export class Netlist {
  private comps = new Map<string, ComponentDef>();
  private wires = new Map<string, Wire>();
  private switches = new Map<string, boolean>();
  private wireSeq = 0;

  constructor(private readonly gpio: GpioBus) {}

  addComponent(id: string, type: string, params: Record<string, unknown> = {}): void {
    this.comps.set(id, { id, type, params });
    if (type === 'button') this.switches.set(id, false);
  }

  removeComponent(id: string): void {
    this.comps.delete(id);
    this.switches.delete(id);
    for (const [wid, w] of this.wires) {
      if (w.a.startsWith(`${id}.`) || w.b.startsWith(`${id}.`)) this.wires.delete(wid);
    }
  }

  addWire(a: string, b: string): string {
    const id = `w${++this.wireSeq}`;
    this.wires.set(id, { id, a, b });
    return id;
  }

  removeWire(id: string): void {
    this.wires.delete(id);
  }

  setSwitchState(compId: string, closed: boolean): void {
    this.switches.set(compId, closed);
  }

  isSwitchClosed(compId: string): boolean {
    return this.switches.get(compId) ?? false;
  }

  /** 0-ohm connectivity root for a terminal (wire coloring). Cheap DSU. */
  netOf(t: string): string {
    let root = t;
    const seen = new Set<string>();
    const stack = [t];
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      if (cur < root) root = cur; // canonical id = lexicographic min terminal
      for (const [to, r] of this.links(cur)) if (r === 0 && to !== cur) stack.push(to);
    }
    return root;
  }

  /** Conductive links out of a terminal: wires, resistors, closed buttons. */
  private links(t: string): Array<[string, number]> {
    const out: Array<[string, number]> = [];
    for (const w of this.wires.values()) {
      if (w.a === t) out.push([w.b, 0]);
      else if (w.b === t) out.push([w.a, 0]);
    }
    for (const c of this.comps.values()) {
      if (c.type === 'resistor') {
        const r = Number(c.params.resistance ?? 220);
        if (term(c.id, 'p1') === t) out.push([term(c.id, 'p2'), r]);
        else if (term(c.id, 'p2') === t) out.push([term(c.id, 'p1'), r]);
      } else if (c.type === 'button' && this.isSwitchClosed(c.id)) {
        if (term(c.id, 'p1') === t) out.push([term(c.id, 'p2'), 0]);
        else if (term(c.id, 'p2') === t) out.push([term(c.id, 'p1'), 0]);
      }
    }
    return out;
  }

  /** Voltage sources seen at a terminal (rails + MCU pin drivers). */
  private sourceAt(t: string): Source | null {
    const dot = t.lastIndexOf('.');
    const comp = this.comps.get(t.slice(0, dot));
    if (!comp) return null;
    const pin = t.slice(dot + 1);
    if (comp.type === 'mcu') {
      if (pin in RAIL_V) {
        return { v: RAIL_V[pin], rInternal: 0, strong: true, duty: 1, rail: pin };
      }
      const board = getBoard(String(comp.params.board ?? 'wemos-d1-mini'));
      const gpio = board.gpioFor(pin);
      if (gpio === null || gpio === undefined) return null;
      return pinSource(this.gpio, gpio);
    }
    if (comp.type === 'battery') {
      const v = Number(comp.params.volts ?? 9);
      return pin === '+' ? { v, rInternal: 0, strong: true, duty: 1 } : { v: 0, rInternal: 0, strong: true, duty: 1 };
    }
    return null;
  }

  /**
   * All reachable ideal sources with their min path resistance (Dijkstra over
   * conductive links; LED/buzzer terminals are searched TO, never through).
   */
  private reachSources(from: string): Array<{ src: Source; r: number }> {
    const dist = new Map<string, number>();
    dist.set(from, 0);
    const open: Array<{ t: string; r: number }> = [{ t: from, r: 0 }];
    while (open.length) {
      open.sort((a, b) => a.r - b.r);
      const { t, r } = open.shift()!;
      if ((dist.get(t) ?? Infinity) < r) continue;
      const dot = t.lastIndexOf('.');
      const comp = this.comps.get(t.slice(0, dot));
      if (comp && (comp.type === 'led' || comp.type === 'buzzer') && t !== from) continue;
      for (const [to, res] of this.links(t)) {
        const nr = r + res;
        if ((dist.get(to) ?? Infinity) <= nr) continue;
        dist.set(to, nr);
        open.push({ t: to, r: nr });
      }
    }
    const out: Array<{ src: Source; r: number }> = [];
    for (const [t, r] of dist) {
      const src = this.sourceAt(t);
      if (src) out.push({ src, r: r + src.rInternal });
    }
    return out;
  }

  /** Highest-voltage source (ties: lowest resistance). */
  private bestSource(from: string): { src: Source; r: number } | null {
    const list = this.reachSources(from).filter((s) => s.src.v > 1.65);
    if (!list.length) return null;
    list.sort((a, b) => b.src.v - a.src.v || a.r - b.r);
    return list[0];
  }

  /** Lowest-voltage sink (GND-like). */
  private bestSink(from: string): { src: Source; r: number } | null {
    const list = this.reachSources(from).filter((s) => s.src.v < 1.65);
    if (!list.length) return null;
    list.sort((a, b) => b.src.v - a.src.v || a.r - b.r);
    return list[0];
  }

  resolve(): ResolveResult {
    const leds = new Map<string, LedState>();
    const pinLevels = new Map<string, 0 | 1>();
    const externals = new Map<string, 0 | 1>();
    const faults: Fault[] = [];
    const netOf = new Map<string, string>();
    const netVoltage = new Map<string, number>();

    // --- LED currents ---
    for (const c of this.comps.values()) {
      if (c.type !== 'led') continue;
      const vf = Number(c.params.forwardV ?? VF_DEFAULT);
      const src = this.bestSource(term(c.id, 'a'));
      const snk = this.bestSink(term(c.id, 'k'));
      let state: LedState = { on: false, burnt: false, currentMa: 0, brightness: 0 };
      if (src && snk && src.src.v - snk.src.v - vf > 0.05) {
        const rTotal = src.r + snk.r;
        if (rTotal <= 0) {
          state = { on: true, burnt: true, currentMa: BURN_MA * 10, brightness: 1 };
        } else {
          const duty = src.src.duty;
          const iMa = (((src.src.v - snk.src.v - vf) / rTotal) * 1000) * duty;
          state = {
            on: iMa >= ON_MA,
            burnt: iMa > BURN_MA,
            currentMa: iMa,
            brightness: Math.min(1, iMa / 20),
          };
        }
      }
      leds.set(c.id, state);
    }

    // --- net levels, MCU pin reads, shorts ---
    const netSources = new Map<string, Array<Source & { at: string }>>();
    const terminals = new Set<string>();
    for (const c of this.comps.values()) {
      const pins = this.pinsOf(c);
      for (const p of pins) {
        const t = term(c.id, p);
        terminals.add(t);
        const net = this.netOf(t);
        netOf.set(t, net);
        const src = this.sourceAt(t);
        if (src) {
          const list = netSources.get(net) ?? [];
          list.push({ ...src, at: t });
          netSources.set(net, list);
        }
      }
    }
    for (const [net, list] of netSources) {
      const strongs = list.filter((s) => s.strong);
      const levels = new Set(strongs.map((s) => s.v > 1.65));
      if (strongs.length && levels.size > 1) {
        const railHit = strongs.find((s) => s.rail);
        faults.push({
          kind: railHit ? 'short' : 'contention',
          net,
          message: railHit
            ? `An output pin is shorted to the ${railHit.rail} rail`
            : 'Two outputs are fighting on the same net',
        });
      }
      const rep = strongs[0] ?? list[0];
      netVoltage.set(net, rep ? rep.v : 0);
    }
    for (const c of this.comps.values()) {
      if (c.type !== 'mcu') continue;
      for (const p of this.pinsOf(c)) {
        if (p in RAIL_V) continue;
        const t = term(c.id, p);
        const list = netSources.get(netOf.get(t)!) ?? [];
        // Full view: a strong driver anywhere wins, else the pin's own
        // pull-up decides (that is exactly what digitalRead() sees).
        const pick = list.find((s) => s.strong) ?? list.find((s) => !s.strong);
        pinLevels.set(t, pick ? (pick.v > 1.65 ? 1 : 0) : 0);
        // External view: only OTHER strong drivers act on this pin.
        const other = list.find((s) => s.strong && s.at !== t);
        if (other) externals.set(t, other.v > 1.65 ? 1 : 0);
      }
    }

    return { leds, pinLevels, externals, faults, netOf, netVoltage };
  }

  private pinsOf(c: ComponentDef): string[] {
    if (Array.isArray(c.params.pins)) return c.params.pins as string[];
    switch (c.type) {
      case 'resistor': return ['p1', 'p2'];
      case 'led': return ['a', 'k'];
      case 'button': return ['p1', 'p2'];
      case 'buzzer': return ['+', '-'];
      default: return [];
    }
  }
}

function pinSource(bus: GpioBus, gpio: number): Source | null {
  const d: DriveState = bus.driveState(gpio);
  switch (d.kind) {
    case 'push':
      return { v: d.level === 1 ? 3.3 : 0, rInternal: 0, strong: true, duty: 1 };
    case 'weak-high':
      return { v: 3.3, rInternal: PULLUP_R, strong: false, duty: 1 };
    case 'pwm':
      return { v: 3.3, rInternal: 0, strong: true, duty: d.duty };
    default:
      return null;
  }
}

