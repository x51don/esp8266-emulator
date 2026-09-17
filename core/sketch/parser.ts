/**
 * Recursive-descent parser for the Arduino-C++ subset.
 * Produces a plain-object AST consumed by core/sketch/interp.ts.
 *
 * Supported: functions, global/local variables (const/static), arrays with
 * initializers, if/else, for, while, do-while, break/continue/return,
 * full C expression grammar with casts, ternary, bitwise ops, ++/--.
 * Rejected with clear diagnostics: goto, switch, struct/class, pointers, etc.
 */

import { tokenize, Token } from './lexer';

// ---------- AST node types ----------

export interface NumLit { kind: 'Num'; v: number; isFloat: boolean; line: number }
export interface StrLit { kind: 'Str'; s: string; line: number }
export interface CharLit { kind: 'Char'; c: string; line: number }
export interface Ident { kind: 'Ident'; name: string; line: number }
export interface Unary { kind: 'Unary'; op: string; operand: Expr; line: number }
export interface Update { kind: 'Update'; op: '++' | '--'; operand: Expr; postfix: boolean; line: number }
export interface Binary { kind: 'Binary'; op: string; left: Expr; right: Expr; line: number }
export interface Logical { kind: 'Logical'; op: '&&' | '||'; left: Expr; right: Expr; line: number }
export interface Cond { kind: 'Cond'; test: Expr; cons: Expr; alt: Expr; line: number }
export interface Assign { kind: 'Assign'; op: string; target: Expr; value: Expr; line: number }
export interface Call { kind: 'Call'; callee: string; args: Expr[]; line: number }
export interface Index { kind: 'Index'; obj: Expr; index: Expr; line: number }
export interface Cast { kind: 'Cast'; castType: string; expr: Expr; line: number }
export interface ArrayLit { kind: 'ArrayLit'; elems: Expr[]; line: number }
export interface Comma { kind: 'Comma'; exprs: Expr[]; line: number }

export type Expr = NumLit | StrLit | CharLit | Ident | Unary | Update | Binary | Logical
  | Cond | Assign | Call | Index | Cast | ArrayLit | Comma;

export interface Declarator { name: string; init: Expr | null; arraySize: number | null }
export interface VarDecl {
  kind: 'VarDecl' | 'VarDeclStmt';
  type: string;
  decls: Declarator[];
  isConst: boolean;
  isStatic: boolean;
  line: number;
}
export interface FuncDef {
  kind: 'FuncDef';
  returnType: string;
  name: string;
  params: { name: string; type: string }[];
  body: Block;
  line: number;
}

export interface Block { kind: 'Block'; body: Stmt[]; line: number }
export interface ExprStmt { kind: 'ExprStmt'; expr: Expr; line: number }
export interface If { kind: 'If'; test: Expr; consequent: Stmt; alt: Stmt | null; line: number }
export interface For {
  kind: 'For'; init: Stmt | null; cond: Expr | null; update: Expr | null; body: Stmt; line: number;
}
export interface While { kind: 'While'; test: Expr; body: Stmt; line: number }
export interface DoWhile { kind: 'DoWhile'; body: Stmt; test: Expr; line: number }
export interface Return { kind: 'Return'; arg: Expr | null; line: number }
export interface Break { kind: 'Break'; line: number }
export interface Continue { kind: 'Continue'; line: number }

export type Stmt = Block | ExprStmt | VarDecl | If | For | While | DoWhile | Return | Break | Continue;

export interface Program { kind: 'Program'; globals: (VarDecl | FuncDef)[] }

// ---------- parser ----------

const TYPE_WORDS = new Set([
  'void', 'bool', 'char', 'short', 'int', 'long', 'float', 'double',
  'unsigned', 'signed', 'byte', 'word', 'String', 'uint8_t', 'uint16_t',
  'uint32_t', 'int8_t', 'int16_t', 'int32_t', 'size_t',
]);

const REJECTED_KW: Record<string, string> = {
  goto: 'goto is not supported',
  switch: 'switch/case is not supported; use if/else',
  struct: 'struct is not supported; use plain variables or functions',
  class: 'class is not supported',
  new: 'dynamic allocation (new) is not supported',
  return2: '',
};

class Parser {
  private i = 0;
  constructor(private readonly t: Token[]) {}

  private peek(offset = 0): Token {
    return this.t[Math.min(this.i + offset, this.t.length - 1)];
  }

  private next(): Token {
    return this.t[this.i++];
  }

  private isPunct(v: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.type === 'punct' && t.value === v;
  }

  private isKw(v: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.type === 'ident' && t.value === v;
  }

  private eatPunct(v: string): Token {
    if (!this.isPunct(v)) {
      const t = this.peek();
      throw new SyntaxError(
        `expected '${v}' but found '${t.value || t.type}' (line ${t.line})`,
      );
    }
    return this.next();
  }

  private eatWord(v: string): Token {
    if (!this.isKw(v)) {
      const t = this.peek();
      throw new SyntaxError(
        `expected '${v}' but found '${t.value || t.type}' (line ${t.line})`,
      );
    }
    return this.next();
  }

  // ----- program -----

  parseProgram(): Program {
    const globals: (VarDecl | FuncDef)[] = [];
    while (this.peek().type !== 'eof') {
      const line = this.peek().line;
      const { isConst, isStatic } = this.parseModifiers();
      const type = this.parseType();
      const nameTok = this.next();
      if (nameTok.type !== 'ident') {
        throw new SyntaxError(`expected identifier but found '${nameTok.value}' (line ${nameTok.line})`);
      }
      if (this.isPunct('(')) {
        globals.push(this.parseFuncDefRest(type, nameTok.value, line));
      } else {
        globals.push(this.parseDeclRest(type, nameTok.value, isConst, isStatic, line));
      }
    }
    return { kind: 'Program', globals };
  }

  private parseModifiers(): { isConst: boolean; isStatic: boolean } {
    let isConst = false;
    let isStatic = false;
    for (;;) {
      if (this.isKw('const')) { this.next(); isConst = true; }
      else if (this.isKw('static')) { this.next(); isStatic = true; }
      else break;
    }
    return { isConst, isStatic };
  }

  private parseType(): string {
    const words: string[] = [];
    for (;;) {
      const t = this.peek();
      if (t.type === 'ident' && TYPE_WORDS.has(t.value)) {
        words.push(t.value);
        this.next();
      } else break;
    }
    if (words.length === 0) {
      const t = this.peek();
      throw new SyntaxError(
        `expected a type but found '${t.value || t.type}' (line ${t.line})`,
      );
    }
    return words.join(' ');
  }

  private parseFuncDefRest(returnType: string, name: string, line: number): FuncDef {
    this.eatPunct('(');
    const params: { name: string; type: string }[] = [];
    if (!this.isPunct(')')) {
      do {
        if (this.isKw('void') && this.isPunct(')', 1)) break;
        const ptypeWords: string[] = [];
        while (this.peek().type === 'ident' && TYPE_WORDS.has(this.peek().value)) {
          ptypeWords.push(this.next().value);
        }
        const pname = this.next();
        if (pname.type !== 'ident') {
          throw new SyntaxError(`expected parameter name (line ${pname.line})`);
        }
        params.push({ name: pname.value, type: ptypeWords.join(' ') || 'int' });
      } while (this.isPunct(',') && this.next() !== undefined);
    }
    this.eatPunct(')');
    const body = this.parseBlock();
    return { kind: 'FuncDef', returnType, name, params, body, line };
  }

  private parseDeclRest(type: string, first: string, isConst: boolean, isStatic: boolean, line: number): VarDecl {
    const decls: Declarator[] = [];
    for (;;) {
      const nameTok = first !== '' && decls.length === 0 ? { value: first } : this.declName();
      let arraySize: number | null = null;
      if (this.isPunct('[')) {
        this.next();
        if (this.peek().type === 'num') arraySize = this.next().num!;
        this.eatPunct(']');
      }
      let init: Expr | null = null;
      if (this.isPunct('=')) {
        this.next();
        if (this.isPunct('{')) init = this.parseArrayLit();
        else init = this.parseAssign();
      }
      decls.push({ name: (nameTok as { value: string }).value, init, arraySize });
      if (this.isPunct(',')) { this.next(); continue; }
      break;
    }
    this.eatPunct(';');
    return { kind: 'VarDecl', type, decls, isConst, isStatic, line };
  }

  private declName(): Token {
    const t = this.next();
    if (t.type !== 'ident') throw new SyntaxError(`expected variable name (line ${t.line})`);
    return t;
  }

  private parseArrayLit(): ArrayLit {
    const line = this.peek().line;
    this.eatPunct('{');
    const elems: Expr[] = [];
    if (!this.isPunct('}')) {
      do {
        if (this.isPunct('}')) break; // trailing comma
        elems.push(this.parseAssign());
      } while (this.isPunct(',') && this.next() !== undefined);
    }
    this.eatPunct('}');
    return { kind: 'ArrayLit', elems, line };
  }

  // ----- statements -----

  private parseBlock(): Block {
    const line = this.peek().line;
    this.eatPunct('{');
    const body: Stmt[] = [];
    while (!this.isPunct('}')) {
      if (this.peek().type === 'eof') {
        throw new SyntaxError('unexpected end of input: expected \'}\'');
      }
      body.push(this.parseStmt());
    }
    this.eatPunct('}');
    return { kind: 'Block', body, line };
  }

  private parseStmt(): Stmt {
    const t = this.peek();
    if (t.type === 'eof') {
      throw new SyntaxError('unexpected end of input in statement');
    }
    if (t.type === 'ident' && t.value in REJECTED_KW && REJECTED_KW[t.value]) {
      throw new SyntaxError(`${REJECTED_KW[t.value]} (line ${t.line})`);
    }
    switch (t.type === 'ident' ? t.value : '') {
      case '{': break;
      case 'if': return this.parseIf();
      case 'for': return this.parseFor();
      case 'while': return this.parseWhile();
      case 'do': return this.parseDoWhile();
      case 'return': return this.parseReturn();
      case 'break': this.next(); this.eatPunct(';'); return { kind: 'Break', line: t.line };
      case 'continue': this.next(); this.eatPunct(';'); return { kind: 'Continue', line: t.line };
      default: break;
    }
    if (this.isPunct('{')) return this.parseBlock();

    // Local declaration? A statement starting with a type word is one.
    if (this.startsDecl()) {
      const line = t.line;
      const { isConst, isStatic } = this.parseModifiers();
      const type = this.parseType();
      const nameTok = this.declName();
      const d = this.parseDeclRest(type, nameTok.value, isConst, isStatic, line);
      return { ...d, kind: 'VarDeclStmt' };
    }

    const expr = this.parseExpr();
    this.eatPunct(';');
    return { kind: 'ExprStmt', expr, line: t.line };
  }

  private startsDecl(): boolean {
    let k = 0;
    while (this.isKw('const', k) || this.isKw('static', k)) k++;
    const t = this.peek(k);
    return t.type === 'ident' && TYPE_WORDS.has(t.value);
  }

  private parenExpr(): Expr {
    this.eatPunct('(');
    const e = this.parseExpr();
    this.eatPunct(')');
    return e;
  }

  private parseIf(): If {
    const line = this.peek().line;
    this.eatWord('if');
    const test = this.parenExpr();
    const consequent = this.parseStmt();
    let alt: Stmt | null = null;
    if (this.isKw('else')) {
      this.next();
      alt = this.parseStmt();
    }
    return { kind: 'If', test, consequent, alt, line };
  }

  private parseFor(): For {
    const line = this.peek().line;
    this.eatWord('for');
    this.eatPunct('(');
    let init: Stmt | null = null;
    if (this.isPunct(';')) this.next();
    else if (this.startsDecl()) {
      const dl = this.peek().line;
      const { isConst, isStatic } = this.parseModifiers();
      const type = this.parseType();
      const nameTok = this.declName();
      const d = this.parseDeclRest(type, nameTok.value, isConst, isStatic, dl);
      init = { ...d, kind: 'VarDeclStmt' };
    } else {
      const e = this.parseExpr();
      this.eatPunct(';');
      init = { kind: 'ExprStmt', expr: e, line };
    }
    const cond = this.isPunct(';') ? null : this.parseExpr();
    this.eatPunct(';');
    let update: Expr | null = null;
    if (!this.isPunct(')')) update = this.parseUpdateList();
    this.eatPunct(')');
    const body = this.parseStmt();
    return { kind: 'For', init, cond, update, body, line };
  }

  private parseUpdateList(): Expr {
    const first = this.parseAssign();
    if (!this.isPunct(',')) return first;
    const exprs = [first];
    while (this.isPunct(',')) {
      this.next();
      exprs.push(this.parseAssign());
    }
    return { kind: 'Comma', exprs, line: first.line };
  }

  private parseWhile(): While {
    const line = this.peek().line;
    this.eatWord('while');
    const test = this.parenExpr();
    const body = this.parseStmt();
    return { kind: 'While', test, body, line };
  }

  private parseDoWhile(): DoWhile {
    const line = this.peek().line;
    this.eatWord('do');
    const body = this.parseStmt();
    this.eatWord('while');
    const test = this.parenExpr();
    this.eatPunct(';');
    return { kind: 'DoWhile', body, test, line };
  }

  private parseReturn(): Return {
    const line = this.peek().line;
    this.eatWord('return');
    let arg: Expr | null = null;
    if (!this.isPunct(';')) arg = this.parseExpr();
    this.eatPunct(';');
    return { kind: 'Return', arg, line };
  }

  // ----- expressions (precedence climbing) -----

  private parseExpr(): Expr {
    let e = this.parseAssign();
    if (this.isPunct(',')) {
      const exprs = [e];
      while (this.isPunct(',')) {
        this.next();
        exprs.push(this.parseAssign());
      }
      e = { kind: 'Comma', exprs, line: exprs[0].line };
    }
    return e;
  }

  private parseAssign(): Expr {
    const left = this.parseCond();
    const t = this.peek();
    const assignOps = ['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '&&=', '||='];
    if (t.type === 'punct' && assignOps.includes(t.value)) {
      this.next();
      const value = this.parseAssign(); // right-associative
      return { kind: 'Assign', op: t.value, target: left, value, line: t.line };
    }
    return left;
  }

  private parseCond(): Expr {
    const test = this.parseBinary(0);
    if (this.isPunct('?')) {
      const line = this.next().line;
      const cons = this.parseAssign();
      this.eatPunct(':');
      const alt = this.parseAssign();
      return { kind: 'Cond', test, cons, alt, line };
    }
    return test;
  }

  // Precedence table (higher binds tighter)
  private static LEVELS: string[][] = [
    ['||'], ['&&'], ['|'], ['^'], ['&'],
    ['==', '!='], ['<', '<=', '>', '>='], ['<<', '>>'],
    ['+', '-'], ['*', '/', '%'],
  ];

  private parseBinary(level: number): Expr {
    if (level >= Parser.LEVELS.length) return this.parseUnary();
    let left = this.parseBinary(level + 1);
    for (;;) {
      const t = this.peek();
      if (t.type === 'punct' && Parser.LEVELS[level].includes(t.value)) {
        this.next();
        const right = this.parseBinary(level + 1);
        const kind = t.value === '&&' || t.value === '||' ? 'Logical' : 'Binary';
        left = kind === 'Logical'
          ? { kind: 'Logical', op: t.value as '&&' | '||', left, right, line: t.line }
          : { kind: 'Binary', op: t.value, left, right, line: t.line };
      } else break;
    }
    return left;
  }

  private parseUnary(): Expr {
    const t = this.peek();
    if (t.type === 'punct' && ['!', '-', '+', '~'].includes(t.value)) {
      this.next();
      return { kind: 'Unary', op: t.value, operand: this.parseUnary(), line: t.line };
    }
    if (t.type === 'punct' && (t.value === '++' || t.value === '--')) {
      this.next();
      return { kind: 'Update', op: t.value, operand: this.parseUnary(), postfix: false, line: t.line };
    }
    // Cast: (unsigned long) expr
    if (t.type === 'punct' && t.value === '(' && this.looksLikeCast()) {
      this.next();
      const words: string[] = [];
      while (this.peek().type === 'ident' && TYPE_WORDS.has(this.peek().value)) {
        words.push(this.next().value);
      }
      this.eatPunct(')');
      return { kind: 'Cast', castType: words.join(' '), expr: this.parseUnary(), line: t.line };
    }
    return this.parsePostfix();
  }

  private looksLikeCast(): boolean {
    if (!this.isPunct('(', 0)) return false;
    let k = 1;
    while (this.peek(k).type === 'ident' && TYPE_WORDS.has(this.peek(k).value)) k++;
    return k > 1 && this.isPunct(')', k);
  }

  private parsePostfix(): Expr {
    let e = this.parsePrimary();
    for (;;) {
      if (this.isPunct('(')) {
        if (e.kind !== 'Ident') {
          throw new SyntaxError(`only plain function calls are supported (line ${e.line})`);
        }
        const line = this.next().line;
        const args: Expr[] = [];
        if (!this.isPunct(')')) {
          do {
            args.push(this.parseAssign());
          } while (this.isPunct(',') && this.next() !== undefined);
        }
        this.eatPunct(')');
        e = { kind: 'Call', callee: (e as Ident).name, args, line };
      } else if (this.isPunct('[')) {
        const line = this.next().line;
        const index = this.parseExpr();
        this.eatPunct(']');
        e = { kind: 'Index', obj: e, index, line };
      } else if (this.isPunct('++') || this.isPunct('--')) {
        const op = this.next().value as '++' | '--';
        e = { kind: 'Update', op, operand: e, postfix: true, line: e.line };
      } else break;
    }
    return e;
  }

  private parsePrimary(): Expr {
    const t = this.next();
    switch (t.type) {
      case 'num':
        return { kind: 'Num', v: t.num!, isFloat: !!t.isFloat, line: t.line };
      case 'str':
        return { kind: 'Str', s: t.value, line: t.line };
      case 'char':
        return { kind: 'Char', c: t.value, line: t.line };
      case 'ident':
        return { kind: 'Ident', name: t.value, line: t.line };
      case 'punct':
        if (t.value === '(') {
          const e = this.parseExpr();
          this.eatPunct(')');
          return e;
        }
        break;
      default:
        break;
    }
    throw new SyntaxError(
      t.type === 'eof'
        ? 'unexpected end of input'
        : `unexpected token '${t.value}' (line ${t.line})`,
    );
  }
}

export function parse(src: string): Program {
  return new Parser(tokenize(src)).parseProgram();
}
