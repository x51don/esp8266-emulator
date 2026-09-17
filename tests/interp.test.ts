import { describe, it, expect } from 'vitest';
import { Interpreter, SketchRuntimeError, type HostValue, type SketchGen } from '../core/sketch/interp';
import { parse } from '../core/sketch/parser';

// The interpreter runs a sketch cooperatively: it is a JS generator that yields
// suspend requests (e.g. delay()) and is resumed by the machine's scheduler.
// Tests drive the generator manually, so no wall time is ever spent.

interface TestEnv {
  log: string[];
  constants: Record<string, number>;
  millis: number;
}

// Minimal host for pure-language tests: functions used by sketches below.
function makeHost(env: TestEnv) {
  const calls = (name: string, args: HostValue[]): { value?: HostValue; isFloat?: boolean; suspend?: { kind: 'delay'; us: number } } => {
    switch (name) {
      case 'println': env.log.push(args.map(String).join(' ')); return { value: 0 };
      case 'idiv': return { value: Math.trunc(Number(args[0]) / Number(args[1])) };
      case 'mark': env.log.push(String(args[0])); return { value: 1 };
      case 'delay': return { suspend: { kind: 'delay', us: Number(args[0]) * 1000 } };
      case 'getMillis': return { value: env.millis, isFloat: false };
      default: throw new Error(`no such host function: ${name}`);
    }
  };
  return calls;
}

function run(src: string, opts: { millis?: number; constants?: Record<string, number> } = {}) {
  const env: TestEnv = { log: [], constants: { HIGH: 1, LOW: 0, ...(opts.constants ?? {}) }, millis: opts.millis ?? 0 };
  const program = parse(src);
  const interp = new Interpreter(program, {
    call: (name, args) => makeHost(env)(name, args),
    constants: env.constants,
    millis: () => env.millis,
    micros: () => env.millis * 1000,
  });
  return { env, interp };
}

/** Drive a generator to completion; delays are honoured virtually. */
function drive(gen: SketchGen, onDelay?: (us: number) => void): void {
  let r = gen.next();
  let guard = 0;
  while (!r.done) {
    if (++guard > 100_000) throw new Error('drive guard tripped');
    if (r.value.kind === 'delay') onDelay?.(r.value.us);
    r = gen.next();
  }
}

describe('expressions - C semantics', () => {
  const out = (src: string): string[] => {
    const { env, interp } = run(`void setup(){ ${src} }`);
    drive(interp.setup());
    return env.log;
  };

  it('integer division truncates, float division does not', () => {
    expect(out('println(5 / 2); println(5.0 / 2);')).toEqual(['2', '2.5']);
  });

  it('modulo follows C sign rules', () => {
    expect(out('println(-7 % 3); println(7 % 3);')).toEqual(['-1', '1']);
  });

  it('mixed int/float arithmetic promotes to float', () => {
    expect(out('int a = 1; float b = 0.5; println(a + b);')).toEqual(['1.5']);
  });

  it('bitwise and shift operators', () => {
    expect(out('println(0xF0 & 0x3C); println(1 << 8); println(~0);')).toEqual(['48', '256', '-1']);
  });

  it('boolean is 0/1 and conditions test nonzero', () => {
    expect(out('println(3 && 2); println(0 || 5); println(!7);')).toEqual(['1', '1', '0']);
  });

  it('&& and || short-circuit', () => {
    expect(out('println(0 && mark("no")); println(mark("yes") || mark("no2"));'))
      .toEqual(['0', 'yes', '1']);
  });

  it('char literals are their numeric code, strings concatenate with +', () => {
    expect(out("println('A'); String s = \"ab\"; s += \"cd\"; println(s); println(\"n=\" + 5);"))
      .toEqual(['65', 'abcd', 'n=5']);
  });

  it('casts truncate floats and keep integer values', () => {
    expect(out('println((int) 2.9); println((int) -2.9); println((float) 3);')).toEqual(['2', '-2', '3']);
  });

  it('ternary and compound assignment and comma', () => {
    expect(out('int x = 1; x += 2; x *= 3; println(x); println(x > 8 ? 1 : 0, 9);'))
      .toEqual(['9', '1 9']);
  });
});

describe('statements and control flow', () => {
  const out = (src: string): string[] => {
    const { env, interp } = run(`void setup(){ ${src} }`);
    drive(interp.setup());
    return env.log;
  };

  it('sums a for loop', () => {
    expect(out('int s = 0; for (int i = 0; i < 10; i++) s += i; println(s);')).toEqual(['45']);
  });

  it('while and do-while', () => {
    expect(out('int i = 3; while (i) i--; do { i++; } while (i < 2); println(i);')).toEqual(['2']);
  });

  it('break leaves innermost loop, continue skips to next iteration', () => {
    expect(out('int s = 0; for (int i = 0; i < 10; i++) { if (i == 3) continue; if (i == 6) break; s += i; } println(s);'))
      .toEqual(['12']); // 0+1+2+4+5
  });

  it('if/else if/else chain', () => {
    expect(out('for (int i = 0; i < 3; i++) { if (i == 0) println("a"); else if (i == 1) println("b"); else println("c"); }'))
      .toEqual(['a', 'b', 'c']);
  });
});

describe('functions and scope', () => {
  it('user functions with return values and recursion', () => {
    const { env, interp } = run(`
      int add(int a, int b) { return a + b; }
      int fib(int n) { if (n < 2) return n; return fib(n - 1) + fib(n - 2); }
      void setup() { println(add(2, 3)); println(fib(10)); }
    `);
    drive(interp.setup());
    expect(env.log).toEqual(['5', '55']);
  });

  it('static locals keep their value between calls', () => {
    const { env, interp } = run(`
      int tick() { static int n = 0; return n++; }
      void setup() { tick(); tick(); println(tick()); }
    `);
    drive(interp.setup());
    expect(env.log).toEqual(['2']);
  });

  it('globals are visible and writable from functions', () => {
    const { env, interp } = run(`
      int counter = 40;
      void bump() { counter += 2; }
      void setup() { bump(); bump(); println(counter); }
    `);
    drive(interp.setup());
    expect(env.log).toEqual(['44']);
  });

  it('parameters shadow globals locally', () => {
    const { env, interp } = run(`
      int x = 1;
      int show(int x) { return x; }
      void setup() { println(show(9)); println(x); }
    `);
    drive(interp.setup());
    expect(env.log).toEqual(['9', '1']);
  });
});

describe('arrays', () => {
  it('declares with size, deduces from initializer, reads and writes', () => {
    run(`
      void setup() {
        int a[3] = {1, 2, 3};
        int b[] = {7, 8};
        b[1] = 9;
        println(a[2]); println(b[1]);
      }
    `);
    expect(() => drive(run('void setup(){ int a[2]; println(a[5]); }').interp.setup()))
      .toThrow(/index 5 out of bounds/i);
  });

  it('arrays pass by reference into functions', () => {
    const { env, interp } = run(`
      void setFirst(int arr[], int v) { arr[0] = v; }
      void setup() { int a[] = {1, 2}; setFirst(a, 42); println(a[0]); }
    `);
    drive(interp.setup());
    expect(env.log).toEqual(['42']);
  });
});

describe('cooperative execution', () => {
  it('delay suspends the generator for the requested virtual time', () => {
    const { interp } = run('void setup(){ delay(500); delay(1); }');
    const delays: number[] = [];
    drive(interp.setup(), (us) => delays.push(us));
    expect(delays).toEqual([500000, 1000]);
  });

  it('millis and micros read the injected clock', () => {
    const { env, interp } = run('void setup(){ println(millis()); }', { millis: 1234 });
    drive(interp.setup());
    expect(env.log).toEqual(['1234']);
  });

  it('setup runs once, loop runs one iteration per call', () => {
    const { env, interp } = run('int n = 0; void setup(){ n = 1; } void loop(){ n++; println(n); }');
    drive(interp.setup());
    drive(interp.loopOnce());
    drive(interp.loopOnce());
    expect(env.log).toEqual(['2', '3']);
  });
});

describe('diagnostics', () => {
  it('unknown identifiers report name and line', () => {
    const { interp } = run('void setup(){ int x = nonexistentVar; }');
    expect(() => drive(interp.setup())).toThrow(SketchRuntimeError);
    try {
      drive(interp.setup());
    } catch (e) {
      expect((e as Error).message).toMatch(/nonexistentVar/);
      expect((e as SketchRuntimeError).line).toBe(1);
    }
  });

  it('unknown function calls report name', () => {
    const { interp } = run('void setup(){ toneSomething(1); }');
    expect(() => drive(interp.setup())).toThrow(/toneSomething/);
  });

  it('assignment to const is rejected', () => {
    const { interp } = run('const int K = 5; void setup(){ K = 6; }');
    expect(() => drive(interp.setup())).toThrow(/const/i);
  });

  it('guard against runaway recursion', () => {
    const { interp } = run('void boom() { boom(); } void setup(){ boom(); }');
    expect(() => drive(interp.setup())).toThrow(/recursion|stack/i);
  });
});
