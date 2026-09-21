/**
 * Properties dialog for a placed component. Every type exposes the
 * parameters that actually change simulation behaviour; applying writes
 * them straight onto the schematic and (when running) into the netlist.
 */

import { useState } from 'react';
import { listBoards } from '../../core/boards';
import type { PlacedComponent } from '../canvas/schematic';

type Field =
  | { key: string; label: string; unit?: string; kind: 'num'; step?: number; hex?: boolean }
  | { key: string; label: string; kind: 'select'; options: Array<{ value: string; label: string }> };

const FIELDS: Record<string, Field[]> = {
  resistor: [{ key: 'resistance', label: 'Resistance', unit: 'ohm', kind: 'num', step: 10 }],
  led: [
    {
      key: 'color', label: 'Colour', kind: 'select',
      options: [
        { value: 'red', label: 'Red (1.8 V)' }, { value: 'orange', label: 'Orange (1.9 V)' },
        { value: 'yellow', label: 'Yellow (2.0 V)' }, { value: 'green', label: 'Green (2.1 V)' },
        { value: 'blue', label: 'Blue (3.0 V)' }, { value: 'white', label: 'White (3.1 V)' },
      ],
    },
    { key: 'forwardV', label: 'Forward voltage (overrides colour)', unit: 'V', kind: 'num', step: 0.1 },
  ],
  diode: [],
  zener: [{ key: 'vz', label: 'Breakdown voltage Vz', unit: 'V', kind: 'num', step: 0.1 }],
  transistor: [
    {
      key: 'polarity', label: 'Type', kind: 'select',
      options: [{ value: 'npn', label: 'NPN (BC547)' }, { value: 'pnp', label: 'PNP (BC557)' }],
    },
  ],
  mosfet: [{ key: 'vth', label: 'Gate threshold Vth', unit: 'V', kind: 'num', step: 0.1 }],
  battery: [{ key: 'volts', label: 'Voltage', unit: 'V', kind: 'num', step: 0.5 }],
  cap: [{ key: 'uf', label: 'Capacitance', unit: 'uF', kind: 'num', step: 10 }],
  buzzer: [],
  motor: [
    { key: 'rOhms', label: 'Winding resistance', unit: '\u03a9', kind: 'num', step: 5 },
    { key: 'rpmPerV', label: 'Speed constant', unit: 'rpm/V', kind: 'num', step: 100 },
  ],
  button: [{ key: 'bounce', label: 'Contact bounce window', unit: 'ms', kind: 'num', step: 0.5 }],
  pot: [{ key: 'ratio', label: 'Wiper position', unit: '0..1', kind: 'num', step: 0.01 }],
  ldr: [{ key: 'lux', label: 'Light level', unit: 'lx', kind: 'num', step: 10 }],
  dht: [
    {
      key: 'model', label: 'Model', kind: 'select',
      options: [{ value: 'DHT11', label: 'DHT11' }, { value: 'DHT22', label: 'DHT22' }],
    },
    { key: 'tempC', label: 'Temperature', unit: 'C', kind: 'num', step: 0.5 },
    { key: 'humPct', label: 'Humidity', unit: '%', kind: 'num', step: 1 },
  ],
  hcsr: [{ key: 'cm', label: 'Target distance', unit: 'cm', kind: 'num', step: 1 }],
  servo: [],
  relay: [],
  oled: [{ key: 'addr', label: 'I2C address', kind: 'num', hex: true }],
  neopixel: [{ key: 'count', label: 'Pixel count', kind: 'num', step: 1 }],
  board: [
    {
      key: 'board', label: 'Board model', kind: 'select',
      options: listBoards().map((b) => ({ value: b.id, label: b.name })),
    },
  ],
};

export const CONFIGURABLE = new Set(Object.keys(FIELDS));

function parseField(f: Field, raw: string, current: unknown): unknown {
  if (f.kind === 'select') return raw;
  const t = raw.trim().toLowerCase();
  if (f.hex && (t.startsWith('0x') || /^[0-9a-f]+$/.test(t))) return parseInt(t.replace(/^0x/, ''), 16);
  const n = Number(t);
  return Number.isFinite(n) ? n : current;
}

interface Props {
  comp: PlacedComponent;
  onClose: () => void;
  /** params holds only changed electrical fields; label is the caption ('' clears) */
  onApply: (params: Record<string, unknown>, label: string) => void;
}

export function ComponentDialog({ comp, onClose, onApply }: Props) {
  const fields = FIELDS[comp.type] ?? [];
  const [label, setLabel] = useState(() => comp.label ?? '');
  const [vals, setVals] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      fields.map((f) => {
        const v = comp.params[f.key];
        const shown = f.kind === 'num' && f.hex && typeof v === 'number'
          ? `0x${v.toString(16)}`
          : String(v ?? '');
        return [f.key, shown];
      }),
    ),
  );

  const apply = (): void => {
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      const v = parseField(f, vals[f.key] ?? '', comp.params[f.key]);
      if (v !== comp.params[f.key]) out[f.key] = v;
    }
    onApply(out, label.trim());
  };

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog">
        <div className="dialog-title">
          {comp.type} <span className="dialog-id">{comp.id}</span>
          <button className="dialog-x" onClick={onClose} aria-label="Close">x</button>
        </div>
        <label className="dialog-row">
          <span>Label</span>
          <input
            type="text"
            value={label}
            placeholder="caption under the part"
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') apply(); }}
          />
        </label>
        {fields.length === 0 && (
          <div className="dialog-note">This part has no adjustable parameters.</div>
        )}
        {fields.map((f) => (
          <label key={f.key} className="dialog-row">
            <span>
              {f.label}
              {f.kind === 'num' && f.unit ? ` (${f.unit})` : ''}
            </span>
            {f.kind === 'select' ? (
              <select
                value={vals[f.key] ?? ''}
                onChange={(e) => setVals((v) => ({ ...v, [f.key]: e.target.value }))}
              >
                {f.options.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                inputMode="decimal"
                value={vals[f.key] ?? ''}
                onChange={(e) => setVals((v) => ({ ...v, [f.key]: e.target.value }))}
                onKeyDown={(e) => { if (e.key === 'Enter') apply(); }}
              />
            )}
          </label>
        ))}
        <div className="dialog-actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-run" onClick={apply}>
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
