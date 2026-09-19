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
/** Output resistance of a UI "force" editor (P3.1). */
const FORCE_R = 10_000;
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
  /** P3.4: voltage across each capacitor plate pair (p1 referenced to p2). */
  private capV = new Map<string, number>();
  /** Virtual parts (force editors) that survive clear() and re-attach. */
  private pinned: Array<{ id: string; type: string; params: Record<string, unknown>; wireTo: string }> = [];
  /** Monotonic topology/param mutation counter for cached circuit solves. */
  version = 0;

  constructor(private readonly gpio: GpioBus) {}

  addComponent(id: string, type: string, params: Record<string, unknown> = {}): void {
    this.comps.set(id, { id, type, params });
    if (type === 'button') this.switches.set(id, false);
    this.version++;
  }

  /** Drop every component, wire and switch (used on document re-sync). */
  clear(): void {
    const had = this.comps.size || this.wires.size || this.switches.size;
    this.comps.clear();
    this.wires.clear();
    this.switches.clear();
    if (had) this.version++;
    this.reattachPinned();
  }

  /**
   * P3.4: exponential RC relaxation of every capacitor toward the Thevenin
   * equivalent of the network around its p1 plate, tau = R_th * C
   * (ohms x microfarads = microseconds). dtUs is real virtual time.
   */
  advanceTime(dtUs: number): void {
    if (dtUs <= 0) return;
    for (const c of this.comps.values()) {
      if (c.type !== 'cap') continue;
      const uf = Number(c.params.uf ?? 100);
      if (!(uf > 0) || !(dtUs > 0)) continue;
      const plate = term(c.id, 'p1');
      let g = 0;
      let iv = 0;
      for (const s of this.reachSources(plate)) {
        // the cap's own plate source is what we are relaxing - not its target
        if (s.at.startsWith(`${c.id}.`)) continue;
        if (s.r <= 0 || s.r >= 1e11) continue; // ideal wire or no path
        g += 1 / s.r;
        iv += s.src.v / s.r;
      }
      if (g === 0) continue; // floating: the charge holds
      const vTh = iv / g;
      const tauUs = uf / g; // (1/R) * C  in  us
      const v0 = this.capV.get(c.id) ?? 0;
      const v1 = vTh + (v0 - vTh) * Math.E ** (-dtUs / tauUs);
      if (Math.abs(v1 - v0) > 1e-9) {
        this.capV.set(c.id, v1);
        this.version++; // cached solves must see the moving plate
      }
    }
  }

  /** Discharge every capacitor (machine reset). */
  resetCapacitors(): void {
    if (this.capV.size) {
      this.capV.clear();
      this.version++;
    }
  }

  /**
   * Pin a virtual voltage source (type 'force') onto a terminal. It survives
   * clear(), so document resyncs keep the bias in place. volts=null removes
   * it. The source is weak (FORCE_R), so it never fights a real driver.
   */
  pinForce(id: string, volts: number | null, to: string): void {
    this.pinned = this.pinned.filter((p) => p.id !== id);
    if (volts !== null) this.pinned.push({ id, type: 'force', params: { v: volts }, wireTo: to });
    this.comps.delete(id);
    for (const [wid, w] of this.wires)
      if (w.a.startsWith(`${id}.`) || w.b.startsWith(`${id}.`)) this.wires.delete(wid);
    this.version++;
    this.reattachPinned();
  }

  private reattachPinned(): void {
    for (const p of this.pinned) {
      this.comps.set(p.id, { id: p.id, type: p.type, params: p.params });
      this.wires.set(`w${++this.wireSeq}`, { id: `w${this.wireSeq}`, a: `${p.id}.out`, b: p.wireTo });
    }
    if (this.pinned.length) this.version++;
  }

  removeComponent(id: string): void {
    const had = this.comps.delete(id);
    this.switches.delete(id);
    for (const [wid, w] of this.wires) {
      if (w.a.startsWith(`${id}.`) || w.b.startsWith(`${id}.`)) this.wires.delete(wid);
    }
    if (had) this.version++;
  }

  addWire(a: string, b: string): string {
    const id = `w${++this.wireSeq}`;
    this.wires.set(id, { id, a, b });
    this.version++;
    return id;
  }

  removeWire(id: string): void {
    if (this.wires.delete(id)) this.version++;
  }

  setSwitchState(compId: string, closed: boolean): void {
    if (this.switches.get(compId) === closed) return; // electrical no-op
    this.switches.set(compId, closed);
    this.version++;
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
      } else if (c.type === 'pot') {
        // 10k element; ratio 0 => wiper at p2, 1 => at p1.
        const r = 10_000;
        const ratio = Math.min(1, Math.max(0, Number(c.params.ratio ?? 0.5)));
        if (term(c.id, 'p1') === t) out.push([term(c.id, 'w'), Math.max(1, (1 - ratio) * r)]);
        else if (term(c.id, 'p2') === t) out.push([term(c.id, 'w'), Math.max(1, ratio * r)]);
        else if (term(c.id, 'w') === t) {
          out.push([term(c.id, 'p1'), Math.max(1, (1 - ratio) * r)]);
          out.push([term(c.id, 'p2'), Math.max(1, ratio * r)]);
        }
      } else if (c.type === 'relay') {
        // 150-ohm coil; contacts follow coil power (NC without power).
        if (term(c.id, 'coilp') === t) out.push([term(c.id, 'coiln'), 150]);
        else if (term(c.id, 'coiln') === t) out.push([term(c.id, 'coilp'), 150]);
        else {
          const [x, y] = this.coilEnergized(c) ? ['sw', 'no'] : ['sw', 'nc'];
          if (term(c.id, x) === t) out.push([term(c.id, y), 0]);
          else if (term(c.id, y) === t) out.push([term(c.id, x), 0]);
        }
      } else if (c.type === 'ldr') {
        const r = ldrOhms(Number(c.params.lux ?? 1000));
        if (term(c.id, 'p1') === t) out.push([term(c.id, 'p2'), r]);
        else if (term(c.id, 'p2') === t) out.push([term(c.id, 'p1'), r]);
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
    if (comp.type === 'cap') {
      // P3.4: a charged capacitor acts as a voltage source on its p1 plate
      // (p2 is the reference; keep it at GND in the schematic). rInternal 1
      // models an uncharged cap as a short at t=0 and charges smoothly.
      return pin === 'p1'
        ? { v: this.capV.get(comp.id) ?? 0, rInternal: 1, strong: false, duty: 1 }
        : null;
    }
    if (comp.type === 'force') {
      // P3.1 analog force editor: a bench supply behind 10k - it biases the
      // node but a real strong driver always wins the divider, so forcing a
      // pin that something already drives never faults.
      return pin === 'out'
        ? { v: Number(comp.params.v ?? 0), rInternal: FORCE_R, strong: false, duty: 1 }
        : null;
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
  private reachSources(from: string): Array<{ src: Source; r: number; at: string }> {
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
    const out: Array<{ src: Source; r: number; at: string }> = [];
    for (const [t, r] of dist) {
      const src = this.sourceAt(t);
      if (src) out.push({ src, r: r + src.rInternal, at: t });
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

  /** True when both terminals join through wires / closed switches. */
  sameNet(a: string, b: string): boolean {
    try {
      return this.netOf(a) === this.netOf(b);
    } catch {
      return false;
    }
  }

  componentsOfType(type: string): ComponentDef[] {
    return [...this.comps.values()].filter((c) => c.type === type);
  }

  private coilGuard = new Set<string>();

  /** Relay coil: a >2V source on coilp and a GND path on coiln energize it. */
  private coilEnergized(c: ComponentDef): boolean {
    if (this.coilGuard.has(c.id)) return false; // re-entrant: assume released
    this.coilGuard.add(c.id);
    try {
      const hi = this.bestSource(term(c.id, 'coilp'));
      if (!hi || hi.src.v < 2 || hi.r > 100_000) return false;
      const lo = this.bestSink(term(c.id, 'coiln'));
      return !!lo && lo.src.v <= 1.65 && lo.r <= 100_000;
    } finally {
      this.coilGuard.delete(c.id);
    }
  }

  /**
   * Voltage a high-impedance ADC input would see at this terminal:
   * Thevenin blend of the strongest source and sink with their path
   * resistances (works for pot wipers and resistor/LDR dividers).
   * Null when the node floats.
   */
  analogVolts(t: string): number | null {
    // Exact multi-source Thevenin: parallel conductance weighting. Sources
    // behind huge resistances fade out naturally (r -> inf contributes 0),
    // an ideal r=0 rail wins outright.
    const list = this.reachSources(t);
    if (!list.length) return null;
    const EPS = 1e-9;
    let g = 0;
    let iv = 0;
    for (const s of list) {
      const gg = 1 / Math.max(s.r, EPS);
      g += gg;
      iv += s.src.v * gg;
    }
    return g === 0 ? null : iv / g;
  }

  private pinsOf(c: ComponentDef): string[] {
    if (Array.isArray(c.params.pins)) return c.params.pins as string[];
    switch (c.type) {
      case 'resistor': return ['p1', 'p2'];
      case 'led': return ['a', 'k'];
      case 'button': return ['p1', 'p2'];
      case 'buzzer': return ['+', '-'];
      case 'pot': return ['p1', 'w', 'p2'];
      case 'ldr': return ['p1', 'p2'];
      case 'cap': return ['p1', 'p2']; // open at logic level (documented)
      case 'force': return ['out']; // virtual bench supply (P3.1)
      case 'dht': return ['vcc', 'data', 'gnd'];
      case 'hcsr': return ['vcc', 'trig', 'echo', 'gnd'];
      case 'servo': return ['sig', 'vcc', 'gnd'];
      case 'relay': return ['coilp', 'coiln', 'sw', 'no', 'nc'];
      case 'oled': return ['vcc', 'gnd', 'sda', 'scl'];
      case 'neopixel': return ['din', 'vcc', 'gnd'];
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


/** CdS photoresistor curve: ~1M in the dark, ~2k in sunlight. */
export function ldrOhms(lux: number): number {
  const l = Math.max(1, lux);
  return Math.min(1_000_000, Math.max(500, Math.round(1_000_000 / Math.pow(l, 0.7))));
}
