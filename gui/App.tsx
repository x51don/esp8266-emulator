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
import { lan, lanFetch } from '../core/lan';

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

/** F10: every device is one Esp8266Machine on the shared virtual LAN. */
interface Device {
  id: number;
  name: string;
  ip: string;
}
let deviceSeq = 0;
const makeDevice = (): Device => ({
  id: ++deviceSeq,
  name: `esp-${deviceSeq}`,
  ip: `192.168.1.${41 + deviceSeq}`,
});

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
  const [machine, setMachine] = useState(() => new Esp8266Machine({ board: boardId, ip: '192.168.1.42' }));
  const canvasApi = useRef<CanvasHandles | null>(null);
  const [bottomTab, setBottomTab] = useState<'serial' | 'http'>('serial');
  /** F6: EEPROM contents to plant into the next machine (project load) */
  const pendingEeprom = useRef<Uint8Array | null>(null);
  /** F11: per-device flashes to plant at creation (project load, ids are fresh) */
  const pendingSeed = useRef(new Map<number, Uint8Array>());
  /** F11: named project the bench is autosaved into (null: nothing to autosave) */
  const openProject = useRef<string | null>(null);
  // ---- F10: devices (each one machine on the LAN, own sketch) ----
  const [devices, setDevices] = useState<Device[]>(() => [makeDevice()]);
  const [activeId, setActiveId] = useState(1);
  const activeRef = useRef(1);
  const machinesRef = useRef(new Map<number, Esp8266Machine>());
  const machineBoard = useRef(new Map<number, string>());
  const sketchesRef = useRef(new Map<number, string>());
  const sketchRef = useRef(sketch);
  sketchRef.current = sketch;
  const devicesState = useRef(devices);
  devicesState.current = devices;

  // adopt the placeholder machine as device #1 (declared BEFORE the sync
  // effect so it runs first on mount; its sketch is the restored editor text)
  useEffect(() => {
    machinesRef.current.set(1, machineRef.current);
    machineBoard.current.set(1, boardId);
    sketchesRef.current.set(1, sketchRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- machine lifecycle: one machine per device; the active one drives
  // the editor, canvas, serial and HTTP panel; doc swaps dispose them all ----
  useEffect(() => {
    const dev = devices.find((d) => d.id === activeId) ?? devices[0];
    activeRef.current = dev.id;
    let m = machinesRef.current.get(dev.id);
    if (m && machineBoard.current.get(dev.id) !== boardId) {
      // board swap: the flash survives like on the real PCB
      const seed = pendingEeprom.current ?? m.eepromBytes();
      m.dispose();
      machinesRef.current.delete(dev.id);
      pendingEeprom.current = seed;
      m = undefined;
    }
    if (!m) {
      m = new Esp8266Machine({ board: boardId, ip: dev.ip });
      // project flash wins, then a planted one (new project), else erased chip
      const seed = pendingSeed.current.get(dev.id);
      if (seed !== undefined) {
        pendingSeed.current.delete(dev.id);
        m.eepromRestore(seed);
      } else {
        m.eepromRestore(pendingEeprom.current ?? new Uint8Array(0));
        pendingEeprom.current = null;
      }
      machineBoard.current.set(dev.id, boardId);
      m.onSerial((line) => {
        if (activeRef.current === dev.id)
          setSerialLines((prev) => (prev.length > 600 ? [...prev.slice(-500), line] : [...prev, line]));
      });
      m.onFault((reason) => {
        setError(reason);
        if (activeRef.current === dev.id) setRunning(false);
      });
      machinesRef.current.set(dev.id, m);
    }
    // keep the board component in the document in sync with the toolbar
    // (mutator, not a direct param write: geometry caches must be invalidated)
    if (schematic.boardComponent()) schematic.setBoard(boardId);
    schematic.syncNetlist(m.netlist);
    setMachine(m);
    setRunning(false);
    setSerialLines(m.serial); // each device keeps its own boot log
    try {
      localStorage.setItem(LS.board, boardId);
    } catch {
      /* quota: the id is only a convenience, not worth a banner */
    }
  }, [boardId, schematic, docEpoch, devices, activeId]);

  const switchDevice = useCallback(
    (id: number) => {
      if (id === activeRef.current) return;
      sketchesRef.current.set(activeRef.current, sketchRef.current);
      setActiveId(id);
      activeRef.current = id;
      setSketch(sketchesRef.current.get(id) ?? NEW_SKETCH_TEMPLATE);
      setError(null);
    },
    [],
  );

  const onAddDevice = useCallback(() => {
    sketchesRef.current.set(activeRef.current, sketchRef.current);
    const dev = makeDevice();
    sketchesRef.current.set(dev.id, NEW_SKETCH_TEMPLATE);
    setDevices((ds) => [...ds, dev]);
    setActiveId(dev.id);
    activeRef.current = dev.id;
    setSketch(NEW_SKETCH_TEMPLATE);
  }, []);

  const onRemoveDevice = useCallback(
    (id: number) => {
      if (!window.confirm('Remove this device? Its machine, sketch and flash are dropped.')) return;
      const m = machinesRef.current.get(id);
      if (m) {
        m.dispose();
        machinesRef.current.delete(id);
        machineBoard.current.delete(id);
      }
      sketchesRef.current.delete(id);
      const rest = devices.filter((d) => d.id !== id);
      setDevices(rest.length ? rest : devices);
      if (id === activeRef.current && rest.length) {
        setActiveId(rest[0].id);
        activeRef.current = rest[0].id;
        setSketch(sketchesRef.current.get(rest[0].id) ?? NEW_SKETCH_TEMPLATE);
      }
    },
    [devices],
  );

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
  const applyDoc = useCallback((next: Schematic, nextSketch?: string, data?: ProjectData) => {
    safeStore(LS.schematic, next.toJSON());
    if (nextSketch !== undefined) safeStore(LS.sketch, nextSketch);
    // a whole-doc swap retires every device; the project owns the bench again
    for (const m of machinesRef.current.values()) m.dispose();
    machinesRef.current.clear();
    machineBoard.current.clear();
    sketchesRef.current.clear();
    pendingSeed.current.clear();
    deviceSeq = 0;
    const list: Device[] = [];
    if (data?.devices?.length) {
      for (const dd of data.devices) {
        const dev = makeDevice();
        if (dd.name) dev.name = dd.name; // keep the label, regenerate the lease
        list.push(dev);
        sketchesRef.current.set(dev.id, dd.sketch);
        if (dd.eeprom !== undefined) pendingSeed.current.set(dev.id, eepromFromB64(dd.eeprom));
      }
    } else {
      list.push(makeDevice());
    }
    setDevices(list);
    setActiveId(1);
    activeRef.current = 1;
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
    openProject.current = null; // an example must not autosave into the project
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
      devices: devices.map((d) => {
        const m = machinesRef.current.get(d.id);
        return {
          name: d.name,
          sketch: sketchesRef.current.get(d.id) ?? sketch,
          eeprom: m ? eepromToB64(m.eepromBytes()) : undefined,
        };
      }),
    }),
    [sketch, schematic, boardId, machine, devices],
  );

  const onNewProject = useCallback(() => {
    if (!confirmOr('Start a new project? The current sketch and circuit are replaced.')) return;
    openProject.current = null;
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
      openProject.current = name.trim();
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
      // legacy single-device projects seed the primary chip; F11 projects
      // carry a flash image per device inside `devices`
      if (!data.devices?.length) pendingEeprom.current = eepromFromB64(data.eeprom);
      applyDoc(
        Schematic.fromJSON(data.schematic),
        data.devices?.[0]?.sketch ?? data.sketch,
        data,
      );
      setBoardId(data.board);
      openProject.current = name;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [store, applyDoc]);

  // ---- F11: a committed EEPROM page autosaves the open project (no prompt) ----
  const currentProjectRef = useRef(currentProject);
  currentProjectRef.current = currentProject;
  // the baseline lives outside the effect: a commit during setup() of the
  // very run that set `running` must not be swallowed by a fresh baseline
  const lastEepromDirty = useRef(0);
  const allEepromDirty = () => {
    let d = 0;
    for (const m of machinesRef.current.values()) d += m.eepromDirty;
    return d;
  };
  useEffect(() => {
    if (!running) return;
    let last = lastEepromDirty.current;
    const iv = window.setInterval(() => {
      const d = allEepromDirty();
      if (d === last) return;
      last = d;
      lastEepromDirty.current = d;
      const name = openProject.current;
      if (!name) return;
      try {
        store.save({ ...currentProjectRef.current(), name });
      } catch {
        /* storage full: the next manual Save shows the banner */
      }
    }, 1000);
    return () => window.clearInterval(iv);
  }, [running, store]);

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
          if (!data.devices?.length) pendingEeprom.current = eepromFromB64(data.eeprom);
          applyDoc(
            Schematic.fromJSON(data.schematic),
            data.devices?.[0]?.sketch ?? data.sketch,
            data,
          );
          setBoardId(data.board);
          openProject.current = null; // an import is not a storage slot
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
      sketchesRef.current.set(activeRef.current, sketch);
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
      // the bench from state; a device gets its machine at first activation
      devices: () =>
        devicesState.current.map((d) => {
          const m = machinesRef.current.get(d.id);
          return { id: d.id, name: d.name, ip: m?.ip ?? d.ip, phase: m?.phase() ?? 'unbuilt' };
        }),
      addDevice: onAddDevice,
      switchDevice,
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
  }, [schematic, applyDoc, boardId, onAddDevice, switchDevice]);
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
      <div className="device-bar">
        {devices.map((d) => (
          <button
            key={d.id}
            className={`device-chip${d.id === activeId ? ' active' : ''}`}
            onClick={() => switchDevice(d.id)}
            title={`virtual IP ${d.ip}`}
          >
            {d.name}{' '}
            <span className="device-ip">
              .{(machinesRef.current.get(d.id)?.ip ?? d.ip).split('.').pop()}
            </span>
          </button>
        ))}
        <button className="device-chip device-add" onClick={onAddDevice} title="Add another ESP8266 to the LAN">
          +
        </button>
        {devices.length > 1 && (
          <button
            className="device-chip device-del"
            onClick={() => onRemoveDevice(activeId)}
            title="Remove the active device"
          >
            &times;
          </button>
        )}
      </div>
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
            <CodeEditor
              value={sketch}
              onChange={(v) => {
                sketchesRef.current.set(activeRef.current, v);
                setSketch(v);
              }}
            />
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
              onFetch={(mth, u, b) => {
                // F10: any host on the virtual LAN answers, not just this chip
                const host = /^https?:\/\/([^/:?#]+)/i.exec(u.trim())?.[1] ?? '';
                const target = lan.routeHost(host);
                if (!target || target === machineRef.current) return machine.fetchHttp(mth, u, b);
                return lanFetch(target, mth, u, b);
              }}
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
