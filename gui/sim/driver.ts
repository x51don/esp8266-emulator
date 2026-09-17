/**
 * SimDriver: maps wall-clock frame deltas to virtual time on the machine.
 * The canvas layer calls frame(elapsedMs) from requestAnimationFrame; tests
 * call it by hand. One frame never advances more than `maxStepMs` of virtual
 * time, so a backgrounded tab (huge delta) cannot teleport the simulation.
 */

export interface Advanceable {
  advance(ms: number): void;
  timeMs(): number;
}

export class SimDriver {
  running = false;
  speed: number;
  simulatedMs = 0;
  private readonly maxStepMs: number;

  constructor(
    private readonly machine: Advanceable,
    opts: { speed?: number; maxStepMs?: number } = {},
  ) {
    this.speed = opts.speed ?? 1;
    this.maxStepMs = opts.maxStepMs ?? 50;
  }

  start(): void {
    this.running = true;
    this.simulatedMs = 0;
  }

  stop(): void {
    this.running = false;
  }

  /** elapsed real milliseconds since the previous frame call. */
  frame(wallMs: number): void {
    if (!this.running || !(wallMs > 0)) return;
    const virtual = Math.min(wallMs, this.maxStepMs) * this.speed;
    this.machine.advance(virtual);
    this.simulatedMs += virtual;
  }
}
