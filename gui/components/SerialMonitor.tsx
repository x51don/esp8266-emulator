/**
 * Serial Monitor: virtual-terminal view of machine.serial. Auto-scrolls
 * while pinned to the bottom; timestamps in +0.000s style like PuTTY logs.
 */

import { useEffect, useRef, useState } from 'react';
import type { SerialLine } from '../../core/machine';

interface Props {
  lines: readonly SerialLine[];
  onClear: () => void;
}

export function SerialMonitor({ lines, onClear }: Props) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const pinned = useRef(true);
  const [autoscroll, setAutoscroll] = useState(true);

  useEffect(() => {
    const box = boxRef.current;
    if (box && pinned.current) box.scrollTop = box.scrollHeight;
  }, [lines]);

  return (
    <div className="serial-panel">
      <div className="panel-title">
        Serial Monitor
        <span className="spacer" />
        <label className="mini-toggle">
          <input
            type="checkbox"
            checked={autoscroll}
            onChange={(e) => {
              setAutoscroll(e.target.checked);
              pinned.current = e.target.checked;
            }}
          />
          follow
        </label>
        <button className="mini-btn" onClick={onClear}>
          clear
        </button>
      </div>
      <div
        className="serial-body"
        ref={boxRef}
        onScroll={() => {
          const box = boxRef.current;
          if (box) pinned.current = autoscroll && box.scrollHeight - box.scrollTop - box.clientHeight < 24;
        }}
      >
        {lines.map((l) => (
          <div key={l.id} className="serial-line">
            <span className="serial-ts">+{(l.tMs / 1000).toFixed(3)}s</span>
            {l.text === '' ? '\u00a0' : l.text}
          </div>
        ))}
        {lines.length === 0 && <div className="serial-empty">no output yet - press Run</div>}
      </div>
    </div>
  );
}
