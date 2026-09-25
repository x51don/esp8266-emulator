import { describe, expect, it } from 'vitest';
import { Esp8266Machine } from '../core/machine';
import { invariantBadge } from '../gui/App';

// F5 (repair 5/6): probes for states the hardware must never reach. The
// emulator happily drove both half-bridges of a motor driver HIGH for a whole
// virtual second - electrically that is a dead short, but nothing said so.

const BRIDGE = `
  bool once = false;
  void setup() {
    pinMode(D5, OUTPUT);
    pinMode(D6, OUTPUT);
    digitalWrite(D5, HIGH);
  }
  void loop() {
    if (!once) { once = true; delay(250); digitalWrite(D6, HIGH); }
    delay(10);
  }
`;

function machine(uptimeUs = 0): Esp8266Machine {
  const m = new Esp8266Machine({ board: 'wemos-d1-mini' });
  if (uptimeUs) m.setUptimeUs(uptimeUs);
  return m;
}

/** A machine already running the shoot-through sketch, probe attached. */
function bridged(label = 'H-bridge shoot-through'): Esp8266Machine {
  const m = machine();
  m.load(BRIDGE);
  m.addPinInvariant({ never: [['D5', 1], ['D6', 1]], label });
  m.run();
  return m;
}

describe('pin invariant probes (F5)', () => {
  it('catches the forbidden combination the moment it appears', () => {
    const m = bridged();
    // nothing yet: only D5 is HIGH
    m.advance(100);
    expect(m.invariantViolations).toEqual([]);
    m.advance(400); // the offending digitalWrite(D6, HIGH) happens at 250 ms
    expect(m.invariantViolations.length).toBe(1);
    const v = m.invariantViolations[0];
    expect(v.label).toBe('H-bridge shoot-through');
    expect(v.tMs).toBeGreaterThanOrEqual(250);
    expect(v.tMs).toBeLessThan(260);
    expect(v.pins.map((p) => [p.pin, p.value])).toEqual([['D5', 1], ['D6', 1]]);
  });

  it('stays quiet while the rule holds', () => {
    const m = machine();
    m.load(`
      void setup() { pinMode(D5, OUTPUT); pinMode(D6, OUTPUT); digitalWrite(D5, HIGH); }
      void loop() { delay(10); }
    `);
    m.addPinInvariant({ never: [['D5', 1], ['D6', 1]], label: 'both windings on' });
    m.run();
    m.advance(2000);
    expect(m.invariantViolations).toEqual([]);
  });

  it('reports one entry per violation episode', () => {
    const m = machine();
    m.load(`
      bool once = false;
      void setup() {
        pinMode(D5, OUTPUT);
        pinMode(D6, OUTPUT);
        digitalWrite(D5, LOW);
        digitalWrite(D6, LOW);
      }
      void loop() {
        if (!once) {
          once = true;
          delay(100);  digitalWrite(D5, HIGH); digitalWrite(D6, HIGH); // episode 1
          delay(1000); digitalWrite(D5, LOW);  digitalWrite(D6, LOW);  // released
          delay(1000); digitalWrite(D5, HIGH); digitalWrite(D6, HIGH); // episode 2
        }
        delay(10);
      }
    `);
    m.addPinInvariant({ never: [['D5', 1], ['D6', 1]], label: 'both on' });
    m.run();
    m.advance(5000);
    expect(m.invariantViolations.length).toBe(2);
    expect(m.invariantViolations.every((v) => v.label === 'both on')).toBe(true);
  });

  it('is checked on every advance() step, not only on digitalWrite', () => {
    // The sketch already sits in the forbidden state when the probe goes on:
    // no further write is needed for the next step of the clock to see it.
    const m = machine();
    m.load(`
      void setup() {
        pinMode(D5, OUTPUT);
        pinMode(D6, OUTPUT);
        digitalWrite(D5, HIGH);
        digitalWrite(D6, HIGH);
      }
      void loop() { delay(10); }
    `);
    m.run();
    m.advance(10);
    expect(m.invariantViolations).toEqual([]); // the probe did not exist yet
    m.addPinInvariant({ never: [['D5', 1], ['D6', 1]], label: 'both on' });
    m.advance(10);
    expect(m.invariantViolations.length).toBe(1);
  });

  it('throws instead of collecting in strict mode', () => {
    const m = bridged();
    m.invariantStrict = true;
    expect(() => m.advance(400)).toThrow(/H-bridge shoot-through/);
    expect(m.invariantViolations).toEqual([]);
  });

  it('takes raw gpio numbers as well as board labels', () => {
    const m = machine();
    m.load(`
      void setup() { pinMode(D5, OUTPUT); digitalWrite(D5, HIGH); }
      void loop() { delay(10); }
    `);
    m.addPinInvariant({ never: [[14, 1], ['GPIO12', 0]], label: 'D5 high while D6 low' });
    m.run();
    m.advance(20);
    expect(m.invariantViolations.length).toBe(1);
    expect(m.invariantViolations[0].pins.map((p) => p.gpio)).toEqual([14, 12]);
  });

  it('ignores a pin the board does not have', () => {
    const m = bridged();
    m.addPinInvariant({ never: [['D99', 1], ['D5', 1]], label: 'nonsense' });
    m.advance(400);
    expect(m.invariantViolations.map((v) => v.label)).toEqual(['H-bridge shoot-through']);
  });

  it('can demand a level as well as forbid one', () => {
    const m = machine();
    m.load(`
      void setup() { pinMode(D5, OUTPUT); digitalWrite(D5, LOW); }
      void loop() { delay(10); }
    `);
    m.addPinInvariant({ never: [['D5', 0]], label: 'D5 must stay high' });
    m.run();
    m.advance(20);
    expect(m.invariantViolations.length).toBe(1);
    expect(m.invariantViolations[0].pins[0]).toEqual({ pin: 'D5', gpio: 14, value: 0 });
  });

  it('stops reporting once the probe is removed', () => {
    const m = bridged();
    m.removePinInvariant('H-bridge shoot-through');
    m.advance(400);
    expect(m.invariantViolations).toEqual([]);
    expect(m.pinInvariants).toEqual([]);
  });

  it('starts a fresh observation window on a reboot', () => {
    const m = bridged();
    m.advance(400);
    expect(m.invariantViolations.length).toBe(1);
    m.run(); // ESP.restart(): the probe stays, the log starts over
    expect(m.invariantViolations).toEqual([]);
    expect(m.pinInvariants.length).toBe(1);
  });

  it('shows a counter in the GUI once something is wrong', () => {
    expect(invariantBadge(0)).toBeNull();
    expect(invariantBadge(1)).toBe('1 violation');
    expect(invariantBadge(4)).toBe('4 violations');
  });
});
