/**
 * P3.1: virtual bench supply for the ADC pin. The slider forces the A0 net
 * through a weak (10k) source - a real driver on the pin still wins the
 * divider, so wiring a pot AND using the dock just blends the two voltages.
 * The force lives in the Netlist, so document resyncs keep it.
 */
import { useEffect, useState } from 'react';
import type { Esp8266Machine } from '../../core/machine';

export function AdcDock({ machine }: { machine: Esp8266Machine }) {
  const [on, setOn] = useState(false);
  const [volts, setVolts] = useState(1.65);

  useEffect(() => {
    machine.setAnalogForce(on ? volts : null);
  }, [on, volts, machine]);

  const adc = Math.round((volts / 3.3) * 1023);
  return (
    <div className={`adc-dock${on ? ' on' : ''}`} title="Force editor for the A0/ADC node (weak 10k source)">
      <label className="adc-toggle">
        <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} />
        A0 force
      </label>
      <div className={`adc-row${on ? '' : ' off'}`}>
        <input
          type="range"
          min={0}
          max={3.3}
          step={0.01}
          value={volts}
          onChange={(e) => setVolts(Number(e.target.value))}
        />
        <span className="adc-read">
          {volts.toFixed(2)} V = {adc}
        </span>
      </div>
    </div>
  );
}
