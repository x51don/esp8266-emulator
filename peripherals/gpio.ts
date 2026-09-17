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
 * - INPUT_PULLUP is a weak HIGH (external driver always wins).
 */

export const PIN_INPUT = 'input';
export const PIN_OUTPUT = 'output';
export const PIN_INPUT_PULLUP = 'input_pullup';

export type PinMode = typeof PIN_INPUT | typeof PIN_OUTPUT | typeof PIN_INPUT_PULLUP;
export type ExternalDriver = 'none' | 'high' | 'low';

export type DriveState =
  | { kind: 'float' }
  | { kind: 'push'; level: 0 | 1 }
  | { kind: 'weak-high' }
  | { kind: 'pwm'; duty: number }; // 0..1, mid-range

export interface PinSnapshot {
  mode: PinMode;
  latch: 0 | 1;
  pwm: number;      // -1 when analogWrite inactive, else 0..1023
  external: ExternalDriver;
  drive: DriveState;
  read: 0 | 1;
  conflict: boolean;
}

export const GPIO_COUNT = 17;
const PWM_THRESHOLD = 512; // duty >= this reads HIGH

interface PinState {
  mode: PinMode;
  latch: 0 | 1;
  pwm: number; // -1 = inactive
  external: ExternalDriver;
}

export class GpioBus {
  private pins = new Map<number, PinState>();
  private listeners: Array<(gpio: number, snap: PinSnapshot) => void> = [];

  constructor() {
    for (let g = 0; g < GPIO_COUNT; g++) {
      this.pins.set(g, { mode: PIN_INPUT, latch: 0, pwm: -1, external: 'none' });
    }
  }

  onPinChange(listener: (gpio: number, snap: PinSnapshot) => void): void {
    this.listeners.push(listener);
  }

  getMode(gpio: number): PinMode {
    return this.pin(gpio).mode;
  }

  setMode(gpio: number, mode: PinMode): void {
    const p = this.pin(gpio);
    if (p.mode === mode) return;
    p.mode = mode;
    if (mode !== PIN_OUTPUT) p.pwm = -1; // pinMode() kills PWM on the core too
    this.notify(gpio);
  }

  write(gpio: number, level: 0 | 1 | boolean): void {
    const p = this.pin(gpio);
    const v = level ? 1 : 0;
    if (p.latch === v && p.pwm === -1) return;
    p.latch = v as 0 | 1;
    if (p.pwm !== -1) p.pwm = -1; // digitalWrite cancels PWM
    this.notify(gpio);
  }

  analogWrite(gpio: number, duty: number): void {
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
    if (p.mode === PIN_INPUT_PULLUP) return { kind: 'weak-high' };
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
      default: return 0; // floating resolves LOW in this model
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
      external: p.external,
      drive: this.driveState(gpio),
      read: this.read(gpio),
      conflict: this.conflict(gpio),
    };
  }

  reset(): void {
    for (let g = 0; g < GPIO_COUNT; g++) {
      const p = this.pins.get(g)!;
      const dirty =
        p.mode !== PIN_INPUT || p.latch !== 0 || p.pwm !== -1 || p.external !== 'none';
      p.mode = PIN_INPUT;
      p.latch = 0;
      p.pwm = -1;
      p.external = 'none';
      if (dirty) this.notify(g);
    }
  }

  private pin(gpio: number): PinState {
    const p = this.pins.get(gpio);
    if (!p) throw new Error(`GPIO${gpio} does not exist on ESP8266 (valid: 0..16)`);
    return p;
  }

  private notify(gpio: number): void {
    const snap = this.snapshot(gpio);
    for (const l of this.listeners) l(gpio, snap);
  }
}
