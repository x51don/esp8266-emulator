/**
 * F14: the wire colour picker. Right-click a wire and paint it from a
 * larger palette; "auto" returns it to the net-role default (power red,
 * GND white, signal green).
 */

export const WIRE_PALETTE = [
  '#ff5252', // red
  '#ff9800', // orange
  '#ffd54f', // yellow
  '#4ade80', // green
  '#00e5ff', // cyan
  '#4d8cff', // blue
  '#b366ff', // purple
  '#ff6ec7', // pink
  '#8d6e63', // brown
  '#9aa7b8', // grey
  '#e8eef5', // white
  '#111418', // near-black
];

interface Props {
  x: number;
  y: number;
  current: string | undefined;
  onPick: (color: string | undefined) => void;
}

export function WireColorMenu({ x, y, current, onPick }: Props) {
  return (
    <div
      className="wire-color-menu"
      style={{ left: x, top: y }}
      // keep the click that chose us from also landing on the canvas
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button className="wire-color-auto" onClick={() => onPick(undefined)}>
        auto
      </button>
      <div className="wire-color-swatches">
        {WIRE_PALETTE.map((c) => (
          <button
            key={c}
            className={`wire-swatch${current === c ? ' active' : ''}`}
            style={{ background: c }}
            title={c}
            onClick={() => onPick(c)}
          />
        ))}
      </div>
    </div>
  );
}
