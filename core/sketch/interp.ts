/**
 * Cooperative tree-walking interpreter for the parsed Arduino-C++ subset.
 *
 * The interpreter is a JS generator: `delay()`/`delayMicroseconds()` yield a
 * Suspend request and the machine's scheduler resumes the sketch when virtual
 * time elapses. Loops additionally yield `{kind:'tick'}` so the host can
 * pause, stop or repaint without waiting for the sketch to sleep.
 *
 * Modelled C semantics: integer division truncates, C modulo signs, int32
 * bitwise ops, short-circuit logic, static locals, arrays passed by reference,
 * casts truncate, assignment keeps the destination's type. Numbers print via
 * JS String() (hardware uses 2-decimal floats - cosmetic difference).
 *
 * Storage model: every declared variable owns a mutable Val "cell"; all
 * assignments copy values INTO the destination cell, so plain variables never
 * alias each other. Arrays intentionally alias when passed to functions
 * (pointer semantics).
 */

import type { Declarator, Expr, FuncDef, Program, Stmt, VarDecl } from './parser';

export type HostValue = number | string | boolean | HostValue[];

export interface Suspend {
  kind: 'delay';
  us: number;
}

export interface Tick {
  kind: 'tick';
}

export type Pause = Suspend | Tick;

export interface HostResult {
  value?: HostValue;
  isFloat?: boolean;
  suspend?: Suspend;
}

export interface InterpreterEnv {
  /** Synchronous host call; may request a suspend instead of returning a value. */
  call(name: string, args: HostValue[]): HostResult;
  constants: Record<string, number>;
  millis(): number;
  micros(): number;
  /** WiFi object declaration (P3.3): name, class, constructor port. */
  objectDecl?(name: string, type: string, args: number[]): void;
}

export class SketchRuntimeError extends Error {
  constructor(message: string, public readonly line: number) {
    super(`${message} (line ${line})`);
    this.name = 'SketchRuntimeError';
  }
}

// ---------- runtime values ----------

type Val =
  | { k: 'n'; v: number; int: boolean; const?: boolean }
  | { k: 's'; v: string; const?: boolean }
  | { k: 'a'; v: Val[]; int: boolean; const?: boolean }
  | { k: 'void'; const?: boolean };

const VOID: Val = { k: 'void' };

function numVal(v: number, int = false): Val {
  return { k: 'n', v, int };
}

/** Copy a value so a new declaration never aliases its initializer's cell. */
function dup(v: Val): Val {
  switch (v.k) {
    case 'n': return numVal(v.v, v.int);
    case 's': return { k: 's', v: v.v };
    case 'a': return { k: 'a', v: v.v.map(dup), int: v.int };
    default: return VOID;
  }
}

function toHost(v: Val): HostValue {
  switch (v.k) {
    case 'n': return v.v;
    case 's': return v.v;
    case 'a': return v.v.map(toHost);
    default: return 0;
  }
}

function fromHost(v: HostValue | undefined, isFloat = false): Val {
  if (v === undefined) return numVal(0, true);
  if (typeof v === 'number') return numVal(v, !isFloat && Number.isInteger(v));
  if (typeof v === 'boolean') return numVal(v ? 1 : 0, true);
  if (typeof v === 'string') return { k: 's', v };
  return { k: 'a', v: v.map((x) => fromHost(x)), int: true };
}

function asNum(v: Val, line: number): number {
  if (v.k === 'n') return v.v;
  if (v.k === 's') {
    const n = Number(v.v);
    if (!Number.isNaN(n)) return n;
  }
  throw new SketchRuntimeError(`expected a number but got ${describeVal(v)}`, line);
}

function asInt(v: Val, line: number): number {
  return Math.trunc(asNum(v, line)) | 0;
}

function truthy(v: Val): boolean {
  if (v.k === 'n') return v.v !== 0;
  if (v.k === 's') return v.v.length > 0;
  return false;
}

function isIntVal(v: Val): boolean {
  return v.k === 'n' && v.int;
}

function describeVal(v: Val): string {
  switch (v.k) {
    case 'n': return String(v.v);
    case 's': return JSON.stringify(v.v);
    case 'a': return 'array';
    default: return 'void';
  }
}

function strOf(v: Val): string {
  switch (v.k) {
    case 'n': return String(v.v);
    case 's': return v.v;
    case 'a': return `[${v.v.map(strOf).join(',')}]`;
    default: return '';
  }
}

// ---------- control flow ----------

type Ctrl =
  | { type: 'normal' }
  | { type: 'break' }
  | { type: 'continue' }
  | { type: 'return'; value: Val };

const NORMAL: Ctrl = { type: 'normal' };

/** copy-out binding for a byRef parameter (caller-side lvalue store) */
/** Arduino String class methods on emulator 's' values. */
function strMethod(s: string, meth: string, args: Val[], line: number): Val {
  switch (meth) {
    case 'length': return numVal(s.length, true);
    case 'toInt': return numVal(parseInt(s, 10) | 0, true);
    case 'toFloat': return numVal(parseFloat(s) || 0, false);
    case 'charAt': return numVal(s.charCodeAt(asInt(args[0], line)) || 0, true);
    case 'equals': return numVal(s === strOf(args[0]) ? 1 : 0, true);
    case 'equalsIgnoreCase':
      return numVal(s.toLowerCase() === strOf(args[0]).toLowerCase() ? 1 : 0, true);
    case 'indexOf': return numVal(s.indexOf(strOf(args[0])), true);
    case 'substring':
      return { k: 's', v: s.substring(asInt(args[0], line), args[1] ? asInt(args[1], line) : undefined) };
    case 'toUpperCase': return { k: 's', v: s.toUpperCase() };
    case 'toLowerCase': return { k: 's', v: s.toLowerCase() };
    default:
      throw new SketchRuntimeError(`String has no method '${meth}'`, line);
  }
}

interface RefOut {
  param: string;
  store: (v: Val) => void;
}

interface Scope {
  vars: Map<string, Val>;
  parent?: Scope;
}

function lookupIn(scope: Scope | undefined, name: string): Val | undefined {
  for (let s = scope; s; s = s.parent) {
    const v = s.vars.get(name);
    if (v !== undefined) return v;
  }
  return undefined;
}

interface FuncInstance {
  def: FuncDef;
  statics: Map<string, Val>;
}

const MAX_CALL_DEPTH = 120;
/** Ceiling for a single non-suspending expression eval (see evalPure).
 *  Legitimate pure expressions are tiny; this only ever trips on a loop
 *  inside a declaration/array-index, which would otherwise freeze the tab. */
const MAX_PURE_STEPS = 200_000;
const INT_TYPE_WORDS = new Set([
  'bool', 'char', 'short', 'int', 'long', 'unsigned', 'byte', 'word',
  'uint8_t', 'uint16_t', 'uint32_t', 'int8_t', 'int16_t', 'int32_t', 'size_t',
]);
const FLOAT_TYPE_WORDS = new Set(['float', 'double']);
const STRING_TYPE_WORDS = new Set(['String']);

export function typeIsInt(typeName: string): boolean {
  const words = typeName.split(/\s+/);
  if (words.some((w) => FLOAT_TYPE_WORDS.has(w))) return false;
  return words.some((w) => INT_TYPE_WORDS.has(w));
}

function typeIsString(typeName: string): boolean {
  const words = typeName.split(/\s+/);
  return words.some((w) => STRING_TYPE_WORDS.has(w)) || typeName.includes('char');
}

export type SketchGen = Generator<Pause, void, HostValue | undefined>;

export class Interpreter {
  private funcs = new Map<string, FuncInstance>();
  private globals: Scope = { vars: new Map() };
  private depth = 0;
  private initialized = false;

  constructor(
    program: Program,
    private readonly env: InterpreterEnv,
  ) {
    for (const g of program.globals) {
      if (g.kind === 'FuncDef') this.funcs.set(g.name, { def: g, statics: new Map() });
    }
    this.program = program;
  }

  private readonly program: Program;

  /** Evaluate constant global initializers. Call once before setup(). */
  initGlobals(): void {
    if (this.initialized) return;
    this.initialized = true;
    for (const g of this.program.globals) {
      if (g.kind !== 'VarDecl') continue;
      for (const d of g.decls) {
        const v = this.globalInit(d, g);
        if (g.isConst) v.const = true;
        this.globals.vars.set(d.name, v);
      }
    }
  }

  /** WiFi mock instances are opaque tokens; the machine tracks their state. */
  /**
   * Library objects exist as string tokens (`@WiFiClient:0`); the machine
   * registers the real per-name state through env.objectDecl. Constructor
   * syntax (`Server server(80);`) and `= Server(80)` both arrive as a Call
   * whose callee is the type name.
   */
  private wifiToken(d: Declarator, g: VarDecl): Val | null {
    if (!Interpreter.OBJECT_TYPES.has(g.type)) return null;
    const args: number[] = [];
    if (d.init && d.init.kind === 'Call' && d.init.callee === g.type) {
      for (const a of d.init.args) {
        try {
          args.push(asInt(this.evalConst(a, g.line), g.line));
        } catch {
          args.push(0); // non-constant ctor argument: token keeps 0
        }
      }
    }
    this.env.objectDecl?.(d.name, g.type, args);
    return { k: 's', v: `@${g.type}:${args.join(',')}` };
  }
  private static readonly OBJECT_TYPES = new Set([
    'WiFiClient', 'WiFiServer', 'WiFiUDP',
    'ESP8266WebServer', 'HTTPClient', 'IPAddress', 'Adafruit_NeoPixel',
  ]);

  private globalInit(d: Declarator, g: VarDecl): Val {
    const tok = this.wifiToken(d, g);
    if (tok) return tok;
    const isIntType = typeIsInt(g.type);
    if (d.init === null) {
      if (d.arraySize !== null) return this.makeArray(d.arraySize, isIntType);
      if (typeIsString(g.type)) return { k: 's', v: '' };
      return isIntType ? numVal(0, true) : numVal(0, false);
    }
    return this.evalConst(d.init, g.line);
  }

  /** Run setup() exactly once. */
  setup(): SketchGen {
    this.initGlobals();
    const fn = this.requireFunc('setup');
    return this.callUser(fn, [], fn.def.line);
  }

  /** Run loop() body exactly once. */
  loopOnce(): SketchGen {
    this.initGlobals();
    const fn = this.requireFunc('loop');
    return this.callUser(fn, [], fn.def.line);
  }

  /** Call a user function by name (timer ISRs). */
  callFn(name: string, args: number[] = []): SketchGen {
    this.initGlobals();
    const fn = this.requireFunc(name);
    return this.callUser(fn, args.map((a) => numVal(a, true)), fn.def.line);
  }

  hasFunction(name: string): boolean {
    return this.funcs.has(name);
  }

  private requireFunc(name: string): FuncInstance {
    const fn = this.funcs.get(name);
    if (!fn) throw new SketchRuntimeError(`sketch must define void ${name}()`, 0);
    return fn;
  }

  private makeArray(size: number, isInt: boolean): Val {
    return { k: 'a', v: Array.from({ length: size }, () => numVal(0, isInt)), int: isInt };
  }

  /** Global initializers must be constant expressions (like C++). */
  private evalConst(e: Expr, line: number): Val {
    switch (e.kind) {
      case 'Num': return numVal(e.v, !e.isFloat);
      case 'Str': return { k: 's', v: e.s };
      case 'Char': return numVal(e.c.codePointAt(0) ?? 0, true);
      case 'Unary': {
        const operand = this.evalConst(e.operand, e.line);
        const n = asNum(operand, e.line);
        if (e.op === '-') return numVal(-n, isIntVal(operand));
        if (e.op === '!') return numVal(n === 0 ? 1 : 0, true);
        if (e.op === '~') return numVal(~asInt(operand, e.line), true);
        return operand;
      }
      case 'Binary':
      case 'Logical': {
        const l = this.evalConst(e.left, e.line);
        const r = this.evalConst(e.right, e.line);
        return numVal(
          this.applyBinary(e.op, asNum(l, e.line), asNum(r, e.line), isIntVal(l) && isIntVal(r), e.line),
          this.resultIsInt(e.op, l, r),
        );
      }
      case 'Cond': {
        const t = this.evalConst(e.test, e.line);
        return this.evalConst(truthy(t) ? e.cons : e.alt, e.line);
      }
      case 'ArrayLit':
        return { k: 'a', v: e.elems.map((x) => this.evalConst(x, e.line)), int: true };
      case 'Ident': {
        if (e.name === 'true') return numVal(1, true);
        if (e.name === 'false') return numVal(0, true);
        const c = this.env.constants[e.name];
        if (c !== undefined) return numVal(c, true);
        // an earlier global initializer is a constant for this one (`int b = a;`)
        const seen = this.globals?.vars.get(e.name);
        if (seen) return dup(seen);
        throw new SketchRuntimeError(
          'global initializers must be constant expressions', line,
        );
      }
      default:
        throw new SketchRuntimeError(
          'global initializers must be constant expressions', line,
        );
    }
  }

  // ---------- function calls ----------

  private *callUser(
    fn: FuncInstance,
    args: Val[],
    line: number,
  ): SketchGen {
    if (++this.depth > MAX_CALL_DEPTH) {
      this.depth--;
      throw new SketchRuntimeError(`maximum recursion depth (${MAX_CALL_DEPTH}) exceeded`, line);
    }
    try {
      const scope: Scope = { vars: new Map(), parent: this.globals };
      fn.def.params.forEach((p, idx) => {
        const arg = args[idx] ?? numVal(0, true);
        scope.vars.set(p.name, arg);
      });
      this.bindStatics(fn, scope);
      const ctrl = yield* this.execList(fn.def.body.body, scope);
      void ctrl;
    } finally {
      this.depth--;
    }
  }

  /** Static locals are seeded once per function and rebound into each frame. */
  private bindStatics(fn: FuncInstance, scope: Scope): void {
    const walk = (stmts: Stmt[]): void => {
      for (const s of stmts) {
        if (s.kind === 'VarDeclStmt' && s.isStatic) {
          for (const d of s.decls) {
            if (!fn.statics.has(d.name)) {
              fn.statics.set(d.name, this.localInit(d, s, scope));
            }
            scope.vars.set(d.name, fn.statics.get(d.name)!);
          }
        }
        if (s.kind === 'Block') walk(s.body);
        if (s.kind === 'If') { walk([s.consequent]); if (s.alt) walk([s.alt]); }
        if (s.kind === 'For' || s.kind === 'While' || s.kind === 'DoWhile') walk([s.body]);
        if (s.kind === 'Switch') for (const c of s.cases) walk(c.body);
      }
    };
    walk(fn.def.body.body);
  }

  // ---------- statements ----------

  private execList(body: Stmt[], scope: Scope): Generator<Pause, Ctrl, HostValue | undefined> {
    return this.execListG(body, scope);
  }

  private *execListG(
    body: Stmt[],
    scope: Scope,
  ): Generator<Pause, Ctrl, HostValue | undefined> {
    for (const s of body) {
      const ctrl = yield* this.exec(s, scope);
      if (ctrl.type !== 'normal') return ctrl;
    }
    return NORMAL;
  }

  private *exec(
    stmt: Stmt,
    scope: Scope,
  ): Generator<Pause, Ctrl, HostValue | undefined> {
    switch (stmt.kind) {
      case 'Block':
        return yield* this.execList(stmt.body, { vars: new Map(), parent: scope });

      case 'ExprStmt': {
        yield* this.eval(stmt.expr, scope);
        return NORMAL;
      }

      case 'VarDeclStmt': {
        for (const d of stmt.decls) {
          // bindStatics may have pre-bound this name already.
          if (scope.vars.has(d.name)) continue;
          let v: Val;
          if (!stmt.isStatic && !stmt.isConst && d.init && d.arraySize === null && d.init.kind !== 'ArrayLit') {
            // a plain initializer may suspend (int r = WiFi.waitForConnectResult();)
            v = dup(yield* this.eval(d.init, scope));
            if (typeIsString(stmt.type) && v.k === 'n') v = { k: 's', v: strOf(v) };
          } else {
            v = this.localInit(d, stmt, scope);
          }
          if (stmt.isConst) v.const = true;
          scope.vars.set(d.name, v);
        }
        return NORMAL;
      }

      case 'If': {
        const t = yield* this.eval(stmt.test, scope);
        return truthy(t)
          ? yield* this.exec(stmt.consequent, scope)
          : stmt.alt ? yield* this.exec(stmt.alt, scope) : NORMAL;
      }

      case 'For': {
        const loopScope: Scope = { vars: new Map(), parent: scope };
        if (stmt.init) {
          const c = yield* this.exec(stmt.init, loopScope);
          if (c.type !== 'normal') return c;
        }
        for (;;) {
          if (stmt.cond) {
            const t = yield* this.eval(stmt.cond, loopScope);
            if (!truthy(t)) break;
          }
          yield { kind: 'tick' };
          const c = yield* this.exec(stmt.body, loopScope);
          if (c.type === 'return') return c;
          if (c.type === 'break') break;
          if (stmt.update) yield* this.eval(stmt.update, loopScope);
        }
        return NORMAL;
      }

      case 'While': {
        for (;;) {
          const t = yield* this.eval(stmt.test, scope);
          if (!truthy(t)) break;
          yield { kind: 'tick' };
          const c = yield* this.exec(stmt.body, scope);
          if (c.type === 'return') return c;
          if (c.type === 'break') break;
        }
        return NORMAL;
      }

      case 'DoWhile': {
        for (;;) {
          yield { kind: 'tick' };
          const c = yield* this.exec(stmt.body, scope);
          if (c.type === 'return') return c;
          if (c.type === 'break') break;
          const t = yield* this.eval(stmt.test, scope);
          if (!truthy(t)) break;
        }
        return NORMAL;
      }

      case 'Return': {
        const v = stmt.arg ? yield* this.eval(stmt.arg, scope) : VOID;
        return { type: 'return', value: v };
      }

      case 'Break': return { type: 'break' };

      case 'Switch': {
        const d = yield* this.eval(stmt.disc, scope);
        const same = (a: Val, b: Val) =>
          a.k !== 'void' && a.k === b.k && a.k === 'n'
            ? a.v === b.v
            : a.k === 's' && b.k === 's' && a.v === b.v;
        let start = -1;
        let def = -1;
        for (let i = 0; i < stmt.cases.length; i++) {
          const c = stmt.cases[i];
          if (c.test === null) {
            if (def < 0) def = i;
            continue;
          }
          const t = yield* this.eval(c.test, scope);
          if (start < 0 && same(d, t)) start = i;
        }
        if (start < 0) start = def;
        if (start < 0) return NORMAL;
        for (let i = start; i < stmt.cases.length; i++) {
          for (const s of stmt.cases[i].body) {
            const c = yield* this.exec(s, scope);
            if (c.type === 'break') return NORMAL; // break belongs to the switch
            if (c.type !== 'normal') return c; // return/continue escape too
          }
        }
        return NORMAL;
      }
      case 'Continue': return { type: 'continue' };

      default:
        throw new SketchRuntimeError(`unsupported statement '${(stmt as Stmt).kind}'`, 0);
    }
  }

  /**
   * Local declaration init. Arrays copy their initializer (values); scalars
   * duplicate cells so variables never share storage. delay() is rejected.
   */
  private localInit(d: Declarator, g: VarDecl, scope: Scope): Val {
    const tok = this.wifiToken(d, g);
    if (tok) return tok;
    const isIntType = typeIsInt(g.type);
    if (d.arraySize !== null || (d.init && d.init.kind === 'ArrayLit')) {
      if (d.init && d.init.kind === 'ArrayLit') {
        const elems = d.init.elems.map((e) => this.evalPure(e, scope));
        if (d.arraySize !== null && elems.length !== d.arraySize) {
          throw new SketchRuntimeError(
            `array size ${d.arraySize} but ${elems.length} initializers`, g.line,
          );
        }
        return { k: 'a', v: elems, int: isIntType };
      }
      return this.makeArray(d.arraySize ?? 0, isIntType);
    }
    if (!d.init) {
      if (typeIsString(g.type)) return { k: 's', v: '' };
      return isIntType ? numVal(0, true) : numVal(0, false);
    }
    return dup(this.evalPure(d.init, scope));
  }

  /** Evaluate an expression that must not suspend (declaration initializers
   *  and array targets). These generators are spun synchronously, so the
   *  machine's per-frame budget cannot interrupt them; the step cap is what
   *  turns `while(true){}` inside `arr[f()] = 1` into a line-numbered error
   *  instead of a browser freeze. */
  private evalPure(e: Expr, scope: Scope): Val {
    const g = this.eval(e, scope);
    let steps = 0;
    let r = g.next();
    while (!r.done) {
      if (r.value.kind === 'delay') {
        throw new SketchRuntimeError(
          'delay()/host calls are not allowed inside a declaration', e.line,
        );
      }
      if (++steps >= MAX_PURE_STEPS) {
        g.return(numVal(0, true)); // close the generator before the error escapes
        throw new SketchRuntimeError(
          'this expression loops without delay() - exceeded the step budget', e.line,
        );
      }
      r = g.next(undefined); // tick: keep going
    }
    return r.value;
  }

  // ---------- expressions ----------

  private *eval(
    e: Expr,
    scope: Scope,
  ): Generator<Pause, Val, HostValue | undefined> {
    switch (e.kind) {
      case 'Num': return numVal(e.v, !e.isFloat);
      case 'Str': return { k: 's', v: e.s };
      case 'Char': return numVal(e.c.codePointAt(0) ?? 0, true);

      case 'Ident': {
        const v = lookupIn(scope, e.name);
        if (v) return v;
        const c = this.env.constants[e.name];
        if (c !== undefined) return numVal(c, true);
        if (e.name === 'true') return numVal(1, true);
        if (e.name === 'false') return numVal(0, true);
        // C++ function-to-pointer decay: a bare function name used as a
        // value (attachInterrupt pin argument) passes its name through.
        if (this.funcs.has(e.name)) return { k: 's', v: e.name };
        throw new SketchRuntimeError(`'${e.name}' was not declared in this scope`, e.line);
      }

      case 'Cast': {
        const v = yield* this.eval(e.expr, scope);
        return this.castTo(e.castType, v, e.line);
      }

      case 'Unary': {
        const v = yield* this.eval(e.operand, scope);
        const n = asNum(v, e.line);
        switch (e.op) {
          case '-': return numVal(-n, isIntVal(v));
          case '+': return v;
          case '!': return numVal(truthy(v) ? 0 : 1, true);
          case '~': return numVal(~asInt(v, e.line), true);
          default: throw new SketchRuntimeError(`unsupported unary '${e.op}'`, e.line);
        }
      }

      case 'Binary': {
        const l = yield* this.eval(e.left, scope);
        const r = yield* this.eval(e.right, scope);
        if (e.op === '+' && (l.k === 's' || r.k === 's')) {
          return { k: 's', v: strOf(l) + strOf(r) };
        }
        // Arduino compares Strings as text, numbers stringify into it
        // (`argName(i) == name`, `server.method() == HTTP_GET` -> false)
        if (
          (e.op === '==' || e.op === '!=') &&
          ((l.k === 's' && !l.v.startsWith('@')) || (r.k === 's' && !r.v.startsWith('@')))
        ) {
          const eq = strOf(l) === strOf(r);
          return numVal((e.op === '==' ? eq : !eq) ? 1 : 0, true);
        }
        return numVal(
          this.applyBinary(e.op, asNum(l, e.line), asNum(r, e.line), isIntVal(l) && isIntVal(r), e.line),
          this.resultIsInt(e.op, l, r),
        );
      }

      case 'Logical': {
        const l = yield* this.eval(e.left, scope);
        if (e.op === '&&') {
          if (!truthy(l)) return numVal(0, true);
          const r = yield* this.eval(e.right, scope);
          return numVal(truthy(r) ? 1 : 0, true);
        }
        if (truthy(l)) return numVal(1, true);
        const r = yield* this.eval(e.right, scope);
        return numVal(truthy(r) ? 1 : 0, true);
      }

      case 'Cond': {
        const t = yield* this.eval(e.test, scope);
        return truthy(t) ? yield* this.eval(e.cons, scope) : yield* this.eval(e.alt, scope);
      }

      case 'Update': {
        const cur = yield* this.eval(e.operand, scope);
        const oldN = asNum(cur, e.line);
        const wasInt = isIntVal(cur);
        const nextN = e.op === '++' ? oldN + 1 : oldN - 1;
        this.storeInto(e.operand, numVal(nextN, wasInt), scope, e.line);
        // Postfix yields a COPY of the old value (the cell has already moved on).
        return e.postfix ? numVal(oldN, wasInt) : numVal(nextN, wasInt);
      }

      case 'Assign': {
        if (e.op === '=') {
          const v = yield* this.eval(e.value, scope);
          this.storeInto(e.target, v, scope, e.line);
          return v;
        }
        const cur = yield* this.eval(e.target, scope);
        const rhs = yield* this.eval(e.value, scope);
        if (rhs.k === 's' && e.op === '+=') {
          const merged = { k: 's' as const, v: strOf(cur) + rhs.v };
          this.storeInto(e.target, merged, scope, e.line);
          return merged;
        }
        // `message += curent_pos` - appending a number to a String
        if (e.op === '+=' && cur.k === 's' && !cur.v.startsWith('@')) {
          const merged = { k: 's' as const, v: cur.v + strOf(rhs) };
          this.storeInto(e.target, merged, scope, e.line);
          return merged;
        }
        const res = numVal(
          this.applyBinary(
            e.op.slice(0, -1), asNum(cur, e.line), asNum(rhs, e.line),
            isIntVal(cur) && isIntVal(rhs), e.line,
          ),
          this.resultIsInt(e.op.slice(0, -1), cur, rhs),
        );
        this.storeInto(e.target, res, scope, e.line);
        return res;
      }

      case 'Comma': {
        let last: Val = VOID;
        for (const x of e.exprs) last = yield* this.eval(x, scope);
        return last;
      }

      case 'ArrayLit':
        throw new SketchRuntimeError('array literal only allowed in declarations', e.line);

      case 'Call': {
        if (e.callee === 'millis') return numVal(this.env.millis(), true);
        if (e.callee === 'micros') return numVal(this.env.micros(), true);
        const args: Val[] = [];
        for (const a of e.args) args.push(yield* this.eval(a, scope));
        // dynamic dispatch: a variable holding a function name (lambdas and
        // function pointers decay to their name) calls through the variable
        let callee = e.callee;
        if (!this.funcs.has(callee)) {
          const held = lookupIn(scope, callee);
          if (held && held.k === 's' && this.funcs.has(held.v)) callee = held.v;
        }
        const fn = this.funcs.get(callee);
        if (fn) {
          // byRef parameters copy out into the caller's lvalue on return
          const refs: RefOut[] = [];
          fn.def.params.forEach((prm, i) => {
            if (!prm.byRef) return;
            const target = e.args[i];
            if (!target) return;
            refs.push({ param: prm.name, store: (v) => this.storeInto(target, v, scope, e.line) });
          });
          // callUser yields void; user calls are statements w.r.t. values:
          // emulate a return value by running it and capturing via closure.
          return yield* this.callUserExpr(fn, args, e.line, refs);
        }
        // chained members: `server.arg("v").toInt()` - the receiver already
        // evaluated to a value; only Strings carry methods this way
        if (e.recv) {
          const rv = yield* this.eval(e.recv, scope);
          if (rv.k !== 's' || rv.v.startsWith('@'))
            throw new SketchRuntimeError(
              `cannot call '${e.callee}' on this value`, e.line,
            );
          return strMethod(rv.v, e.callee, args, e.line);
        }
        // methods on String values (`v.length()`, `v.toInt()`, ...): the
        // receiver is a sketch variable holding an 's' Val, not a host object
        if (!this.funcs.has(callee) && callee.includes('.')) {
          const dot = callee.indexOf('.');
          const recv = lookupIn(scope, callee.slice(0, dot));
          if (recv && recv.k === 's' && !recv.v.startsWith('@')) {
            return strMethod(recv.v, callee.slice(dot + 1), args, e.line);
          }
        }
        const res = this.env.call(callee, args.map(toHost));
        if (res.suspend) {
          yield res.suspend;
        }
        return fromHost(res.value, res.isFloat);
      }

      case 'Index': {
        const arr = yield* this.eval(e.obj, scope);
        // String indexing: `v[0] == '-'` yields the character code, like Char
        if (arr.k === 's' && !arr.v.startsWith('@')) {
          const i = asInt(yield* this.eval(e.index, scope), e.line);
          return numVal(i >= 0 && i < arr.v.length ? arr.v.charCodeAt(i) : 0, true);
        }
        this.checkArray(arr, e.line);
        const idx = asInt(yield* this.eval(e.index, scope), e.line);
        if (idx < 0 || idx >= (arr as Extract<Val, { k: 'a' }>).v.length) {
          throw new SketchRuntimeError(
            `index ${idx} out of bounds (size ${(arr as Extract<Val, { k: 'a' }>).v.length})`, e.line,
          );
        }
        return (arr as Extract<Val, { k: 'a' }>).v[idx];
      }

      default: {
        const bad = e as unknown as { kind?: string; line?: number };
        throw new SketchRuntimeError(`unsupported expression '${bad.kind}'`, bad.line ?? 0);
      }
    }
  }

  private *callUserExpr(
    fn: FuncInstance,
    args: Val[],
    line: number,
    refs?: RefOut[],
  ): Generator<Pause, Val, HostValue | undefined> {
    if (++this.depth > MAX_CALL_DEPTH) {
      this.depth--;
      throw new SketchRuntimeError(`maximum recursion depth (${MAX_CALL_DEPTH}) exceeded`, line);
    }
    try {
      const scope: Scope = { vars: new Map(), parent: this.globals };
      fn.def.params.forEach((p, idx) => scope.vars.set(p.name, args[idx] ?? numVal(0, true)));
      this.bindStatics(fn, scope);
      const ctrl = yield* this.execList(fn.def.body.body, scope);
      if (refs) {
        for (const r of refs) {
          const v = scope.vars.get(r.param);
          if (v) r.store(v);
        }
      }
      return ctrl.type === 'return' ? ctrl.value : VOID;
    } finally {
      this.depth--;
    }
  }

  private checkArray(v: Val, line: number): void {
    if (v.k !== 'a') throw new SketchRuntimeError('indexed value is not an array', line);
  }

  private resultIsInt(op: string, l: Val, r: Val): boolean {
    if (['==', '!=', '<', '<=', '>', '>=', '&&', '||'].includes(op)) return true;
    if (['<<', '>>', '&', '|', '^', '%'].includes(op)) return true;
    return isIntVal(l) && isIntVal(r);
  }

  private applyBinary(op: string, l: number, r: number, bothInt: boolean, line: number): number {
    switch (op) {
      case '+': return l + r;
      case '-': return l - r;
      case '*': return l * r;
      case '/':
        if (r === 0) throw new SketchRuntimeError('division by zero', line);
        return bothInt ? Math.trunc(l / r) : l / r;
      case '%':
        if (r === 0) throw new SketchRuntimeError('modulo by zero', line);
        if (!bothInt) throw new SketchRuntimeError('modulo requires integer operands', line);
        return l % r;
      case '&': return (l | 0) & (r | 0);
      case '|': return (l | 0) | (r | 0);
      case '^': return (l | 0) ^ (r | 0);
      case '<<': return (l | 0) << (r | 0);
      case '>>': return (l | 0) >> (r | 0);
      case '<': return l < r ? 1 : 0;
      case '>': return l > r ? 1 : 0;
      case '<=': return l <= r ? 1 : 0;
      case '>=': return l >= r ? 1 : 0;
      case '==': return l === r ? 1 : 0;
      case '!=': return l !== r ? 1 : 0;
      default: throw new SketchRuntimeError(`unsupported operator '${op}'`, line);
    }
  }

  private castTo(typeName: string, v: Val, line: number): Val {
    if (typeName === 'String') return { k: 's', v: strOf(v) };
    const n = asNum(v, line);
    const last = typeName.split(' ').pop() ?? '';
    if (FLOAT_TYPE_WORDS.has(last)) return numVal(n, false);
    if (typeName.startsWith('unsigned')) return numVal(n >>> 0, true);
    if (last === 'bool') return numVal(truthy(v) ? 1 : 0, true);
    return numVal(Math.trunc(n) | 0, true);
  }

  // ---------- assignment ----------

  private storeInto(target: Expr, v: Val, scope: Scope, line: number): void {
    if (target.kind === 'Ident') {
      const cell = lookupIn(scope, target.name);
      if (!cell) {
        throw new SketchRuntimeError(`'${target.name}' was not declared in this scope`, line);
      }
      if (cell.const) {
        throw new SketchRuntimeError(`'${target.name}' is const and cannot be assigned`, line);
      }
      this.assignInto(cell, v, line);
      return;
    }
    if (target.kind === 'Index') {
      const arr = this.evalPure(target.obj, scope);
      this.checkArray(arr, line);
      const a = arr as Extract<Val, { k: 'a' }>;
      const idx = asInt(this.evalPure(target.index, scope), line);
      if (idx < 0 || idx >= a.v.length) {
        throw new SketchRuntimeError(`index ${idx} out of bounds (size ${a.v.length})`, line);
      }
      if (a.v[idx].k !== 'a') {
        this.assignInto(a.v[idx], dup(v), line);
      } else {
        a.v[idx] = v;
      }
      return;
    }
    throw new SketchRuntimeError('cannot assign to this expression', line);
  }

  /** Assignment keeps the destination's type: int cells truncate floats. */
  private assignInto(dest: Val, src: Val, line: number): void {
    if (dest.k === 'n' && src.k === 'n') {
      dest.v = dest.int ? Math.trunc(src.v) | 0 : src.v;
      return;
    }
    if (dest.k === 's' && src.k !== 'a') {
      dest.v = strOf(src);
      return;
    }
    if (dest.k === 'n' && src.k === 's') {
      // function handles (lambdas, function names) live in int-typed cells;
      // the cell changes kind in place so holders of the reference see it
      const cell = dest as unknown as { k: string; v: string };
      cell.k = 's';
      cell.v = src.v;
      return;
    }
    if (dest.k === 'a' && src.k === 'a') {
      dest.v.length = 0;
      dest.v.push(...src.v.map(dup));
      return;
    }
    void line;
    throw new SketchRuntimeError(`cannot assign ${describeVal(src)} here`, line);
  }
}

