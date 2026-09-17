import { describe, it, expect } from 'vitest';
import { parse } from '../core/sketch/parser';

// Recursive-descent parser producing a plain-object AST for the Arduino-C++ subset.

const BLINK = `
int ledPin = D2;
bool on = false;

void setup() {
  pinMode(ledPin, OUTPUT);
}

void loop() {
  digitalWrite(ledPin, HIGH);
  delay(500);
  on = !on;
}
`;

describe('parse - program structure', () => {
  it('collects global variable declarations and function definitions', () => {
    const p = parse(BLINK.replace('D2', '2'));
    expect(p.globals.map((g) => g.kind).join(',')).toBe('VarDecl,VarDecl,FuncDef,FuncDef');
    const setup = p.globals.find((g) => g.kind === 'FuncDef' && (g as any).name === 'setup');
    expect(setup).toBeDefined();
    expect((setup as any).returnType).toBe('void');
    expect((setup as any).params).toEqual([]);
  });

  it('parses function parameters with types', () => {
    const p = parse('void fade(int pin, unsigned long ms) {}');
    const f = p.globals[0] as any;
    expect(f.params).toEqual([
      { name: 'pin', type: 'int' },
      { name: 'ms', type: 'unsigned long' },
    ]);
  });

  it('parses global var with initializer and const/static modifiers', () => {
    const p = parse('const int K = 7;\nstatic long counter;');
    expect(p.globals).toHaveLength(2);
    const g0 = p.globals[0] as any;
    expect(g0.isConst).toBe(true);
    expect(g0.decls[0].init).toMatchObject({ kind: 'Num', v: 7 });
    const g1 = p.globals[1] as any;
    expect(g1.isStatic).toBe(true);
    expect(g1.decls[0].init).toBeNull();
  });

  it('parses multiple declarators per statement', () => {
    const p = parse('int a = 1, b, c = 3;');
    const g = p.globals[0] as any;
    expect(g.decls.map((d: any) => d.name)).toEqual(['a', 'b', 'c']);
  });
});

describe('parse - statements', () => {
  const fnBody = (src: string) => (parse(src).globals[0] as any).body.body;

  it('parses if / else if / else chains', () => {
    const s = fnBody('void f() { if (a) x(); else if (b) y(); else z(); }');
    expect(s[0].kind).toBe('If');
    expect(s[0].alt.kind).toBe('If');
    expect(s[0].alt.alt.kind).toBe('ExprStmt');
  });

  it('attaches dangling else to the innermost if', () => {
    const s = fnBody('void f() { if (a) if (b) x(); else y(); }');
    expect(s[0].consequent.kind).toBe('If');
    expect(s[0].consequent.alt).not.toBeNull();
    expect(s[0].alt).toBeNull();
  });

  it('parses for-loop header pieces', () => {
    const s = fnBody('void f() { for (int i = 0; i < 10; i++) sum += i; }');
    const f = s[0];
    expect(f.kind).toBe('For');
    expect(f.init.kind).toBe('VarDeclStmt');
    expect(f.cond.kind).toBe('Binary');
    expect(f.update.kind).toBe('Update');
    expect(f.update.postfix).toBe(true);
  });

  it('parses while and do-while', () => {
    const s = fnBody('void f() { while (x) y(); do { z(); } while (q); }');
    expect(s.map((n: any) => n.kind)).toEqual(['While', 'DoWhile']);
  });

  it('parses return with and without value, break and continue', () => {
    const s = fnBody('void f() { for(;;){ if (a) break; if (b) continue; } return 1; }');
    const body = s[0].body.body.map((n: any) => n.kind);
    expect(body).toEqual(['If', 'If']);
    const ret = s[1];
    expect(ret.kind).toBe('Return');
    expect(ret.arg).toMatchObject({ kind: 'Num', v: 1 });
  });

  it('parses local arrays with initializer lists', () => {
    const s = fnBody('void f() { int pins[] = {2, 4, 5}; int n = pins[1]; }');
    const a = s[0].decls[0];
    expect(a.arraySize).toBeNull(); // size deduced
    expect(a.init.kind).toBe('ArrayLit');
    expect(a.init.elems).toHaveLength(3);
    const n = s[1].decls[0];
    expect(n.init.kind).toBe('Index');
  });

  it('rejects unsupported constructs with a helpful message', () => {
    expect(() => parse('void f() { goto end; }')).toThrow(/goto/);
    expect(() => parse('struct S { int x; };')).toThrow(/struct/);
  });
});

describe('parse - expressions', () => {
  const exprOf = (src: string) => (parse(`void f(){ ${src} }`).globals[0] as any).body.body[0].expr;

  it('applies * over + precedence', () => {
    const e = exprOf('1 + 2 * 3;');
    expect(e.kind).toBe('Binary');
    expect(e.op).toBe('+');
    expect(e.right).toMatchObject({ kind: 'Binary', op: '*' });
  });

  it('groups || lower than &&', () => {
    const e = exprOf('a || b && c;');
    expect(e.kind).toBe('Logical');
    expect(e.op).toBe('||');
    expect(e.right.op).toBe('&&');
  });

  it('makes assignment right-associative and lowest precedence', () => {
    const e = exprOf('a = b = c;');
    expect(e.kind).toBe('Assign');
    expect(e.value.kind).toBe('Assign');
  });

  it('parses compound assignments', () => {
    const e = exprOf('x += 2;');
    expect(e).toMatchObject({ kind: 'Assign', op: '+=' });
  });

  it('parses ternary between || and assign', () => {
    const e = exprOf('x = a ? b : c ? d : e;');
    expect(e.kind).toBe('Assign');
    expect(e.value.kind).toBe('Cond');
    expect(e.value.alt.kind).toBe('Cond');
  });

  it('parses call chains, indexing and casts', () => {
    const e = exprOf('map(analogRead(A0), 0, 1023, 0, 255) + (unsigned long) y;');
    expect(e.left.kind).toBe('Call');
    expect(e.right.kind).toBe('Cast');
    expect(e.right.castType).toBe('unsigned long');
  });

  it('parses prefix and postfix update expressions distinctly', () => {
    const a = exprOf('i++;');
    const b = exprOf('--i;');
    expect(a).toMatchObject({ kind: 'Update', op: '++', postfix: true });
    expect(b).toMatchObject({ kind: 'Update', op: '--', postfix: false });
  });

  it('parses boolean and bitwise operators', () => {
    const e = exprOf('a & 0xFF | b << 2 && !c;');
    expect(e.kind).toBe('Logical');
    expect(e.left.op).toBe('|');
    expect(e.left.left.op).toBe('&');
  });
});

describe('parse - diagnostics', () => {
  it('reports the line of a missing semicolon', () => {
    expect(() => parse('void f() {\n int a = 1\n bad;\n}')).toThrow(/line 3|near 'bad'/);
  });

  it('reports unbalanced braces', () => {
    expect(() => parse('void f() {')).toThrow(/unexpected end of input|expected/);
  });
});
