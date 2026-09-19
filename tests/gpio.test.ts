import { describe, it, expect, vi } from 'vitest';
import { GpioBus, PIN_INPUT, PIN_OUTPUT, PIN_INPUT_PULLUP, type DriveState } from '../peripherals/gpio';

// GpioBus models the electrical state of every ESP8266 GPIO (0..16) as seen by
// both the sketch (digitalRead) and the external circuit (driveState/external
// driver). It is the single source of truth for pin electricity; the register
// file and the netlist are its two clients.

describe('modes and reads', () => {
  it('fresh non-strap pins are floating inputs reading LOW', () => {
    const bus = new GpioBus();
    expect(bus.getMode(4)).toBe(PIN_INPUT);
    expect(bus.read(4)).toBe(0);
    expect(bus.driveState(4)).toEqual({ kind: 'float' } satisfies DriveState);
  });

  // F1.1 boot strapping: GPIO0/GPIO2 come out of reset with an internal
  // pull-UP (~45k) and GPIO15 with a pull-DOWN. The sketch's first pinMode()
  // replaces the strap resistor.
  it('GPIO0/GPIO2 carry a pull-up out of reset', () => {
    const bus = new GpioBus();
    for (const g of [0, 2]) {
      expect(bus.read(g)).toBe(1);
      expect(bus.driveState(g)).toEqual({ kind: 'weak-high' } satisfies DriveState);
      expect(bus.snapshot(g).pull).toBe('up');
    }
  });

  it('GPIO15 carries a pull-down out of reset', () => {
    const bus = new GpioBus();
    expect(bus.read(15)).toBe(0);
    expect(bus.driveState(15)).toEqual({ kind: 'weak-low' } satisfies DriveState);
    // a strong external HIGH overrides the weak pull-down
    bus.setExternalDriver(15, 'high');
    expect(bus.read(15)).toBe(1);
  });

  it('pinMode clears the boot strap on 0/2/15', () => {
    const bus = new GpioBus();
    bus.setMode(0, PIN_INPUT); // plain input drops the pull-up
    expect(bus.driveState(0)).toEqual({ kind: 'float' } satisfies DriveState);
    bus.setMode(15, PIN_INPUT_PULLUP); // sketch pull-up wins over the strap
    expect(bus.driveState(15)).toEqual({ kind: 'weak-high' } satisfies DriveState);
  });

  it('output latches and pushes the level out', () => {
    const bus = new GpioBus();
    bus.setMode(2, PIN_OUTPUT);
    bus.write(2, 1);
    expect(bus.read(2)).toBe(1);
    expect(bus.driveState(2)).toEqual({ kind: 'push', level: 1 });
    bus.write(2, 0);
    expect(bus.driveState(2)).toEqual({ kind: 'push', level: 0 });
  });

  it('writes to an input pin only move the hidden latch (no driving)', () => {
    const bus = new GpioBus();
    bus.write(4, 1);
    expect(bus.driveState(4)).toEqual({ kind: 'float' });
    bus.setMode(4, PIN_OUTPUT);
    expect(bus.driveState(4)).toEqual({ kind: 'push', level: 1 }); // latch kept, like the core
  });
});

describe('pull-ups and external drivers', () => {
  it('INPUT_PULLUP reads HIGH when nothing else drives the pin', () => {
    const bus = new GpioBus();
    bus.setMode(0, PIN_INPUT_PULLUP);
    expect(bus.read(0)).toBe(1);
    expect(bus.driveState(0)).toEqual({ kind: 'weak-high' });
  });

  it('external LOW overpowers the weak pull-up', () => {
    const bus = new GpioBus();
    bus.setMode(0, PIN_INPUT_PULLUP);
    bus.setExternalDriver(0, 'low');
    expect(bus.read(0)).toBe(0);
  });

  it('external driver decides a plain input pin', () => {
    const bus = new GpioBus();
    bus.setExternalDriver(5, 'high');
    expect(bus.read(5)).toBe(1);
    bus.setExternalDriver(5, 'none');
    expect(bus.read(5)).toBe(0); // floating resolves LOW (documented model choice)
  });

  it('conflict: strong output vs opposite external driver is flagged, external wins the read', () => {
    const bus = new GpioBus();
    bus.setMode(2, PIN_OUTPUT);
    bus.write(2, 1);
    bus.setExternalDriver(2, 'low');
    expect(bus.read(2)).toBe(0);      // pin clamped by the short
    expect(bus.conflict(2)).toBe(true);
    bus.setExternalDriver(2, 'high'); // no conflict when levels agree
    expect(bus.conflict(2)).toBe(false);
    expect(bus.read(2)).toBe(1);
  });
});

describe('GPIO16 (D0) open-drain rule', () => {
  it('HIGH on GPIO16 does not push - it releases the line like a pull-up', () => {
    const bus = new GpioBus();
    bus.setMode(16, PIN_OUTPUT);
    bus.write(16, 1);
    expect(bus.driveState(16)).toEqual({ kind: 'weak-high' });
    bus.write(16, 0);
    expect(bus.driveState(16)).toEqual({ kind: 'push', level: 0 });
  });

  it('GPIO16 HIGH with external LOW reads LOW without a hard conflict', () => {
    const bus = new GpioBus();
    bus.setMode(16, PIN_OUTPUT);
    bus.write(16, 1);
    bus.setExternalDriver(16, 'low');
    expect(bus.read(16)).toBe(0);
    expect(bus.conflict(16)).toBe(false); // weak vs external is a normal button circuit
  });
});

describe('PWM (analogWrite)', () => {
  it('analogWrite puts the pin into PWM drive with duty 0..1023', () => {
    const bus = new GpioBus();
    bus.analogWrite(4, 255);
    expect(bus.driveState(4)).toEqual({ kind: 'pwm', duty: 255 / 1023 });
    expect(bus.getPwm(4)).toBe(255);
  });

  it('duty 0 and 1023 behave like static levels', () => {
    const bus = new GpioBus();
    bus.analogWrite(4, 0);
    expect(bus.driveState(4)).toEqual({ kind: 'push', level: 0 });
    bus.analogWrite(4, 1023);
    expect(bus.driveState(4)).toEqual({ kind: 'push', level: 1 });
  });

  it('digital level of a PWM pin is duty >= 50%', () => {
    const bus = new GpioBus();
    bus.analogWrite(4, 400);
    expect(bus.read(4)).toBe(0);
    bus.analogWrite(4, 600);
    expect(bus.read(4)).toBe(1);
  });

  it('analogWrite on GPIO16 respects open-drain at high duty', () => {
    const bus = new GpioBus();
    bus.analogWrite(16, 1023);
    expect(bus.driveState(16)).toEqual({ kind: 'weak-high' });
  });
});

describe('change notification', () => {
  it('notifies on writes, mode changes and analogWrite with the pin id', () => {
    const bus = new GpioBus();
    const seen: number[] = [];
    bus.onPinChange((gpio) => seen.push(gpio));
    bus.write(2, 1);          // latch change (input pin still doesn't drive, but state moved)
    bus.setMode(2, PIN_OUTPUT); // drives now
    bus.analogWrite(2, 100);
    expect(seen).toEqual([2, 2, 2]);
  });

  it('external driver changes notify too (circuit -> pin direction)', () => {
    const bus = new GpioBus();
    const fn = vi.fn();
    bus.onPinChange(fn);
    bus.setExternalDriver(5, 'high');
    expect(fn).toHaveBeenCalledWith(5, expect.anything());
  });

  it('no event when the value does not change', () => {
    const bus = new GpioBus();
    const fn = vi.fn();
    bus.onPinChange(fn);
    bus.write(2, 1);
    bus.write(2, 1);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('reset', () => {
  it('returns every pin to floating input and notifies changed pins', () => {
    const bus = new GpioBus();
    bus.setMode(2, PIN_OUTPUT);
    bus.write(2, 1);
    bus.setExternalDriver(4, 'high');
    const fn = vi.fn();
    bus.onPinChange(fn);
    bus.reset();
    expect(bus.getMode(2)).toBe(PIN_INPUT);
    expect(bus.read(4)).toBe(0);
    expect(fn).toHaveBeenCalledWith(2, expect.anything());
  });
});
