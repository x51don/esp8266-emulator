/**
 * The Variables panel's logic: which globals show, in what order, and how a
 * value is rendered. Kept as pure functions because the suite has no DOM -
 * the component is these helpers plus markup.
 */
import { describe, it, expect } from 'vitest';
import {
  emptyVarPref,
  parseVarPref,
  visibleVars,
  hiddenVars,
  moveVar,
  toggleVarHidden,
  formatVar,
  varTypeLabel,
  diffVars,
  type VarPref,
} from '../gui/components/VariablesPanel';
import type { SketchVar } from '../core/sketch/interp';

const v = (name: string, value: number | string | null = 0, over: Partial<SketchVar> = {}): SketchVar => ({
  name,
  type: 'int',
  kind: 'number',
  value,
  isConst: false,
  ...over,
});

const NAMES = [v('counter'), v('last'), v('LIMIT'), v('label')];
const names = (vars: SketchVar[], pref: VarPref) => visibleVars(vars, pref).map((x) => x.name);

describe('variables panel preferences', () => {
  it('shows every global by default, in declaration order', () => {
    expect(names(NAMES, emptyVarPref)).toEqual(['counter', 'last', 'LIMIT', 'label']);
    expect(hiddenVars(NAMES, emptyVarPref)).toEqual([]);
  });

  it('hiding takes a variable out of the list and names it as hidden', () => {
    const pref = toggleVarHidden(emptyVarPref, NAMES, 'last');
    expect(names(NAMES, pref)).toEqual(['counter', 'LIMIT', 'label']);
    expect(hiddenVars(NAMES, pref).map((x) => x.name)).toEqual(['last']);
  });

  it('unhiding brings it back, at the end of the visible list', () => {
    const pref = toggleVarHidden(toggleVarHidden(emptyVarPref, NAMES, 'last'), NAMES, 'last');
    expect(names(NAMES, pref)).toEqual(['counter', 'LIMIT', 'label', 'last']);
    expect(hiddenVars(NAMES, pref)).toEqual([]);
  });

  it('reordering moves a variable and survives a re-render', () => {
    let pref = moveVar(emptyVarPref, NAMES, 'label', -1);
    expect(names(NAMES, pref)).toEqual(['counter', 'last', 'label', 'LIMIT']);
    pref = moveVar(pref, NAMES, 'label', -1);
    expect(names(NAMES, pref)).toEqual(['counter', 'label', 'last', 'LIMIT']);
    pref = moveVar(pref, NAMES, 'label', 1);
    expect(names(NAMES, pref)).toEqual(['counter', 'last', 'label', 'LIMIT']);
  });

  it('the first row cannot move up and the last cannot move down', () => {
    expect(names(NAMES, moveVar(emptyVarPref, NAMES, 'counter', -1))).toEqual([
      'counter',
      'last',
      'LIMIT',
      'label',
    ]);
    expect(names(NAMES, moveVar(emptyVarPref, NAMES, 'label', 1))).toEqual([
      'counter',
      'last',
      'LIMIT',
      'label',
    ]);
  });

  it('a variable the sketch gained after the order was saved joins at the end', () => {
    const pref = moveVar(emptyVarPref, NAMES, 'label', -1);
    const withNew = [...NAMES, v('extra')];
    expect(names(withNew, pref)).toEqual(['counter', 'last', 'label', 'LIMIT', 'extra']);
  });

  it('a name the sketch no longer has is dropped, not shown as a hole', () => {
    const pref: VarPref = { order: ['last', 'gone', 'counter', 'LIMIT', 'label'], hidden: [] };
    expect(names(NAMES, pref)).toEqual(['last', 'counter', 'LIMIT', 'label']);
  });

  it('a saved order that does not mention every global leaves the rest at the end', () => {
    const pref: VarPref = { order: ['last', 'counter'], hidden: [] };
    expect(names(NAMES, pref)).toEqual(['last', 'counter', 'LIMIT', 'label']);
  });

  it('a hidden variable the sketch dropped stops being offered', () => {
    const pref = toggleVarHidden(emptyVarPref, NAMES, 'last');
    expect(hiddenVars([v('counter')], pref)).toEqual([]);
  });

  it('stored preferences that are not what we expect fall back to the default', () => {
    expect(parseVarPref(null)).toEqual(emptyVarPref);
    expect(parseVarPref('not json')).toEqual(emptyVarPref);
    expect(parseVarPref('{"order":"counter"}')).toEqual(emptyVarPref);
    expect(parseVarPref('{"order":[1,2],"hidden":null}')).toEqual(emptyVarPref);
    expect(parseVarPref('{"order":["a"],"hidden":[]}')).toEqual({ order: ['a'], hidden: [] });
  });

  it('a preference round-trips through storage', () => {
    const pref = toggleVarHidden(moveVar(emptyVarPref, NAMES, 'label', -1), NAMES, 'LIMIT');
    expect(parseVarPref(JSON.stringify(pref))).toEqual(pref);
  });
});

describe('variable rendering', () => {
  it('the type column says what the sketch wrote', () => {
    expect(varTypeLabel(v('steps', null, { kind: 'array', length: 4 }))).toBe('int[4]');
    expect(varTypeLabel(v('m', null, { kind: 'array', type: 'int', length: 2, dims: [2, 3] })))
      .toBe('int[2][3]');
    expect(varTypeLabel({ ...v('LIMIT', 10), isConst: true })).toBe('const int');
    expect(varTypeLabel({ ...v('LIMIT', 10), type: 'const int', isConst: true })).toBe('const int');
    expect(varTypeLabel(v('label', 'x', { kind: 'string', type: 'String' }))).toBe('String');
  });

  it('integers print plain, floats keep their fraction', () => {
    expect(formatVar(v('a', 42))).toBe('42');
    expect(formatVar(v('a', -7))).toBe('-7');
    expect(formatVar(v('a', 3.5, { kind: 'number' }))).toBe('3.5');
    expect(formatVar(v('a', 2.0 / 3.0))).toBe('0.666667');
  });

  it('strings are quoted, arrays are listed', () => {
    expect(formatVar(v('s', 'roleta', { kind: 'string' }))).toBe('"roleta"');
    expect(formatVar(v('a', null, { kind: 'array', length: 3, elements: [1, 2, 3] }))).toBe('[1, 2, 3]');
  });

  it('a long array says how much is not shown', () => {
    const long = v('buf', null, { kind: 'array', length: 40, elements: [0, 0, 0] });
    expect(formatVar(long)).toBe('[0, 0, 0 +37]');
  });

  it('objects print their class, an empty value prints a dash', () => {
    expect(formatVar(v('http', null, { kind: 'object', object: 'HTTPClient' }))).toBe('HTTPClient');
    expect(formatVar(v('x', null, { kind: 'void' }))).toBe('-');
  });
});

describe('change highlight', () => {
  it('names the variables whose value moved since the last look', () => {
    const before = diffVars({}, [v('a', 1), v('b', 2)]);
    expect(before.sort()).toEqual(['a', 'b']);
    const snapshot: Record<string, string> = { a: '1', b: '2' };
    expect(diffVars(snapshot, [v('a', 1), v('b', 3)])).toEqual(['b']);
    expect(diffVars(snapshot, [v('a', 1), v('b', 2)])).toEqual([]);
  });

  it('a variable that appeared or vanished counts as changed', () => {
    const snapshot: Record<string, string> = { a: '1' };
    expect(diffVars(snapshot, [v('a', 1), v('b', 1)])).toEqual(['b']);
    expect(diffVars({ a: '1', b: '2' }, [v('a', 1)])).toEqual(['b']);
  });
});
