import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Esp8266Machine, type SerialLine } from '../core/machine';
import { listBoards } from '../core/boards';
import { Schematic } from './canvas/schematic';
import { routeWire } from './canvas/routes';
import { Palette } from './components/Palette';
import { SchematicCanvas, confirmOr, type CanvasHandles } from './components/SchematicCanvas';
import { ComponentDialog } from './components/ComponentDialog';
import { CodeEditor } from './components/CodeEditor';
import { SerialMonitor } from './components/SerialMonitor';
import { HttpPanel } from './components/HttpPanel';
import { Toolbar } from './components/Toolbar';
import { EXAMPLE_NAMES, EXAMPLE_SKETCHES, loadExample } from './examples';
import { eepromFromB64, eepromToB64, ProjectStore, type ProjectData } from './projects';

export const NEW_SKETCH_TEMPLATE = `// New project - ESP8266 (Wemos D1 mini / NodeMCU).
// Build a circuit, wire it to a pin and drive it from here.

void setup() {
  pinMode(D4, OUTPUT);
  Serial.begin(115200);
  Serial.println("hello esp8266");
}

void loop() {
  delay(100);
}
`;

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

/** A stale/corrupt board id must not crash the machine constructor at mount. */
export function resolveBoardId(saved: string | null): string {
  const fallback = 'wemos-d1-mini';
  if (saved && listBoards().some((b) => b.id === saved)) return saved;
  if (saved !== null && saved !== fallback) {
    console.warn(`unknown board "${saved}" in localStorage; using "${fallback}"`);
  }
  return fallback;
}

export function App() {
  const [boardId, setBoardId] = useState<string>(
    () => resolveBoardId(localStorage.getItem(LS.board)),
  );
  const [sketch, setSketch] = useState<string>(
    () => localStorage.getItem(LS.sketch) ?? EXAMPLE_SKETCHES['blink.ino'],
  );
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [serialLines, setSerialLines] = useState<readonly SerialLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  const [configureId, setConfigureId] = useState<string | null>(null);

  const [schematic, setSchematic] = useState<Schematic>(loadSchematic);
  const [docEpoch, setDocEpoch] = useState(0); // bumps when a whole doc is swapped in
  const store = useMemo(() => new ProjectStore(localStorage), []);
  const [projects, setProjects] = useState<string[]>(() => store.list());
  const [machine, setMachine] = useState(() => new Esp8266Machine({ board: boardId }));
  const canvasApi = useRef<CanvasHandles | null>(null);
  const [bottomTab, setBottomTab] = useState<'serial' | 'http'>('serial');
  /** F6: EEPROM contents to plant into the next machine (project load) */
  const pendingEeprom = useRef<Uint8Array | null>(null);

  // ---- machine lifecycle: one machine per board (and per doc swap) ----
  useEffect(() => {
    const m = new Esp8266Machine({ board: boardId });
    // project load wins; otherwise flash survives a board switch like on hardware
    m.eepromRestore(pendingEeprom.current ?? machineRef.current?.eepromBytes() ?? new Uint8Array(0));
    pendingEeprom.current = null;
    const offSerial = m.onSerial((line) => setSerialLines((prev) => (prev.length > 600 ? [...prev.slice(-500), line] : [...prev, line])));
    // a runtime error faults the machine mid-run; surface it and leave play mode
    const offFault = m.onFault((reason) => {
      setError(reason);
      setRunning(false);
    });
    // keep the board component in the document in sync with the toolbar
    // (mutator, not a direct param write: geometry caches must be invalidated)
    if (schematic.boardComponent()) schematic.setBoard(boardId);
    schematic.syncNetlist(m.netlist);
    setMachine(m);
    setRunning(false);
    setSerialLines([]);
    try {
      localStorage.setItem(LS.board, boardId);
    } catch {
      /* quota: the id is only a convenience, not worth a banner */
    }
    return () => {
      offFault();
      offSerial();
    };
  }, [boardId, schematic, docEpoch]);

  // ---- persistence ----
  const safeStore = useCallback((key: string, value: string) => {
    try {
      localStorage.setItem(key, value);
    } catch (e) {
      setError(
        `could not save to browser storage (${
          e instanceof Error ? e.name : 'QuotaExceeded'
        }) - your work is still in this tab`,
      );
    }
  }, []);

  const persist = useCallback(() => {
    safeStore(LS.schematic, schematic.toJSON());
  }, [schematic, safeStore]);

  const onEdit = useCallback(() => {
    persist();
    schematic.syncNetlist(machine.netlist); // param edits apply live
    machine.advance(0); // re-solve the circuit for the live view
  }, [machine, persist, schematic]);

  /** Replace the whole document (example / project / import). */
  const applyDoc = useCallback((next: Schematic, nextSketch?: string) => {
    safeStore(LS.schematic, next.toJSON());
    if (nextSketch !== undefined) safeStore(LS.sketch, nextSketch);
    setSchematic(next);
    if (nextSketch !== undefined) setSketch(nextSketch);
    setDocEpoch((e) => e + 1);
    setError(null);
  }, [safeStore]);

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
    // a preset hardwires pins; a board that lacks one must not silently die
    try {
      applyDoc(loadExample(name, boardId), src);
    } catch (e) {
      setError(`example "${name}" does not fit this board: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [applyDoc, boardId]);

  // ---- projects ----
  const currentProject = useCallback(
    (): ProjectData => ({
      name: 'project',
      sketch,
      schematic: schematic.toJSON(),
      board: boardId,
      eeprom: eepromToB64(machine.eepromBytes()),
    }),
    [sketch, schematic, boardId, machine],
  );

  const onNewProject = useCallback(() => {
    if (!confirmOr('Start a new project? The current sketch and circuit are replaced.')) return;
    pendingEeprom.current = new Uint8Array(4096).fill(0xff);
    const fresh = new Schematic();
    fresh.addBoard(boardId, 160, 60);
    applyDoc(fresh, NEW_SKETCH_TEMPLATE);
  }, [applyDoc, boardId]);

  const onProjectSave = useCallback(() => {
    const name = window.prompt('Save project as:', 'project-1');
    if (!name || !name.trim()) return;
    try {
      store.save({ ...currentProject(), name: name.trim() });
      setProjects(store.list());
    } catch (e) {
      setError(
        `could not save project (${
          e instanceof Error ? e.name : 'error'
        }) - browser storage is full`,
      );
    }
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
      pendingEeprom.current = eepromFromB64(data.eeprom);
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
          pendingEeprom.current = eepromFromB64(data.eeprom);
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
      safeStore(LS.sketch, sketch);
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
  }, [machine, sketch, schematic, safeStore]);

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
      wirePath: (id: string) => schematic.wireRoutes().get(id) ?? null,
      loadExample: (name: string) => {
        applyDoc(loadExample(name, boardId), EXAMPLE_SKETCHES[name]);
      },
    };
    return () => {
      delete (window as unknown as Record<string, unknown>).__emu;
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
        onNewProject={onNewProject}
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
          onConfigure={setConfigureId}
          api={canvasApi}
        />
        <div className="right-col">
          <div className="editor-panel">
            <div className="panel-title">sketch.ino</div>
            <CodeEditor value={sketch} onChange={setSketch} />
          </div>
          <div className="dock-tabs">
            <button
              className={`dock-tab${bottomTab === 'serial' ? ' active' : ''}`}
              onClick={() => setBottomTab('serial')}
            >
              Serial
            </button>
            <button
              className={`dock-tab${bottomTab === 'http' ? ' active' : ''}`}
              onClick={() => setBottomTab('http')}
            >
              HTTP
            </button>
          </div>
          {bottomTab === 'serial' ? (
            <SerialMonitor lines={serialLines} onClear={() => setSerialLines([])} />
          ) : (
            <HttpPanel
              ip={machine.ip}
              running={running}
              onFetch={(mth, u, b) => machine.fetchHttp(mth, u, b)}
            />
          )}
        </div>
      </div>
      {configureId && (() => {
        const comp = schematic.component(configureId);
        if (!comp) return null;
        return (
          <ComponentDialog
            comp={comp}
            onClose={() => setConfigureId(null)}
            onApply={(params) => {
              const entries = Object.entries(params);
              for (const [k, v] of entries) schematic.setParam(comp.id, k, v);
              const board = params.board;
              if (comp.type === 'board' && typeof board === 'string') {
                // keep the toolbar selector and the machine in sync
                setBoardId(board);
              } else if (entries.length > 0) {
                onEdit();
              }
              setConfigureId(null);
            }}
          />
        );
      })()}
    </div>
  );
}
