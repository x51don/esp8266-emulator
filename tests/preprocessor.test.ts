/**
 * F1 preprocessor upgrade: conditional compilation (#ifdef/#ifndef/#else/
 * #elif/#endif with a #if 0/1 bonus), truly empty #defines (ICACHE_RAM_ATTR
 * style), comment stripping after #define values and literal $ in values.
 * Unit level on preprocess() plus one machine-level sketch.
 */
import { describe, it, expect } from 'vitest';
import { preprocess } from '../core/sketch/lexer';
import { Esp8266Machine } from '../core/machine';

const pp = (src: string): string => preprocess(src).code;

describe('preprocessor - conditionals (F1)', () => {
  it('drops the branch of an undefined name', () => {
    const out = pp('#ifdef A\nkept();\n#endif\nafter();');
    expect(out).not.toContain('kept');
    expect(out).toContain('after');
  });

  it('keeps the branch of a defined name', () => {
    const out = pp('#define GABINET\n#ifdef GABINET\nkept();\n#endif');
    expect(out).toContain('kept();');
  });

  it('undefined-region content never reaches the parser, garbage included', () => {
    const m = new Esp8266Machine({ board: 'wemos-d1-mini' });
    m.load(
      `#define ROOM\n#ifdef ROOM\nvoid setup() { Serial.begin(9600); Serial.println("live"); }\nvoid loop() { delay(1); }\n#else\nvoid setup() { this is ][ not @@@ c++ }\n#endif`,
    );
    m.run();
    m.advance(2);
    expect(m.serial.some((l) => l.text === 'live')).toBe(true);
  });

  it('#ifndef + #else select the fallback branch', () => {
    const out = pp('#ifndef X\nfirst();\n#else\nsecond();\n#endif');
    expect(out).toContain('first();');
    expect(out).not.toContain('second();');
  });

  it('only one of the #else branches is taken when the name IS defined', () => {
    const out = pp('#define X 1\n#ifndef X\nfirst();\n#else\nsecond();\n#endif');
    expect(out).not.toContain('first();');
    expect(out).toContain('second();');
  });

  it('nested #ifdef inside a dropped branch stays dropped', () => {
    const out = pp('#define INNER\n#ifdef OUTER\n#ifdef INNER\nhidden();\n#endif\n#endif\nafter();');
    expect(out).not.toContain('hidden');
    expect(out).toContain('after();');
  });

  it('a #define inside a dropped branch does not take effect', () => {
    const out = pp('#ifdef NOPE\n#define YES 1\n#endif\n#ifdef YES\nhidden();\n#endif');
    expect(out).not.toContain('hidden');
  });

  it('#if 0 / #if 1 pick branches, anything else in #if throws', () => {
    expect(pp('#if 0\nhidden();\n#endif')).not.toContain('hidden');
    expect(pp('#if 1\nkept();\n#endif')).toContain('kept();');
    expect(() => pp('#if SOMETHING(2+2)\nx();\n#endif')).toThrow(/#if/);
  });

  it('#elif defined(NAME) chains, first match wins', () => {
    const out = pp('#define B\n#ifdef A\none();\n#elif defined(B)\ntwo();\n#elif defined(C)\nthree();\n#else\nfour();\n#endif');
    expect(out).toContain('two();');
    expect(out).not.toContain('one();');
    expect(out).not.toContain('three();');
    expect(out).not.toContain('four();');
  });

  it('#endif without #ifdef and #else without #ifdef throw', () => {
    expect(() => pp('x();\n#endif')).toThrow(/#endif/);
    expect(() => pp('#else\nx();\n#endif')).toThrow(/#else/);
  });
});

describe('preprocessor - #define fixes (F1)', () => {
  it('an empty define expands to nothing, not 1', () => {
    const out = pp('#define ICACHE_RAM_ATTR\nvoid ICACHE_RAM_ATTR f() {}');
    expect(out).toContain('void  f() {}');
    expect(out).not.toMatch(/void 1 f/);
  });

  it('a // comment after the value is stripped, not injected', () => {
    const out = pp('#define M 48   // max time to open\nint v = M;');
    expect(out).toContain('int v = 48;');
    expect(out).not.toContain('max time');
  });

  it('slashes inside a string value survive the comment strip', () => {
    const out = pp('#define U "http://a.b"\nString s = U;');
    expect(out).toContain('String s = "http://a.b";');
  });

  it('$ in a value stays literal (no replace-pattern magic)', () => {
    const out = pp('#define V "a$&b$1c"\nString s = V;');
    expect(out).toContain('String s = "a$&b$1c";');
  });

  it('bare #define still answers true to #ifdef', () => {
    const out = pp('#define FIXEDIP\n#ifdef FIXEDIP\nyes();\n#endif');
    expect(out).toContain('yes();');
  });
});

describe('room-select sketch end to end (F1)', () => {
  it('compiles the roller-shutter room pattern and runs the active branch', () => {
    const m = new Esp8266Machine({ board: 'wemos-d1-mini' });
    m.load(`
      #define GABINET
      #define ICACHE_RAM_ATTR
      #define _MAX_COUNTER 48   // ticks to open
      #define _MY_ON LOW

      #ifdef GABINET
        #define _UP_RELAY_PIN 13
        int target = _MAX_COUNTER;
      #else
        #define _UP_RELAY_PIN 5
        int target = 0;
      #endif

      #ifdef NO_SUCH_ROOM
        void broken( is ][ @@@ here
      #endif

      void ICACHE_RAM_ATTR up_irq() {}

      void setup() {
        Serial.begin(9600);
        Serial.println(target);
        Serial.println(_UP_RELAY_PIN);
        Serial.println(_MY_ON);
      }
      void loop() { delay(10); }
    `);
    m.run();
    m.advance(2);
    const texts = m.serial.map((l) => l.text);
    expect(texts).toContain('48');
    expect(texts).toContain('13');
    expect(texts).toContain('0'); // LOW
  });
});
