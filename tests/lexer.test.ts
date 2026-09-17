import { describe, it, expect } from 'vitest';
import { tokenize, preprocess } from '../core/sketch/lexer';

// Lexer for the Arduino-C++ subset accepted by the emulator.

describe('tokenize - literals and identifiers', () => {
  it('reads identifiers and decimal integers', () => {
    const t = tokenize('ledPin = 13;');
    expect(t.map((x) => x.type).join(',')).toBe('ident,punct,num,punct,eof');
    expect(t[0].value).toBe('ledPin');
    expect(t[2].num).toBe(13);
  });

  it('reads hex, suffixes and floats', () => {
    const t = tokenize('0x10 1000L 500UL 1.5 2.0f');
    expect(t.filter((x) => x.type === 'num').map((x) => x.num)).toEqual([16, 1000, 500, 1.5, 2]);
  });

  it('marks integer vs float literals', () => {
    const t = tokenize('1 2.5');
    expect(t[0].isFloat).toBe(false);
    expect(t[1].isFloat).toBe(true);
  });

  it('reads char and string literals with escapes', () => {
    const t = tokenize(`'\\n' "a\\"b" "tab\\there"`);
    expect(t[0].value).toBe('\n');
    expect(t[1].value).toBe('a"b');
    expect(t[2].value).toBe('tab\there');
  });

  it('rejects unterminated string with line number', () => {
    expect(() => tokenize('int x;\nstring s = "oops;')).toThrow(/line 2/);
  });
});

describe('tokenize - operators and punctuation', () => {
  it('lexes multi-character operators greedily', () => {
    const t = tokenize('a <<= b; c >>= d; e &&= f;');
    const ops = t.filter((x) => x.type === 'punct').map((x) => x.value);
    expect(ops).toContain('<<=');
    expect(ops).toContain('>>=');
    expect(ops).toContain('&&=');
  });

  it('distinguishes ++ from + + and reads all C operators', () => {
    const src = 'a++ --b += -= *= /= %= <<= >>= && || ! ~ ^ | & < <= > >= == != ? : ; , . ( ) [ ] { } = + - * / % < >';
    const t = tokenize(src);
    const ops = t.filter((x) => x.type === 'punct').map((x) => x.value);
    expect(ops.slice(0, 2)).toEqual(['++', '--']);
    for (const op of ['+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '&&', '||', '~', '^', '|', '&', '<=', '>=', '==', '!=']) {
      expect(ops).toContain(op);
    }
  });
});

describe('tokenize - comments', () => {
  it('strips line and block comments', () => {
    const t = tokenize('x // note\n/* block\ncomment */ y');
    const names = t.filter((x) => x.type === 'ident').map((x) => x.value);
    expect(names).toEqual(['x', 'y']);
  });

  it('does not strip comment markers inside strings', () => {
    const t = tokenize('"http://example.com"');
    expect(t[0].value).toBe('http://example.com');
  });

  it('reports unterminated block comment', () => {
    expect(() => tokenize('/* never closed')).toThrow(/block comment/);
  });
});

describe('preprocess - #define and #include', () => {
  it('drops #include lines', () => {
    const { code } = preprocess('#include <Arduino.h>\nint x;');
    expect(code).not.toContain('Arduino.h');
    expect(code).toContain('int x;');
  });

  it('expands object-like defines with numeric or string bodies', () => {
    const src = '#define LED 2\n#define MSG "hi"\ndigitalWrite(LED, 1); Serial.print(MSG);';
    const { code } = preprocess(src);
    const t = tokenize(code);
    expect(t.some((x) => x.num === 2)).toBe(true);
    expect(t.some((x) => x.value === 'hi')).toBe(true);
  });

  it('supports #define aliases of identifiers', () => {
    const { code } = preprocess('#define BLINK LED_BUILTIN\nvoid setup(){digitalWrite(BLINK,1);}');
    expect(code).toContain('digitalWrite(LED_BUILTIN,1)');
  });

  it('rejects function-like macros with a clear message', () => {
    expect(() => preprocess('#define MAX(a,b) ((a)>(b)?(a):(b))')).toThrow(/function-like macros/i);
  });
});

describe('source positions', () => {
  it('tokens carry 1-based line numbers for diagnostics', () => {
    const t = tokenize('int a;\nint b;');
    const bs = t.find((x) => x.value === 'b');
    expect(bs?.line).toBe(2);
  });
});
