import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Esp8266Machine, type SerialLine } from '../core/machine';
import { listBoards } from '../core/boards';
import { Schematic } from './canvas/schematic';
import { Palette } from './components/Palette';
import { SchematicCanvas, type CanvasHandles } from './components/SchematicCanvas';
import { CodeEditor } from './components/CodeEditor';
import { SerialMonitor } from './components/SerialMonitor';
import { Toolbar } from './components/Toolbar';

import blink from '../examples/blink.ino?raw';
import pwmFade from '../examples/pwm-fade.ino?raw';
import button from '../examples/button.ino?raw';
import serialHello from '../examples/serial-hello.ino?raw';

const EXAMPLES: Record<string, string> = {
  'blink.ino': blink,
  'pwm-fade.ino': pwmFade,
  'button.ino': button,
  'serial-hello.ino': serialHello,
};

const LS = {
  sketch: 'esp8266-emu.sketch',
  schematic: 'esp8266-emu.schematic',
  board: 'esp8266-emu.board',
};

function loadSchematic(): Schematic {
  try {
    const raw = localStorage.getItem(LS.schematic);
    if (raw) {
      const s = Schematic.fromJSON(raw);
      if (s.boardComponent()) return s;
    }
  } catch {
    /* corrupt storage -> fresh document */
  }
  const s = new Schematic();
  s.addBoard('wemos-d1-mini', 60, 40);
  return s;
}

export function App() {
  const [boardId, setBoardId] = useState<string>(
    () => localStorage.getItem(LS.board) ?? 'wemos-d1-mini',
  );
  const [sketch, setSketch] = useState<string>(
    () => localStorage.getItem(LS.sketch) ?? EXAMPLES['blink.ino'],
  );
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [serialLines, setSerialLines] = useState<readonly SerialLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [fault, setFault] = useState<string | null>(null);

  const schematic = useMemo(loadSchematic, []);
  const [machine, setMachine] = useState(() => new Esp8266Machine({ board: boardId }));
  const canvasApi = useRef<CanvasHandles | null>(null);

  // ---- machine lifecycle: one machine per board ----
  useEffect(() => {
    const m = new Esp8266Machine({ board: boardId });
    m.onSerial((line) => setSerialLines((prev) => (prev.length > 2000 ? [...prev.slice(-1500), line] : [...prev, line])));
    // keep the board component in the document in sync with the toolbar
    const boardComp = schematic.boardComponent();
    if (boardComp) boardComp.params.board = boardId;
    schematic.syncNetlist(m.netlist);
    setMachine(m);
    setRunning(false);
    setSerialLines([]);
    localStorage.setItem(LS.board, boardId);
  }, [boardId, schematic]);

  // ---- persistence ----
  const persist = useCallback(() => {
    localStorage.setItem(LS.schematic, schematic.toJSON());
  }, [schematic]);

  const onEdit = useCallback(() => {
    persist();
    machine.advance(0); // re-solve the circuit for the live view
  }, [machine, persist]);

  // ---- transport ----
  const onRun = useCallback(() => {
    try {
      machine.load(sketch);
      localStorage.setItem(LS.sketch, sketch);
      schematic.syncNetlist(machine.netlist);
      setSerialLines([]);
      machine.run();
      setRunning(true);
      setError(null);
    } catch (e) {
      setRunning(false);
      machine.stop();
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [machine, sketch, schematic]);

  const onStop = useCallback(() => {
    machine.stop();
    setRunning(false);
  }, [machine]);

  const onReset = useCallback(() => {
    machine.reset();
    setRunning(false);
    setSerialLines([]);
  }, [machine]);

  // ---- fault banner poll (cheap: resolve already ran on the last advance) ----
  useEffect(() => {
    if (!running) {
      setFault(null);
      return;
    }
    const id = window.setInterval(() => {
      const f = machine.circuit().faults;
      setFault(f.length ? `${f[0].message}${f.length > 1 ? ` (+${f.length - 1} more)` : ''}` : null);
    }, 250);
    return () => window.clearInterval(id);
  }, [running, machine]);

  // fit once the canvas exists
  useEffect(() => {
    const t = window.setTimeout(() => canvasApi.current?.fitTo(), 50);
    return () => window.clearTimeout(t);
  }, [machine]);

  return (
    <div className="app">
      <Toolbar
        boardId={boardId}
        boards={listBoards().map((b) => ({ id: b.id, name: b.name }))}
        onBoardChange={setBoardId}
        running={running}
        onRun={onRun}
        onStop={onStop}
        onReset={onReset}
        speed={speed}
        onSpeed={setSpeed}
        examples={EXAMPLES}
        onExample={(name) => {
          setSketch(EXAMPLES[name]);
          localStorage.setItem(LS.sketch, EXAMPLES[name]);
        }}
        error={error}
        fault={fault}
      />
      <div className="main">
        <Palette />
        <SchematicCanvas
          key={boardId}
          schematic={schematic}
          machine={machine}
          running={running}
          speed={speed}
          onEdit={onEdit}
          api={canvasApi}
        />
        <div className="right-col">
          <div className="editor-panel">
            <div className="panel-title">sketch.ino</div>
            <CodeEditor value={sketch} onChange={setSketch} />
          </div>
          <SerialMonitor lines={serialLines} onClear={() => setSerialLines([])} />
        </div>
      </div>
    </div>
  );
}
