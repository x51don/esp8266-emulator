/**
 * A declarator may carry more than one dimension: `int m[2][3]` is an array of
 * two arrays of three ints, indexed as `m[r][c]`. The C initializer rules of
 * the single-dimension case carry over per dimension - the declared shape wins,
 * a missing tail is filled in, and both a nested and a flat initializer list
 * describe the same matrix.
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

describe('two-dimensional arrays', () => {
  it('a matrix declaration parses and reads back every cell', () => {
    expect(out('int m[2][3] = {{1,2,3},{4,5,6}}; println(m[0][0]); println(m[0][2]); println(m[1][0]); println(m[1][2]);'))
      .toEqual(['1', '3', '4', '6']);
  });

  it('a missing tail is filled in per row and per matrix', () => {
    expect(out('int m[2][3] = {{1}}; println(m[0][0]); println(m[0][1]); println(m[1][2]);'))
      .toEqual(['1', '0', '0']);
  });

  it('a flat initializer fills the matrix row-major, like C', () => {
    expect(out('int m[2][3] = {1,2,3,4,5,6}; println(m[1][0]); println(m[1][2]);'))
      .toEqual(['4', '6']);
    expect(out('int m[2][2] = {1,2}; println(m[1][0]); println(m[1][1]);'))
      .toEqual(['0', '0']);
  });

  it('writes through both index operators land in the matrix', () => {
    expect(out('int m[2][2]; m[1][0] = 7; m[1][0]++; println(m[1][0]); println(m[0][1]);'))
      .toEqual(['8', '0']);
  });

  it('a matrix reads as nested rows', () => {
    const m = boot(`
      int m[2][2] = {{1,2},{3,4}};
      void setup() { Serial.begin(115200); Serial.println(m); }
      void loop() { delay(10); }
    `);
    expect(m.serial.map((l) => l.text)).toEqual(['[[1,2],[3,4]]']);
    m.dispose();
  });

  it('floats keep their kind in every cell', () => {
    expect(out('float m[2][2] = {{1.5,0},{0,0}}; println(m[0][0]); println(m[1][1]);'))
      .toEqual(['1.5', '0']);
  });

  it('the first dimension may be left to the initializer', () => {
    expect(out('int m[][2] = {{1,2},{3,4},{5,6}}; println(m[2][1]);')).toEqual(['6']);
    expect(out('int m[][3] = {1,2,3,4,5,6}; println(m[1][1]);')).toEqual(['5']);
  });

  it('three dimensions nest the same way', () => {
    expect(out('int c[2][2][2]; c[1][1][1] = 5; println(c[1][1][1]); println(c[0][0][0]);'))
      .toEqual(['5', '0']);
  });

  it('a char matrix takes string rows as bytes', () => {
    expect(out('char t[2][4] = {"ab","cd"}; println(t[1][0]); println(t[0][1]); println(t[1][3]);'))
      .toEqual(['99', '98', '0']);
  });

  it('too many rows or cells is an error, at both scopes', () => {
    expect(failsWith('int m[1][2] = {{1,2},{3,4}};')).toMatch(/size/i);
    expect(failsWith('int m[2][2] = {{1,2,3},{4,5}};')).toMatch(/size/i);
    expect(failsWith('', 'int m[1][2] = {{1,2},{3,4}};')).toMatch(/size/i);
  });

  it('an index outside either dimension is an error', () => {
    expect(failsWith('int m[2][3] = {{1,2,3},{4,5,6}}; println(m[2][0]);'))
      .toMatch(/index 2 out of bounds \(size 2\)/);
    expect(failsWith('int m[2][3] = {{1,2,3},{4,5,6}}; println(m[0][3]);'))
      .toMatch(/index 3 out of bounds \(size 3\)/);
  });

  it('a matrix passed to a function is the same matrix', () => {
    const globals = `
      void mark(int m[2][3], int v) { m[1][2] = v; }
    `;
    expect(out('int m[2][3]; mark(m, 9); println(m[1][2]);', globals)).toEqual(['9']);
  });

  it('a matrix of pins scans with two loops, file scope', () => {
    const m = boot(`
      int keys[2][3] = {{1,2,3},{4,5,6}};
      void setup() {
        Serial.begin(115200);
        int sum = 0;
        for (int r = 0; r < 2; r++) for (int c = 0; c < 3; c++) sum += keys[r][c];
        Serial.println(sum);
      }
      void loop() { delay(10); }
    `);
    expect(m.serial.map((l) => l.text)).toEqual(['21']);
    const v = m.variables().find((x) => x.name === 'keys');
    expect(v?.length).toBe(2);
    expect(v?.dims).toEqual([2, 3]);
    expect(v?.elements).toEqual(['[1,2,3]', '[4,5,6]']);
    m.dispose();
  });
});
