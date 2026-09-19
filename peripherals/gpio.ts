/**
 * Electrical model of the ESP8266 GPIO pins (GPIO0..GPIO16).
 *
 * Each pin has: sketch side (mode + output latch + PWM duty) and circuit side
 * (external drivers reported by the netlist). `driveState` tells the circuit
 * what the pin pushes; `read` tells the sketch what the pin actually sees.
 *
 * Model rules (documented simplifications):
 * - floating input reads LOW;
 * - a strong output fighting an opposite external driver reports a conflict
 *   and the external driver wins the logic level (pin clamped, real HW would
 *   draw large current - surfaced to the user as a warning);
 * - GPIO16 is open-drain: writing HIGH releases a weak pull-up instead of
 *   pushing the line (matches real D0 behaviour);
 * - PWM: duty >= 512 reads HIGH; duty 0/1023 behave as static levels;
 * - INPUT_PULLUP is a weak HIGH (external driver always wins);
 * - out of reset GPIO0/GPIO2 carry a weak pull-UP and GPIO15 a weak pull-DOWN
 *   (the boot-mode straps); any pinMode() call replaces that resistor.
 */

export const PIN_INPUT = 'input';
export const PIN_OUTPUT = 'output';
export const PIN_INPUT_PULLUP = 'input_pullup';

export type PinMode = typeof PIN_INPUT | typeof PIN_OUTPUT | typeof PIN_INPUT_PULLUP;
export type ExternalDriver = 'none' | 'high' | 'low';
/** Resistor on the pad that does not come from the sketch: INPUT_PULLUP is
 *  'up'; the ESP8266 also ships GPIO0/GPIO2 with pull-UPS and GPIO15 with a
 *  pull-DOWN (~45 kOhm) enabled out of reset - the boot-mode straps. */
export type PinPull = 'none' | 'up' | 'down';

export type DriveState =
  | { kind: 'float' }
  | { kind: 'push'; level: 0 | 1 }
  | { kind: 'weak-high' }
  | { kind: 'weak-low' }
  | { kind: 'pwm'; duty: number }; // 0..1, mid-range

export interface PinSnapshot {
  mode: PinMode;
  latch: 0 | 1;
  pwm: number;      // -1 when analogWrite inactive, else 0..1023
  pull: PinPull;
  external: ExternalDriver;
  drive: DriveState;
  read: 0 | 1;
  conflict: boolean;
}

export const GPIO_COUNT = 17;
const PWM_THRESHOLD = 512; // duty >= this reads HIGH

/** Boot strapping: weak pull-ups hold 0/2 HIGH and the pull-down holds 15
 *  LOW while nothing external drives the line (datasheet reset defaults). */
const STRAP_UP: ReadonlySet<number> = new Set([0, 2]);
const STRAP_DOWN: ReadonlySet<number> = new Set([15]);

interface PinState {
  mode: PinMode;
  latch: 0 | 1;
  pwm: number; // -1 = inactive
  pull: PinPull;
  external: ExternalDriver;
}

export class GpioBus {
  private pins = new Map<number, PinState>();
  /** F1.2: destroyed output drivers (overcurrent / absolute-max violation).
   *  Physical damage: survives reset(), cleared only by clearDamage(). */
  private damaged = new Set<number>();
  private listeners: Array<(gpio: number, snap: PinSnapshot) => void> = [];
  /** Monotonic mutation counter; consumers cache circuit solves keyed on it. */
  version = 0;

  constructor() {
    for (let g = 0; g < GPIO_COUNT; g++) {
      this.pins.set(g, {
        mode: PIN_INPUT, latch: 0, pwm: -1, external: 'none', pull: defaultPull(g),
      });
    }
  }

  onPinChange(listener: (gpio: number, snap: PinSnapshot) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  getMode(gpio: number): PinMode {
    return this.pin(gpio).mode;
  }

  /** F1.2: destroy a pin's output driver (overcurrent / over-voltage event). */
  damage(gpio: number): void {
    if (!this.pins.has(gpio) || this.damaged.has(gpio)) return;
    this.damaged.add(gpio);
    const p = this.pin(gpio);
    p.mode = PIN_INPUT;
    p.latch = 0;
    p.pwm = -1;
    p.pull = 'none'; // the burned pad no longer pulls in either direction
    this.notify(gpio);
  }

  isDamaged(gpio: number): boolean {
    return this.damaged.has(gpio);
  }

  /** All destroyed pins (GUI: persistent "dead pad" markers). */
  damagedPins(): number[] {
    return [...this.damaged].sort((a, b) => a - b);
  }

  /** GUI action: swap in a fresh board. Does not run a chip reset. */
  clearDamage(gpio?: number): void {
    if (gpio === undefined) {
      if (!this.damaged.size) return;
      for (const g of this.damaged) this.notify(g);
      this.damaged.clear();
      return;
    }
    if (!this.damaged.delete(gpio)) return;
    this.notify(gpio);
  }

  setMode(gpio: number, mode: PinMode): void {
    if (this.damaged.has(gpio)) return; // a dead pad does not reconfigure
    const p = this.pin(gpio);
    // the sketch's mode owns the pad resistor: INPUT_PULLUP is the same ~45k
    // resistor the boot straps use, and ANY pinMode() call switches that
    // strap off (so pinMode(pin, INPUT) on a strap pin floats it, as on HW).
    const pull: PinPull = mode === PIN_INPUT_PULLUP ? 'up' : 'none';
    const pwm = mode !== PIN_OUTPUT ? -1 : p.pwm; // pinMode() kills PWM on the core too
    if (p.mode === mode && p.pull === pull && p.pwm === pwm) return;
    p.mode = mode;
    p.pull = pull;
    p.pwm = pwm;
    this.notify(gpio);
  }

  write(gpio: number, level: 0 | 1 | boolean): void {
    if (this.damaged.has(gpio)) return; // a dead pad cannot drive
    const p = this.pin(gpio);
    const v = level ? 1 : 0;
    if (p.latch === v && p.pwm === -1) return;
    p.latch = v as 0 | 1;
    if (p.pwm !== -1) p.pwm = -1; // digitalWrite cancels PWM
    this.notify(gpio);
  }

  analogWrite(gpio: number, duty: number): void {
    if (this.damaged.has(gpio)) return;
    const p = this.pin(gpio);
    const d = Math.max(0, Math.min(1023, Math.trunc(duty)));
    const modeChanged = p.mode !== PIN_OUTPUT;
    if (p.pwm === d && !modeChanged) return;
    if (modeChanged) p.mode = PIN_OUTPUT; // the ESP8266 core switches the pin to output
    p.pwm = d;
    this.notify(gpio);
  }

  getPwm(gpio: number): number {
    return this.pin(gpio).pwm;
  }

  setExternalDriver(gpio: number, driver: ExternalDriver): void {
    const p = this.pin(gpio);
    if (p.external === driver) return;
    p.external = driver;
    this.notify(gpio);
  }

  /** What the pin imposes on the external circuit. */
  driveState(gpio: number): DriveState {
    if (this.damaged.has(gpio)) return { kind: 'float' }; // burned pad: dead
    const p = this.pin(gpio);
    const strong = p.mode === PIN_OUTPUT;
    const isOpenDrain = gpio === 16;

    if (p.pwm >= 0) {
      if (p.pwm === 0) return strong || isOpenDrain ? { kind: 'push', level: 0 } : { kind: 'float' };
      if (p.pwm === 1023) {
        if (strong) return isOpenDrain ? { kind: 'weak-high' } : { kind: 'push', level: 1 };
        return { kind: 'float' };
      }
      return strong || isOpenDrain ? { kind: 'pwm', duty: p.pwm / 1023 } : { kind: 'float' };
    }

    if (strong) {
      if (p.latch === 1) return isOpenDrain ? { kind: 'weak-high' } : { kind: 'push', level: 1 };
      return { kind: 'push', level: 0 };
    }
    if (p.pull === 'up') return { kind: 'weak-high' };
    if (p.pull === 'down') return { kind: 'weak-low' };
    return { kind: 'float' };
  }

  /** Logic level the sketch sees (external drivers can override the latch). */
  read(gpio: number): 0 | 1 {
    const p = this.pin(gpio);
    if (p.external === 'high') return 1;
    if (p.external === 'low') return 0;
    const d = this.driveState(gpio);
    switch (d.kind) {
      case 'push': return d.level;
      case 'weak-high': return 1;
      case 'pwm': return d.duty >= PWM_THRESHOLD / 1023 ? 1 : 0;
      default: return 0; // floating and weak-low resolve LOW in this model
    }
  }

  conflict(gpio: number): boolean {
    const p = this.pin(gpio);
    const d = this.driveState(gpio);
    if (d.kind !== 'push') return false;
    return (p.external === 'low' && d.level === 1) || (p.external === 'high' && d.level === 0);
  }

  snapshot(gpio: number): PinSnapshot {
    const p = this.pin(gpio);
    return {
      mode: p.mode,
      latch: p.latch,
      pwm: p.pwm,
      pull: p.pull,
      external: p.external,
      drive: this.driveState(gpio),
      read: this.read(gpio),
      conflict: this.conflict(gpio),
    };
  }

  /** Chip reset: pads go input and the boot-strap resistors come back on. */
  reset(): void {
    for (let g = 0; g < GPIO_COUNT; g++) {
      const p = this.pins.get(g)!;
      const pull = defaultPull(g);
      const dirty =
        p.mode !== PIN_INPUT || p.latch !== 0 || p.pwm !== -1
        || p.external !== 'none' || p.pull !== pull;
      p.mode = PIN_INPUT;
      p.latch = 0;
      p.pwm = -1;
      p.external = 'none';
      p.pull = pull;
      if (dirty) this.notify(g);
    }
  }

  private pin(gpio: number): PinState {
    const p = this.pins.get(gpio);
    if (!p) throw new Error(`GPIO${gpio} does not exist on ESP8266 (valid: 0..16)`);
    return p;
  }

  private notify(gpio: number): void {
    this.version++; // electrical-state change: cached circuit resolves are stale
    const snap = this.snapshot(gpio);
    for (const l of this.listeners) l(gpio, snap);
  }
}

/** Reset defaults of the pad resistors: pull-ups on the boot straps. */
function defaultPull(gpio: number): PinPull {
  if (STRAP_UP.has(gpio)) return 'up';
  if (STRAP_DOWN.has(gpio)) return 'down';
  return 'none';
}
