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
  kind: 'short' | 'contention' | 'overcurrent' | 'warn';
  message: string;
  net: string;
}

export interface SemiState {
  on: boolean;
  burnt: boolean;
  /** 'fwd' conducting forward, 'rev' Zener breakdown, 'off' blocking */
  mode: 'fwd' | 'rev' | 'off';
  currentMa: number;
}

export interface ResolveResult {
  leds: Map<string, LedState>;
  /** diode / zener / transistor states (F15) */
  semis: Map<string, SemiState>;
  /** logic level every MCU signal pin sees (what digitalRead() will return) */
  pinLevels: Map<string, 0 | 1>;
  /** levels imposed on MCU pins by OTHER drivers only (for the GPIO bus) */
  externals: Map<string, 0 | 1>;
  /** F1.2: |mA| through each MCU GPIO (summed over every branch on the pin) */
  pinCurrent: Map<number, number>;
  /** F1.2: GPIOs a strong >3.6 V source drives (absolute-maximum violation) */
  overvoltPins: number[];
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
/** Series resistance of a conducting diode / saturated transistor link. */
const SEMI_R = 10;
const DIODE_VF = 0.7;
const VCE_SAT = 0.2;
const RAIL_V: Record<string, number> = { GND: 0, '3V3': 3.3, '5V': 5, VIN: 5, '3.3V': 3.3 };
/** F1.2 datasheet limits: per-GPIO source/sink, sum of all GPIOs, VDD+0.3. */
export const PIN_MAX_MA = 12.8;
export const PIN_TOTAL_MAX_MA = 48.8;
export const ABS_MAX_V = 3.6;

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
      } else if (c.type === 'diode' || c.type === 'zener') {
        // A biased junction is a small resistance in the conductive graph
        // (documented approximation: its voltage drop throttles current via
        // the total path resistance, not a KVL subtraction for others).
        const bias = this.semiBias(c);
        if (bias !== 'off') {
          if (term(c.id, 'a') === t) out.push([term(c.id, 'k'), SEMI_R]);
          else if (term(c.id, 'k') === t) out.push([term(c.id, 'a'), SEMI_R]);
        }
      } else if (c.type === 'transistor') {
        // Base-driven C-E switch: closed when the B-E junction is forward
        // biased (NPN) / E-B (PNP); base itself never conducts.
        if (this.semiBias(c) !== 'off') {
          if (term(c.id, 'c') === t) out.push([term(c.id, 'e'), SEMI_R]);
          else if (term(c.id, 'e') === t) out.push([term(c.id, 'c'), SEMI_R]);
        }
      } else if (c.type === 'mosfet') {
        // Enhancement-mode N-FET: the insulated gate charges no current, the
        // channel closes once V(GS) reaches the (logic-level) threshold.
        if (this.semiBias(c) !== 'off') {
          if (term(c.id, 'd') === t) out.push([term(c.id, 's'), SEMI_R]);
          else if (term(c.id, 's') === t) out.push([term(c.id, 'd'), SEMI_R]);
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
    const through = new Set<string>(); // cathode nets reached forward through a LED
    const open: Array<{ t: string; r: number }> = [{ t: from, r: 0 }];
    while (open.length) {
      open.sort((a, b) => a.r - b.r);
      const { t, r } = open.shift()!;
      if ((dist.get(t) ?? Infinity) < r) continue;
      const dot = t.lastIndexOf('.');
      const comp = this.comps.get(t.slice(0, dot));
      if (comp && (comp.type === 'led' || comp.type === 'buzzer') && t !== from && !through.has(t)) {
        // Endpoints are searched TO, never through - but entering at the
        // ANODE is the forward direction, so the cathode net stays visible
        // (lets a series diode / Zener feed a load behind it; the ~2 V drop
        // is deliberately not modelled, same fudge as every other junction).
        const pin = t.slice(dot + 1);
        const out = pin === (comp.type === 'led' ? 'a' : '+')
          ? term(comp.id, comp.type === 'led' ? 'k' : '-')
          : null;
        if (out) {
          through.add(out);
          const nr = r + 1;
          if ((dist.get(out) ?? Infinity) > nr) {
            dist.set(out, nr);
            open.push({ t: out, r: nr });
          }
        }
        continue;
      }
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
  private bestSource(from: string): { src: Source; r: number; at: string } | null {
    const list = this.reachSources(from).filter((s) => s.src.v > 1.65);
    if (!list.length) return null;
    list.sort((a, b) => b.src.v - a.src.v || a.r - b.r);
    return list[0];
  }

  /** Lowest-voltage sink (GND-like). */
  private bestSink(from: string): { src: Source; r: number; at: string } | null {
    const list = this.reachSources(from).filter((s) => s.src.v < 1.65);
    if (!list.length) return null;
    list.sort((a, b) => b.src.v - a.src.v || a.r - b.r);
    return list[0];
  }

  /** GPIO number when a terminal is an MCU signal pin (rails give null). */
  private gpioOf(t: string): number | null {
    const dot = t.lastIndexOf('.');
    if (dot < 0) return null;
    const comp = this.comps.get(t.slice(0, dot));
    if (!comp || comp.type !== 'mcu') return null;
    const pin = t.slice(dot + 1);
    if (pin in RAIL_V) return null;
    const board = getBoard(String(comp.params.board ?? 'wemos-d1-mini'));
    const g = board.gpioFor(pin);
    return g === null || g === undefined ? null : g;
  }

  /** F1.2: book branch current against the MCU pin sitting at a terminal. */
  private attribute(pinCurrent: Map<number, number>, t: string, mA: number): void {
    const g = this.gpioOf(t);
    if (g === null || mA <= 0) return;
    pinCurrent.set(g, (pinCurrent.get(g) ?? 0) + mA);
  }

  resolve(): ResolveResult {
    const leds = new Map<string, LedState>();
    const pinLevels = new Map<string, 0 | 1>();
    const externals = new Map<string, 0 | 1>();
    const pinCurrent = new Map<number, number>();
    const overvoltPins: number[] = [];
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
        // F1.2: the MCU pins at the ends of this branch carry the current
        this.attribute(pinCurrent, src.at, state.currentMa);
        this.attribute(pinCurrent, snk.at, state.currentMa);
      }
      leds.set(c.id, state);
    }

    // --- semiconductor states (F15) ---
    const semis = new Map<string, SemiState>();
    for (const c of this.comps.values()) {
      if (c.type !== 'diode' && c.type !== 'zener' && c.type !== 'transistor'
        && c.type !== 'mosfet') continue;
      const mode = this.semiBias(c);
      const state: SemiState = { on: mode !== 'off', burnt: false, mode, currentMa: 0 };
      if (state.on) {
        // current through the conducting junction: the far terminal pair,
        // probe WITHOUT the guard so the path resistance is counted
        let from = term(c.id, 'a');
        let to = term(c.id, 'k');
        let vDrop = mode === 'rev' ? Number(c.params.vz ?? 5.1) : DIODE_VF;
        if (c.type === 'transistor') {
          const npn = String(c.params.polarity ?? 'npn') !== 'pnp';
          from = term(c.id, npn ? 'c' : 'e');
          to = term(c.id, npn ? 'e' : 'c');
          vDrop = VCE_SAT;
        } else if (c.type === 'mosfet') {
          from = term(c.id, 'd');
          to = term(c.id, 's');
          vDrop = 0.1; // Rds(on) is folded into SEMI_R; drop stays tiny
        }
        const src = this.bestSource(from);
        const snk = this.bestSink(to);
        if (src && snk) {
          const rTotal = src.r + snk.r;
          // only the junction itself in the path: no limiting resistor
          if (rTotal <= SEMI_R + 0.5) {
            state.burnt = true;
            state.currentMa = BURN_MA * 10;
          } else {
            state.currentMa = Math.max(0, ((src.src.v - snk.src.v - vDrop) / rTotal) * 1000);
            state.burnt = state.currentMa > BURN_MA;
          }
        }
        if (state.burnt) {
          faults.push({
            kind: 'overcurrent',
            net: from,
            message: `${c.id} is cooking: ${Math.round(state.currentMa)} mA through it with no current-limiting resistor`,
          });
        }
        if (src && snk) {
          this.attribute(pinCurrent, src.at, state.currentMa);
          this.attribute(pinCurrent, snk.at, state.currentMa);
        }
      }
      semis.set(c.id, state);
    }

    // --- drive hygiene: a BJT base tied straight to a driver is a real-world
    // pin killer (the emulator's base current is not modelled, so warn) ---
    for (const c of this.comps.values()) {
      if (c.type !== 'transistor') continue;
      const bt = term(c.id, 'b');
      // a driver within ~1 ohm of the base means no series resistor anywhere
      const bare = this.reachSources(bt).find((x) => x.r <= 1 && x.src.strong);
      if (bare) {
        faults.push({
          kind: 'warn',
          net: bt,
          message: `${c.id} has no base resistor: a driver sits directly on the base (a real pin would dump ~100 mA through it - add ~1k)`,
        });
      }
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
        // F1.2: V(VDD)+0.3 on a signal pin is a datasheet violation, and a
        // solid (0-ohm net) connection of such a rail destroys the pad now.
        const killer = list.find((s) => s.strong && s.at !== t && s.v > ABS_MAX_V);
        const g = this.gpioOf(t);
        if (killer && g !== null && !overvoltPins.includes(g)) {
          overvoltPins.push(g);
          faults.push({
            kind: 'overcurrent',
            net: netOf.get(t)!,
            message: `${killer.v.toFixed(1)} V on GPIO${g} exceeds the absolute maximum (VDD + 0.3 V) - the pin is destroyed`,
          });
        }
      }
    }

    // --- F1.2: per-pin and chip-wide GPIO current budgets ---
    let totalMa = 0;
    for (const [g, mA] of pinCurrent) {
      totalMa += mA;
      if (mA > PIN_MAX_MA * 2) {
        faults.push({
          kind: 'overcurrent',
          net: `gpio${g}`,
          message: `GPIO${g} carries ${mA.toFixed(1)} mA, more than double the ${PIN_MAX_MA} mA absolute maximum`,
        });
      } else if (mA > PIN_MAX_MA) {
        faults.push({
          kind: 'warn',
          net: `gpio${g}`,
          message: `GPIO${g} carries ${mA.toFixed(1)} mA, above the ${PIN_MAX_MA} mA per-pin maximum (it will not survive long)`,
        });
      }
    }
    if (totalMa > PIN_TOTAL_MAX_MA) {
      faults.push({
        kind: 'overcurrent',
        net: 'gpio-total',
        message: `total GPIO current is ${totalMa.toFixed(1)} mA, above the ${PIN_TOTAL_MAX_MA} mA the chip can carry`,
      });
    }

    return { leds, semis, pinLevels, externals, pinCurrent, overvoltPins, faults, netOf, netVoltage };
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

  private semiGuard = new Set<string>();

  /**
   * Junction state of a diode / zener / transistor, probed the way the relay
   * coil probes itself: sources reachable at the terminals, re-entrancy
   * treated as "off". Returns the conduction mode for links() and resolve().
   */
  semiBias(c: ComponentDef): 'fwd' | 'rev' | 'off' {
    if (this.semiGuard.has(c.id)) return 'off';
    this.semiGuard.add(c.id);
    try {
      const R_MAX = 100_000;
      if (c.type === 'diode' || c.type === 'zener') {
        const hi = this.bestSource(term(c.id, 'a'));
        const lo = this.bestSink(term(c.id, 'k'));
        if (hi && lo && hi.r <= R_MAX && lo.r <= R_MAX && hi.src.v - lo.src.v - DIODE_VF > 0.05) return 'fwd';
        if (c.type === 'zener') {
          // reverse: cathode high, anode low, difference at or above Vz
          const rk = this.bestSource(term(c.id, 'k'));
          const ra = this.bestSink(term(c.id, 'a'));
          const vz = Number(c.params.vz ?? 5.1);
          if (rk && ra && rk.r <= R_MAX && ra.r <= R_MAX && rk.src.v - ra.src.v >= vz) return 'rev';
        }
        return 'off';
      }
      if (c.type === 'transistor') {
        const npn = String(c.params.polarity ?? 'npn') !== 'pnp';
        const hi = this.bestSource(term(c.id, npn ? 'b' : 'e'));
        const lo = this.bestSink(term(c.id, npn ? 'e' : 'b'));
        return hi && lo && hi.src.v - lo.src.v > DIODE_VF ? 'fwd' : 'off';
      }
      if (c.type === 'mosfet') {
        const vth = Number(c.params.vth ?? 2);
        const hi = this.bestSource(term(c.id, 'g'));
        const lo = this.bestSink(term(c.id, 's'));
        return hi && lo && hi.src.v - lo.src.v >= vth ? 'fwd' : 'off';
      }
      return 'off';
    } finally {
      this.semiGuard.delete(c.id);
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
      case 'diode': return ['a', 'k'];
      case 'zener': return ['a', 'k'];
      case 'transistor': return ['c', 'b', 'e'];
      case 'mosfet': return ['d', 'g', 's'];
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
    case 'weak-low':
      // the GPIO15 boot strap: a weak pull-DOWN to GND
      return { v: 0, rInternal: PULLUP_R, strong: false, duty: 0 };
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
