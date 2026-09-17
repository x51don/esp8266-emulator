/**
 * Top toolbar: board, transport (Run/Stop/Reset), speed, examples and the
 * live fault/error banner.
 */

interface Props {
  boardId: string;
  boards: Array<{ id: string; name: string }>;
  onBoardChange: (id: string) => void;
  running: boolean;
  onRun: () => void;
  onStop: () => void;
  onReset: () => void;
  speed: number;
  onSpeed: (s: number) => void;
  examples: Record<string, string>;
  onExample: (name: string) => void;
  error: string | null;
  fault: string | null;
}

export function Toolbar(p: Props) {
  return (
    <div className="toolbar">
      <span className="logo">ESP8266 <b>Emulator</b></span>
      <select value={p.boardId} onChange={(e) => p.onBoardChange(e.target.value)} title="board">
        {p.boards.map((b) => (
          <option key={b.id} value={b.id}>{b.name}</option>
        ))}
      </select>
      <span className="toolbar-sep" />
      {!p.running ? (
        <button className="btn btn-run" onClick={p.onRun} disabled={!!p.error} title="load sketch + cold start">
          ▶ Run
        </button>
      ) : (
        <button className="btn btn-stop" onClick={p.onStop} title="freeze the simulation">
          ■ Stop
        </button>
      )}
      <button className="btn" onClick={p.onReset} title="cold reset (time to 0, pins released)">
        ⟲ Reset
      </button>
      <select value={p.speed} onChange={(e) => p.onSpeed(Number(e.target.value))} title="sim speed (wall -> virtual)">
        {[0.25, 1, 2, 4, 16, 64].map((s) => (
          <option key={s} value={s}>{s}x</option>
        ))}
      </select>
      <span className="toolbar-sep" />
      <select defaultValue="" onChange={(e) => { if (e.target.value) p.onExample(e.target.value); e.target.value = ''; }}>
        <option value="" disabled>Examples…</option>
        {Object.keys(p.examples).map((n) => (
          <option key={n} value={n}>{n}</option>
        ))}
      </select>
      <span className="spacer" />
      {p.error && <span className="banner banner-error" title={p.error}>⚠ {p.error}</span>}
      {!p.error && p.fault && <span className="banner banner-fault" title={p.fault}>⚡ {p.fault}</span>}
    </div>
  );
}
