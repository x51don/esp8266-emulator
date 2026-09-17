import { describe, it, expect, vi } from 'vitest';
import { Clock } from '../core/clock';

// A virtual-time scheduler. Time is in microseconds (matching ESP8266 micros()).
// The clock never advances on its own; callers drive it with advanceTo/advance,
// which makes every test deterministic.

describe('Clock - virtual time', () => {
  it('starts at zero', () => {
    const c = new Clock();
    expect(c.now()).toBe(0);
  });

  it('advance() moves time forward by a delta', () => {
    const c = new Clock();
    c.advance(500);
    expect(c.now()).toBe(500);
    c.advance(250);
    expect(c.now()).toBe(750);
  });

  it('advanceTo() sets time to an absolute target', () => {
    const c = new Clock();
    c.advance(1000);
    c.advanceTo(1800);
    expect(c.now()).toBe(1800);
  });

  it('never moves time backwards', () => {
    const c = new Clock();
    c.advance(1000);
    c.advance(-500);
    c.advanceTo(400);
    expect(c.now()).toBe(1000);
  });
});

describe('Clock - scheduling and firing', () => {
  it('runs a timeout at its due time, not before', () => {
    const c = new Clock();
    const fn = vi.fn();
    c.setTimeout(1000, fn);

    c.advance(999);
    expect(fn).not.toHaveBeenCalled();

    c.advance(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('runs a timeout exactly once', () => {
    const c = new Clock();
    const fn = vi.fn();
    c.setTimeout(100, fn);
    c.advance(1000);
    c.advance(1000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('fires timeouts in due-time order', () => {
    const c = new Clock();
    const order: number[] = [];
    c.setTimeout(300, () => order.push(3));
    c.setTimeout(100, () => order.push(1));
    c.setTimeout(200, () => order.push(2));
    c.advance(1000);
    expect(order).toEqual([1, 2, 3]);
  });

  it('fires same-time timeouts in insertion order (FIFO)', () => {
    const c = new Clock();
    const order: number[] = [];
    c.setTimeout(100, () => order.push(1));
    c.setTimeout(100, () => order.push(2));
    c.setTimeout(100, () => order.push(3));
    c.advance(100);
    expect(order).toEqual([1, 2, 3]);
  });

  it('reports the virtual now() inside a callback', () => {
    const c = new Clock();
    let seen = -1;
    c.setTimeout(4200, () => {
      seen = c.now();
    });
    c.advance(5000);
    expect(seen).toBe(4200);
  });

  it('cancels a pending timeout', () => {
    const c = new Clock();
    const fn = vi.fn();
    const id = c.setTimeout(100, fn);
    c.clear(id);
    c.advance(1000);
    expect(fn).not.toHaveBeenCalled();
  });

  it('cancels a repeating interval', () => {
    const c = new Clock();
    const fn = vi.fn();
    const id = c.setInterval(100, fn);
    c.advance(350);
    expect(fn).toHaveBeenCalledTimes(3);
    c.clear(id);
    c.advance(1000);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('repeats an interval at a fixed period', () => {
    const c = new Clock();
    const stamps: number[] = [];
    c.setInterval(100, () => stamps.push(c.now()));
    c.advance(500);
    expect(stamps).toEqual([100, 200, 300, 400, 500]);
  });

  it('handles a timeout scheduled from inside another timeout', () => {
    const c = new Clock();
    const fn = vi.fn();
    c.setTimeout(100, () => c.setTimeout(50, fn)); // inner due at 150
    c.advance(150);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('runs a timeout scheduled in the past immediately on next advance', () => {
    const c = new Clock();
    const fn = vi.fn();
    c.advance(1000);
    c.setTimeoutAt(500, fn); // already due
    expect(c.pending()).toBe(1);
    c.advance(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('reports pending timer count', () => {
    const c = new Clock();
    expect(c.pending()).toBe(0);
    const a = c.setTimeout(100, () => {});
    c.setInterval(200, () => {});
    expect(c.pending()).toBe(2);
    c.clear(a);
    expect(c.pending()).toBe(1);
  });

  it('nextEventTime returns the soonest due time', () => {
    const c = new Clock();
    c.setTimeout(500, () => {});
    c.setTimeout(300, () => {});
    expect(c.nextEventTime()).toBe(300);
  });

  it('nextEventTime returns Infinity with no pending events', () => {
    const c = new Clock();
    expect(c.nextEventTime()).toBe(Infinity);
  });
});

describe('restart', () => {
  it('rewinds to zero and drops pending tasks', () => {
    const c = new Clock();
    let fired = false;
    c.advance(50);
    c.setTimeout(10, () => { fired = true; });
    c.restart();
    c.advance(1000);
    expect(fired).toBe(false);
    expect(c.now()).toBe(1000);
  });
});

describe('drain', () => {
  it('fires tasks due at the current instant without moving time', () => {
    const c = new Clock();
    const seen: number[] = [];
    c.setTimeout(0, () => seen.push(1));
    c.advance(0); // passive: advance(0) does nothing
    expect(seen).toEqual([]);
    c.drain();
    expect(seen).toEqual([1]);
    expect(c.now()).toBe(0);
  });
});
