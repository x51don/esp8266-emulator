/**
 * Variables panel: the sketch's globals, live.
 *
 * Everything the panel decides - what shows, in what order, what is hidden,
 * how a value is printed - is a pure function below, so the suite can pin it
 * without a DOM. The component is those functions plus markup.
 *
 * Order and visibility are the user's, not the sketch's: they survive a
 * reload (App persists them) and follow the sketch as it changes - a global
 * the sketch gained joins at the end, one it lost disappears.
 */

import { useEffect, useRef, useState } from 'react';
import type { SketchVar } from '../../core/sketch/interp';

/** User's arrangement of the watch list. Names, never indexes. */
export interface VarPref {
  order: string[];
  hidden: string[];
}

export const emptyVarPref: VarPref = { order: [], hidden: [] };

type Named = { name: string };

/** Read a stored preference; anything unexpected falls back to the default. */
export function parseVarPref(raw: string | null | undefined): VarPref {
  if (!raw) return emptyVarPref;
  try {
    const v = JSON.parse(raw) as unknown;
    if (typeof v !== 'object' || v === null) return emptyVarPref;
    const { order, hidden } = v as Record<string, unknown>;
    const strs = (x: unknown): x is string[] =>
      Array.isArray(x) && x.every((n) => typeof n === 'string');
    if (!strs(order) || !strs(hidden)) return emptyVarPref;
    return { order, hidden };
  } catch {
    return emptyVarPref;
  }
}

/** Names in the order they would be listed, hidden ones left out. */
function visibleNames<T extends Named>(vars: readonly T[], pref: VarPref): string[] {
  const known = new Set(vars.map((v) => v.name));
  const shown = new Set(pref.hidden);
  const out: string[] = [];
  for (const n of pref.order) if (known.has(n) && !shown.has(n) && !out.includes(n)) out.push(n);
  for (const v of vars) if (!pref.order.includes(v.name) && !shown.has(v.name)) out.push(v.name);
  return out;
}

/** The globals to list, in the user's order; new ones join at the end. */
export function visibleVars<T extends Named>(vars: readonly T[], pref: VarPref): T[] {
  const byName = new Map(vars.map((v) => [v.name, v] as const));
  return visibleNames(vars, pref)
    .map((n) => byName.get(n))
    .filter((v): v is T => v !== undefined);
}

/** Hidden globals that still exist, in declaration order. */
export function hiddenVars<T extends Named>(vars: readonly T[], pref: VarPref): T[] {
  const hidden = new Set(pref.hidden);
  return vars.filter((v) => hidden.has(v.name));
}

/**
 * Move a global by `delta` places in the visible list. The first row cannot
 * go up and the last cannot go down; hidden names keep their saved slots.
 */
export function moveVar<T extends Named>(
  pref: VarPref,
  vars: readonly T[],
  name: string,
  delta: number,
): VarPref {
  const vis = visibleNames(vars, pref);
  const from = vis.indexOf(name);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= vis.length) return pref;
  const next = vis.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  const hidden = pref.order.filter((n) => pref.hidden.includes(n));
  return { order: [...next, ...hidden], hidden: pref.hidden };
}

/** Hide a global, or show it again at the end of the list. */
export function toggleVarHidden<T extends Named>(pref: VarPref, vars: readonly T[], name: string): VarPref {
  if (pref.hidden.includes(name)) {
    const rest = pref.hidden.filter((n) => n !== name);
    const shown = visibleNames(vars, pref).filter((n) => n !== name);
    return { order: [...shown, name], hidden: rest };
  }
  const order = pref.order.includes(name) ? pref.order : visibleNames(vars, pref);
  return { order, hidden: [...pref.hidden, name] };
}

/** How a value reads in the list. */
export function formatVar(v: SketchVar): string {
  if (v.kind === 'object') return v.object ?? 'object';
  if (v.kind === 'string') return v.value === null ? '-' : `"${v.value}"`;
  if (v.kind === 'array') {
    const items = (v.elements ?? []).map(String);
    const rest = (v.length ?? items.length) - items.length;
    if (!items.length) return `[]${rest > 0 ? ` +${rest}` : ''}`;
    return `[${items.join(', ')}${rest > 0 ? ` +${rest}` : ''}]`;
  }
  if (v.kind !== 'number' || v.value === null || v.value === undefined) return '-';
  const n = Number(v.value);
  if (!Number.isFinite(n)) return String(v.value);
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(6)));
}

/** The type as the sketch wrote it: `const` put back, array length shown. */
export function varTypeLabel(v: SketchVar): string {
  const base = v.kind === 'array' ? `${v.type}[${v.length ?? 0}]` : v.type;
  return v.isConst && !/^const\b/.test(base) ? `const ${base}` : base;
}

/** Names whose printed value moved since the snapshot - the row flash. */
export function diffVars(prev: Record<string, string>, vars: readonly SketchVar[]): string[] {
  const out: string[] = [];
  const now = new Set<string>();
  for (const v of vars) {
    const s = formatVar(v);
    now.add(v.name);
    if (prev[v.name] !== s) out.push(v.name);
  }
  for (const k of Object.keys(prev)) if (!now.has(k)) out.push(k);
  return out;
}

interface Props {
  vars: readonly SketchVar[];
  pref: VarPref;
  onPref: (next: VarPref) => void;
  running: boolean;
}

export function VariablesPanel({ vars, pref, onPref, running }: Props) {
  const [showHidden, setShowHidden] = useState(false);
  const dragRef = useRef<string | null>(null);
  const lastRef = useRef<Record<string, string>>({});

  const changed = diffVars(lastRef.current, vars);
  useEffect(() => {
    const snap: Record<string, string> = {};
    for (const v of vars) snap[v.name] = formatVar(v);
    lastRef.current = snap;
  }, [vars]);

  const shown = visibleVars(vars, pref);
  const off = hiddenVars(vars, pref);
  const isChanged = (name: string) => changed.includes(name);

  const row = (v: SketchVar, i: number, hidden: boolean) => (
    <div
      key={v.name}
      className={`vars-row${hidden ? ' vars-off' : ''}${isChanged(v.name) ? ' vars-changed' : ''}`}
      draggable={!hidden}
      onDragStart={() => (dragRef.current = v.name)}
      onDragOver={(e) => !hidden && e.preventDefault()}
      onDrop={() => {
        const from = dragRef.current;
        dragRef.current = null;
        if (!from || from === v.name) return;
        const vis = visibleNames(shown, pref);
        onPref(moveVar(pref, vars, from, vis.indexOf(v.name) - vis.indexOf(from)));
      }}
      title={`${varTypeLabel(v)} ${v.name}`}
    >
      <span className="vars-name">{v.name}</span>
      <span className="vars-type">{varTypeLabel(v)}</span>
      <span className={`vars-value${v.isConst ? ' vars-const' : ''}`}>{formatVar(v)}</span>
      <span className="vars-btns">
        {hidden ? (
          <button className="mini-btn" onClick={() => onPref(toggleVarHidden(pref, vars, v.name))}>
            show
          </button>
        ) : (
          <>
            <button
              className="mini-btn"
              disabled={i === 0}
              onClick={() => onPref(moveVar(pref, vars, v.name, -1))}
              title="move up"
            >
              &#9650;
            </button>
            <button
              className="mini-btn"
              disabled={i === shown.length - 1}
              onClick={() => onPref(moveVar(pref, vars, v.name, 1))}
              title="move down"
            >
              &#9660;
            </button>
            <button
              className="mini-btn"
              onClick={() => onPref(toggleVarHidden(pref, vars, v.name))}
              title="hide this variable"
            >
              hide
            </button>
          </>
        )}
      </span>
    </div>
  );

  return (
    <div className="vars-panel">
      <div className="panel-title">
        Variables
        <span className="vars-count">
          {shown.length}
          {off.length > 0 ? ` / ${vars.length}` : ''}
        </span>
        <span className="spacer" />
        {off.length > 0 && (
          <label className="mini-toggle">
            <input
              type="checkbox"
              checked={showHidden}
              onChange={(e) => setShowHidden(e.target.checked)}
            />
            hidden ({off.length})
          </label>
        )}
        {(pref.order.length > 0 || off.length > 0) && (
          <button className="mini-btn" onClick={() => onPref(emptyVarPref)} title="declaration order, nothing hidden">
            reset
          </button>
        )}
      </div>
      <div className="vars-body">
        {shown.map((v, i) => row(v, i, false))}
        {showHidden && off.map((v) => row(v, -1, true))}
        {shown.length === 0 && (
          <div className="vars-empty">
            {vars.length === 0
              ? running
                ? 'this sketch has no globals'
                : 'no values yet - press Run'
              : 'all variables hidden'}
          </div>
        )}
      </div>
    </div>
  );
}
