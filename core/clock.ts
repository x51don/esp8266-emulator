/**
 * Virtual-time clock and deterministic scheduler for the ESP8266 simulator.
 *
 * All times are microseconds (mirrors ESP8266 millis()/micros()). The clock is
 * fully passive: nothing fires until the owner calls advance()/advanceTo().
 * That keeps unit tests deterministic and lets the GUI driver map wall-clock
 * frames onto virtual time with a speed multiplier.
 */

export type TimerId = number;

interface TimerEntry {
  id: TimerId;
  due: number; // virtual us
  seq: number; // tie-breaker: same-due events fire in insertion order
  action: () => void;
  period: number | null; // null = one-shot; otherwise reschedule due += period
  canceled: boolean;
}

/** Comparator: earliest due first, then FIFO. */
function precedes(a: TimerEntry, b: TimerEntry): boolean {
  return a.due < b.due || (a.due === b.due && a.seq < b.seq);
}

/** Safety net against runaway rescheduling inside one advance pass. */
const MAX_FIRINGS_PER_ADVANCE = 100_000;

export class Clock {
  private time = 0;
  private heap: TimerEntry[] = [];
  private nextId: TimerId = 1;
  private seq = 0;

  /** Current virtual time in microseconds. */
  now(): number {
    return this.time;
  }

  /** Move virtual time forward by `deltaUs` (clamped at 0). */
  advance(deltaUs: number): void {
    if (deltaUs > 0) this.advanceTo(this.time + deltaUs);
  }

  /**
   * Fire every task that is due at the CURRENT instant (time does not move).
   * Lets owners drain zero-delay work scheduled "right now" while remaining
   * passive: nothing runs unless somebody pumps the clock.
   */
  drain(): void {
    let firings = 0;
    while (this.heap.length > 0 && this.heap[0].due <= this.time) {
      const entry = this.pop();
      if (entry.canceled) continue;
      if (++firings > MAX_FIRINGS_PER_ADVANCE) {
        throw new Error(
          `Clock runaway: >${MAX_FIRINGS_PER_ADVANCE} timer firings in one drain`,
        );
      }
      entry.action();
      if (entry.period !== null) {
        entry.due += entry.period;
        entry.seq = ++this.seq;
        this.push(entry);
      }
    }
  }

  /** Move virtual time to an absolute target (never backwards). Fires due timers. */
  advanceTo(targetUs: number): void {
    if (!Number.isFinite(targetUs) || targetUs <= this.time) return;
    let firings = 0;
    while (this.heap.length > 0 && this.heap[0].due <= targetUs) {
      const entry = this.pop();
      if (entry.canceled) continue;
      if (++firings > MAX_FIRINGS_PER_ADVANCE) {
        throw new Error(
          `Clock runaway: >${MAX_FIRINGS_PER_ADVANCE} timer firings in one advance`,
        );
      }
      this.time = Math.max(entry.due, this.time);
      entry.action();
      if (entry.period !== null) {
        entry.due += entry.period;
        entry.seq = ++this.seq;
        this.push(entry);
      }
    }
    this.time = targetUs;
  }

  /** Schedule `action` to run `delayUs` from now. Returns a cancelable id. */
  setTimeout(delayUs: number, action: () => void): TimerId {
    return this.setTimeoutAt(this.time + delayUs, action);
  }

  /** Schedule `action` at an absolute virtual time (already-due fires ASAP). */
  setTimeoutAt(dueUs: number, action: () => void): TimerId {
    return this.insert(dueUs, action, null);
  }

  /** Schedule `action` every `periodUs`, first firing at now + periodUs. */
  setInterval(periodUs: number, action: () => void): TimerId {
    if (periodUs <= 0) throw new Error('interval period must be positive');
    return this.insert(this.time + periodUs, action, periodUs);
  }

  /** Cancel a pending timer. Safe to call from inside another timer callback. */
  clear(id: TimerId): void {
    for (const e of this.heap) {
      if (e.id === id) {
        e.canceled = true;
        return;
      }
    }
  }

  /** Number of live timers (one-shot and repeating). */
  pending(): number {
    let n = 0;
    for (const e of this.heap) if (!e.canceled) n++;
    return n;
  }

  /** Virtual time of the soonest pending firing, or Infinity when idle. */
  nextEventTime(): number {
    while (this.heap.length > 0 && this.heap[0].canceled) this.pop();
    return this.heap.length > 0 ? this.heap[0].due : Infinity;
  }

  /** Drop all pending timers; time is kept. */
  /** Rewind the virtual clock to zero and drop every pending task. */
  restart(): void {
    this.clearAll();
    this.time = 0;
  }

  clearAll(): void {
    for (const e of this.heap) e.canceled = true;
    this.heap.length = 0;
  }

  private insert(due: number, action: () => void, period: number | null): TimerId {
    const entry: TimerEntry = {
      id: this.nextId++,
      due,
      seq: ++this.seq,
      action,
      period,
      canceled: false,
    };
    this.push(entry);
    return entry.id;
  }

  // Binary min-heap over TimerEntry.
  private push(entry: TimerEntry): void {
    const h = this.heap;
    h.push(entry);
    let i = h.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (precedes(h[i], h[parent])) {
        [h[i], h[parent]] = [h[parent], h[i]];
        i = parent;
      } else break;
    }
  }

  private pop(): TimerEntry {
    const h = this.heap;
    const top = h[0];
    const last = h.pop()!;
    if (h.length > 0) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        let m = i;
        if (l < h.length && precedes(h[l], h[m])) m = l;
        if (r < h.length && precedes(h[r], h[m])) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m], h[i]];
        i = m;
      }
    }
    return top;
  }
}
