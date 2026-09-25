/**
 * Array declarators follow C's initializer rule: the declared size is the
 * size of the array, everything past the last initializer is zero-filled, and
 * only too many initializers is an error. Both declaration sites - file scope
 * and inside a function - go through the same rule, so a sketch cannot tell
 * them apart.
 */
import { describe, it, expect } from 'vitest';
import { Interpreter, type HostValue, type SketchGen } from '../core/sketch/interp';
import { parse } from '../core/sketch/parser';
import { Esp8266Machine } from '../core/machine';

function drive(gen: SketchGen): void {
  let r = gen.next();
  let guard = 0;
  while (!r.done) {
    if (++guard > 100_000) throw new Error('drive guard tripped');
    r = gen.next();
  }
}

/** Run `body` as setup() against a println-only host and return its output. */
function out(body: string, globals = ''): string[] {
  const log: string[] = [];
  const interp = new Interpreter(parse(`${globals}\nvoid setup() { ${body} }`), {
    call: (_name: string, args: HostValue[]) => {
      log.push(args.map(String).join(' '));
      return { value: 0 };
    },
    constants: {},
    millis: () => 0,
    micros: () => 0,
  });
  drive(interp.setup());
  return log;
}

const failsWith = (body: string, globals = ''): string => {
  try {
    out(body, globals);
  } catch (e) {
    return (e as Error).message;
  }
  return '';
};

const boot = (src: string): Esp8266Machine => {
  const m = new Esp8266Machine({ board: 'wemos-d1-mini' });
  m.load(src);
  m.run();
  return m;
};

describe('array size comes from the declaration', () => {
  it('a shorter initializer list zero-fills the rest (file scope)', () => {
    const m = boot(`
      int buf[40] = {0};
      int part[5] = {1, 2};
      void setup() { Serial.begin(115200); Serial.println(buf[39]); }
      void loop() { delay(10); }
    `);
    const buf = m.variables().find((v) => v.name === 'buf');
    expect(buf?.length).toBe(40);
    expect(m.serial.map((l) => l.text)).toEqual(['0']);
    expect(m.variables().find((v) => v.name === 'part')?.elements).toEqual([1, 2, 0, 0, 0]);
    m.dispose();
  });

  it('a shorter initializer list zero-fills the rest (function scope)', () => {
    // used to be a hard error: "array size 5 but 2 initializers"
    expect(out('int a[5] = {1, 2}; println(a[0]); println(a[1]); println(a[4]);'))
      .toEqual(['1', '2', '0']);
  });

  it('the declared size is real: writing past it is still out of bounds', () => {
    expect(failsWith('int a[5] = {1}; a[5] = 2;')).toMatch(/index 5 out of bounds/i);
    expect(failsWith('int a[5] = {1}; println(a[4]);')).toBe('');
  });

  it('a full list and a deduced list keep working', () => {
    expect(out('int a[3] = {1, 2, 3}; println(a[2]);')).toEqual(['3']);
    expect(out('int b[] = {7, 8, 9}; println(b[2]);')).toEqual(['9']);
  });

  it('too many initializers is an error at both scopes', () => {
    expect(failsWith('int a[2] = {1, 2, 3};')).toMatch(/size 2 but 3 initializers/i);
    expect(failsWith('', 'int a[2] = {1, 2, 3};')).toMatch(/size 2 but 3 initializers/i);
  });

  it('a negative declared size is an error, not an empty array', () => {
    expect(failsWith('int a[-1] = {1};')).toMatch(/negative size/i);
  });

  it('a scalar initializer for an array leaves an array of the declared size', () => {
    // not valid C++; the emulator keeps the declaration's word for the size
    expect(out('int a[3] = 5; println(a[0]); println(a[2]);')).toEqual(['0', '0']);
    expect(failsWith('', 'int a[3] = 5;')).toBe('');
    const m = boot(`
      int a[3] = 5;
      void setup() { Serial.begin(115200); Serial.println(a[2]); }
      void loop() { delay(10); }
    `);
    expect(m.serial.map((l) => l.text)).toEqual(['0']);
    expect(m.variables().find((v) => v.name === 'a')?.length).toBe(3);
    m.dispose();
  });
});

describe('element type of the filled-in tail', () => {
  it('a String array pads with empty strings, not with zero', () => {
    expect(out('String n[3] = {"a"}; println(n[0]); println(n[1]); println(n[2]);'))
      .toEqual(['a', '', '']);
  });

  it('a float array pads with 0, an int array with integer 0', () => {
    expect(out('float f[3] = {1.5}; println(f[0]); println(f[2]);')).toEqual(['1.5', '0']);
    expect(out('int i[3] = {1}; println(i[2] + 1);')).toEqual(['1']);
  });

  it('char arrays initialized from a literal hold bytes and NUL padding', () => {
    expect(out('char t[8] = "abc"; println(t[0]); println(t[2]); println(t[3]); println(t[7]);'))
      .toEqual(['97', '99', '0', '0']);
  });

  it('a literal that exactly fills the array is legal, one byte more is not', () => {
    expect(out('char t[3] = "abc"; println(t[2]);')).toEqual(['99']);
    expect(failsWith('char t[2] = "abc";')).toMatch(/size 2 but 3/i);
  });

  it('the same rule holds for file-scope char arrays', () => {
    const m = boot(`
      char tag[8] = "id7";
      void setup() { Serial.begin(115200); Serial.println(tag[2]); Serial.println(tag[4]); }
      void loop() { delay(10); }
    `);
    expect(m.serial.map((l) => l.text)).toEqual(['55', '0']);
    expect(m.variables().find((v) => v.name === 'tag')?.length).toBe(8);
    m.dispose();
  });
});

describe('the pattern real sketches write', () => {
  it('an all-zero timestamp array is writable at every index', () => {
    const m = boot(`
      unsigned long prev[4] = {0};
      void setup() {
        Serial.begin(115200);
        prev[3] = millis() + 7;
        Serial.println(prev[3]);
        Serial.println(prev[0]);
      }
      void loop() { delay(10); }
    `);
    expect(m.serial.map((l) => l.text)).toEqual(['7', '0']);
    m.dispose();
  });

  it('a byte array sized for a payload keeps its initializer and its tail', () => {
    const m = boot(`
      byte mac[6] = { 0xDE, 0xED, 0xBA };
      void setup() {
        Serial.begin(115200);
        Serial.println(mac[2]);
        Serial.println(mac[5]);
      }
      void loop() { delay(10); }
    `);
    expect(m.serial.map((l) => l.text)).toEqual(['186', '0']);
    expect(m.variables().find((v) => v.name === 'mac')?.length).toBe(6);
    m.dispose();
  });
});
