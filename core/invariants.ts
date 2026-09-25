/**
 * F5 (repair 5/6): invariant probes for states the hardware must never reach.
 *
 * A sketch that drives both half-bridges of a motor driver HIGH is a dead
 * short, and the emulator used to simulate it happily for as long as the
 * sketch liked. These probes state the forbidden combination; the machine
 * evaluates them on every `digitalWrite` and on every step of the clock, so a
 * violation is caught at the instant it becomes true, whoever set the pin.
 *
 * The rules are harness settings, not chip state: they survive `run()` and
 * `ESP.restart()`. What the probes caught is the observation log and does not
 * survive a reboot - a fresh boot starts a fresh window.
 */

/** A pin as the harness names it: board label ('D5'), 'GPIO14' or raw 14. */
export type PinRef = string | number;

export interface PinInvariant {
  /**
   * The combination that must never be seen together. Every pair has to hold
   * at the same instant for the rule to fire, so `[[a,1],[b,1]]` is "never
   * both windings ON" and `[[a,1]]` is "a must never be HIGH".
   */
  never: Array<[PinRef, number]>;
  /** Shown in the violation, the thrown error and the GUI counter. */
  label: string;
}

export interface PinObservation {
  pin: string;
  gpio: number;
  value: 0 | 1;
}

export interface PinInvariantViolation {
  /** Virtual uptime in ms, the same clock `millis()` reads. */
  tMs: number;
  label: string;
  /** Every pin the rule mentions and its level at that instant. */
  pins: PinObservation[];
}

/** Thrown instead of recorded when `invariantStrict` is on. */
export class PinInvariantError extends Error {
  readonly violation: PinInvariantViolation;
  constructor(violation: PinInvariantViolation) {
    super(
      `pin invariant "${violation.label}" violated at ${violation.tMs} ms (` +
        violation.pins.map((p) => `${p.pin}=${p.value}`).join(' ') + ')',
    );
    this.name = 'PinInvariantError';
    this.violation = violation;
  }
}

/**
 * Evaluate one rule. Returns the violation when the forbidden combination
 * holds right now, null when it does not - including when a pin name cannot
 * be resolved on this board, which can never match.
 */
export function matchPinInvariant(
  rule: PinInvariant,
  opts: {
    level: (gpio: number) => 0 | 1;
    gpioFor: (ref: PinRef) => number | null;
    tMs: number;
  },
): PinInvariantViolation | null {
  if (!rule.never || rule.never.length === 0) return null;
  const pins: PinObservation[] = [];
  for (const [ref, want] of rule.never) {
    const gpio = opts.gpioFor(ref);
    if (gpio === null) return null; // not a pin of this board: cannot match
    const value = opts.level(gpio);
    pins.push({ pin: String(ref), gpio, value });
    if (value !== (want ? 1 : 0)) return null;
  }
  return { tMs: opts.tMs, label: rule.label, pins };
}
