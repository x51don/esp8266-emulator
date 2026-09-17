import { describe, expect, it } from 'vitest';
import { SimDriver } from '../gui/sim/driver';

/** Minimal fake machine: records every advance() call. */
class Fake {
  calls: number[] = [];
  virtual = 0;
  advance(ms: number): void {
    this.calls.push(ms);
    this.virtual += ms;
  }
  timeMs(): number {
    return this.virtual;
  }
}

describe('SimDriver', () => {
  it('does nothing while stopped', () => {
    const f = new Fake();
    const d = new SimDriver(f);
    d.frame(16);
    expect(f.calls).toEqual([]);
  });

  it('advances wall * speed while running', () => {
    const f = new Fake();
    const d = new SimDriver(f, { speed: 2 });
    d.start();
    d.frame(16);
    expect(f.calls).toEqual([32]);
  });

  it('clamps one frame delta (lag spikes never fast-forward the world)', () => {
    const f = new Fake();
    const d = new SimDriver(f, { maxStepMs: 50 });
    d.start();
    d.frame(5000); // browser tab was backgrounded
    expect(f.calls).toEqual([50]);
  });

  it('accumulates simulated time and resets on stop/start', () => {
    const f = new Fake();
    const d = new SimDriver(f);
    d.start();
    d.frame(10);
    d.frame(10);
    expect(d.simulatedMs).toBe(20);
    d.stop();
    d.start();
    d.frame(5);
    expect(d.simulatedMs).toBe(5);
  });

  it('speed can change mid-run', () => {
    const f = new Fake();
    const d = new SimDriver(f, { speed: 1 });
    d.start();
    d.frame(10);
    d.speed = 4;
    d.frame(10);
    expect(f.calls).toEqual([10, 40]);
  });

  it('zero or negative deltas are ignored', () => {
    const f = new Fake();
    const d = new SimDriver(f);
    d.start();
    d.frame(0);
    d.frame(-3);
    expect(f.calls).toEqual([]);
  });
});
