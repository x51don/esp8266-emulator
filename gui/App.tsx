import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Esp8266Machine, type SerialLine } from '../core/machine';
import { listBoards } from '../core/boards';
import { Schematic } from './canvas/schematic';
import { routeWire } from './canvas/routes';
import { pinDir } from './canvas/renderer';
import { Palette } from './components/Palette';
import { SchematicCanvas, confirmOr, type CanvasHandles } from './components/SchematicCanvas';
import { CodeEditor } from './components/CodeEditor';
import { SerialMonitor } from './components/SerialMonitor';
import { Toolbar } from './components/Toolbar';
import { EXAMPLE_NAMES, EXAMPLE_SKETCHES, loadExample } from './examples';
import { ProjectStore, type ProjectData } from './projects';

const LS = {
  sketch: 'esp8266-emu.sketch',
  schematic: 'esp8266-emu.schematic',
  board: 'esp8266-emu.board',
};

function loadSchematic(): Schematic {
  try {
    const raw = localStorage.getItem(LS.schematic);
    if (raw) return Schematic.fromJSON(raw); // a board-less canvas is legal
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
    () => localStorage.getItem(LS.sketch) ?? EXAMPLE_SKETCHES['blink.ino'],
  );
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [serialLines, setSerialLines] = useState<readonly SerialLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [fault, setFault] = useState<string | null>(null);

  const [schematic, setSchematic] = useState<Schematic>(loadSchematic);
  const [docEpoch, setDocEpoch] = useState(0); // bumps when a whole doc is swapped in
  const store = useMemo(() => new ProjectStore(localStorage), []);
  const [projects, setProjects] = useState<string[]>(() => store.list());
  const [machine, setMachine] = useState(() => new Esp8266Machine({ board: boardId }));
  const canvasApi = useRef<CanvasHandles | null>(null);

  // ---- machine lifecycle: one machine per board (and per doc swap) ----
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
  }, [boardId, schematic, docEpoch]);

  // ---- persistence ----
  const persist = useCallback(() => {
    localStorage.setItem(LS.schematic, schematic.toJSON());
  }, [schematic]);

  const onEdit = useCallback(() => {
    persist();
    machine.advance(0); // re-solve the circuit for the live view
  }, [machine, persist]);

  /** Replace the whole document (example / project / import). */
  const applyDoc = useCallback((next: Schematic, nextSketch?: string) => {
    localStorage.setItem(LS.schematic, next.toJSON());
    if (nextSketch !== undefined) localStorage.setItem(LS.sketch, nextSketch);
    setSchematic(next);
    if (nextSketch !== undefined) setSketch(nextSketch);
    setDocEpoch((e) => e + 1);
    setError(null);
  }, []);

  // ---- examples: sketch AND a wired circuit preset ----
  const onExample = useCallback((name: string) => {
    const src = EXAMPLE_SKETCHES[name];
    if (!src) return;
    if (
      !confirmOr(
        `Load "${name}"?\nThis replaces the current sketch AND the circuit on the canvas.`,
      )
    )
      return;
    applyDoc(loadExample(name, boardId), src);
  }, [applyDoc, boardId]);

  // ---- projects ----
  const currentProject = useCallback(
    (): ProjectData => ({
      name: 'project',
      sketch,
      schematic: schematic.toJSON(),
      board: boardId,
    }),
    [sketch, schematic, boardId],
  );

  const onProjectSave = useCallback(() => {
    const name = window.prompt('Save project as:', 'project-1');
    if (!name || !name.trim()) return;
    store.save({ ...currentProject(), name: name.trim() });
    setProjects(store.list());
  }, [store, currentProject]);

  const onProjectLoad = useCallback((name: string) => {
    const data = store.load(name);
    if (!data) {
      setError(`project "${name}" is unreadable`);
      setProjects(store.list());
      return;
    }
    if (!confirmOr(`Replace the current sketch and circuit with project "${name}"?`)) return;
    try {
      applyDoc(Schematic.fromJSON(data.schematic), data.sketch);
      setBoardId(data.board);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [store, applyDoc]);

  const onProjectDelete = useCallback((name: string) => {
    if (!confirmOr(`Delete project "${name}"?`)) return;
    store.remove(name);
    setProjects(store.list());
  }, [store]);

  const onExport = useCallback(() => {
    const text = store.exportJson(currentProject());
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    a.download = 'esp8266-project.json';
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }, [store, currentProject]);

  const onImportFile = useCallback((file: File) => {
    file.text().then(
      (text) => {
        let data: ProjectData;
        try {
          data = store.parseImport(text);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
          return;
        }
        if (!confirmOr(`Import "${data.name || file.name}"? It replaces the current sketch and circuit.`))
          return;
        try {
          applyDoc(Schematic.fromJSON(data.schematic), data.sketch);
          setBoardId(data.board);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      },
      () => setError('could not read the file'),
    );
  }, [store, applyDoc]);

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

  // Debug/automation hook: the whole model is reachable from the console.
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__emu = {
      schematic,
      get machine() {
        return machineRef.current;
      },
      get viewport() {
        return canvasApi.current?.viewport;
      },
      setSketch,
      routeWire,
      /** Routed world polyline of a wire (same computation the canvas does). */
      wirePath: (id: string) => {
        const w = schematic.wires.get(id);
        if (!w) return null;
        const a = schematic.pinWorld(w.a);
        const b = schematic.pinWorld(w.b);
        return routeWire(
          a, b,
          pinDir(schematic, w.a, a),
          pinDir(schematic, w.b, b),
          schematic.wireObstacles(w.a, w.b),
        );
      },
      loadExample: (name: string) => {
        applyDoc(loadExample(name, boardId), EXAMPLE_SKETCHES[name]);
      },
    };
  }, [schematic, applyDoc, boardId]);
  const machineRef = useRef(machine);
  machineRef.current = machine;

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
        examples={EXAMPLE_NAMES}
        onExample={onExample}
        projects={projects}
        onProjectLoad={onProjectLoad}
        onProjectSave={onProjectSave}
        onProjectDelete={onProjectDelete}
        onExport={onExport}
        onImportFile={onImportFile}
        error={error}
        fault={fault}
      />
      <div className="main">
        <Palette />
        <SchematicCanvas
          key={`${boardId}:${docEpoch}`}
          schematic={schematic}
          machine={machine}
          running={running}
          speed={speed}
          boardId={boardId}
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
