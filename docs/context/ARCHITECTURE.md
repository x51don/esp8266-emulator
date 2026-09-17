# Architecture (living document)

Updated: 2026-02-19 (Phase 3 done: core + peripherals + machine facade; 158 tests green).
This file is the entry point after a session restart.
Milestone-by-milestone progress: see `docs/context/milestone_*.md` (highest number = latest state).

## What we build

A browser-based visual emulator for ESP8266 boards (Wemos D1 mini, NodeMCU):
drag-and-drop circuit canvas, wire routing between pins, Arduino-sketch editor with
syntax highlighting, virtual Serial Monitor, real-time simulation of GPIO/PWM signals.

## Tech stack (decision record)

- **TypeScript + React 18 + Vite 5** (web option from the brief). Chosen over Python/PySide6
  because: GUI verification is possible here via headless Chromium screenshots, richer
  editor/canvas ecosystem, user runs it by opening a URL - no Python install.
- **Canvas rendering: custom 2D engine** (`gui/canvas/`) - full control over pins/wires/drag,
  no heavyweight diagram lib. React owns panels; the canvas owns the schematic.
- **Code editor: CodeMirror 6** with `@codemirror/lang-cpp` (Arduino sketch = C++ subset).
- **Tests: Vitest**, one `tests/<module>.test.ts` per logic module. Strict TDD (red-green).
- **No WASAsembly/CPU emulation.** Decision: the "emulator" runs sketches on a
  **tree-walking interpreter** for a documented Arduino-C++ subset, executing cooperatively
  as a JS generator against virtual hardware. Full Xtensa emulation is out of scope
  (toolchain + compiled-firmware pipeline); the interpreter gives deterministic, testable,
  interruptible execution which is what the circuit simulation needs.

## Module map

```
core/            simulation engine (pure logic, no DOM)
  clock.ts       virtual clock + event scheduler (min-heap, speed multiplier)
  registers.ts   ESP8266 GPIO register file (GPIO_OUT / ENABLE / IN addresses)
  machine.ts     Esp8266Machine: cpu+gpio+serial+scheduler facade, run/stop/step
  sketch/        lexer.ts, parser.ts, interp.ts  (Arduino-C++ subset, generator-based)
  boards.ts      board & pinout definitions (chip GPIO <-> silk labels) for
                 Wemos D1 mini and NodeMCU v3
peripherals/     circuit components (pure logic)
  gpio.ts        GpioBus: electrical pin state (modes, pull-ups, open-drain D0,
                 PWM duty, external drivers, conflicts, onPinChange)
  netlist.ts     the drawn circuit: components/wires, Dijkstra source reach,
                 LED current/burnout, short/contention faults, resolve() ->
                 { leds, pinLevels, externals, faults, netOf, netVoltage }
  (more component kinds extend netlist params: buzzer, servo, OLED later)
gui/             React app + custom canvas engine (DOM allowed only here)  [Phase 4+]
  App.tsx        layout: palette | canvas | editor+serial panels, toolbar (run/stop/reset)
  canvas/        viewport (pan/zoom/grid), renderer, hit-testing, interaction tools
  CodeEditor.tsx CodeMirror wrapper
  SerialMonitor.tsx
tests/           Vitest unit + integration tests (one file per module)
docs/context/    progress journal (read first after restart)
examples/        example .ino sketches
```

## Simulation model

- **Virtual time**: `Clock` holds monotonic virtual `us`. Scheduler is a min-heap of
  `{due, action, id}`; `advanceTo(t)` fires due events in timestamp order. A driver
  (rAF in GUI, manual in tests) maps wall time -> virtual time with a speed factor.
- **Sketch execution**: interpreter compiles AST; runtime is a generator that yields on
  `delay()`, `delayMicroseconds()`, and at `loop()` boundaries. Machine resumes it when the
  scheduler wakes it. `millis()/micros()` read the Clock.
- **GPIO**: machine keeps pin mode/drive/pull; writes go through the register file and emit
  `pinchange` events. Reads resolve through the circuit (external drivers, pull-ups).
- **Circuit**: netlist union-find over wires; each settle pass propagates logic-level
  signals from drivers (MCU pins, buttons) through wires to receivers (LED+resistor chains,
  inputs). Digital model with current limiting shown on LEDs; not SPICE.

## Pin mapping (silkscreen <-> GPIO)

Wemos D1 mini / NodeMCU: D0=GPIO16, D1=GPIO5, D2=GPIO4, D3=GPIO0, D4=GPIO2,
D5=GPIO14, D6=GPIO12, D7=GPIO13, D8=GPIO15, plus 3V3/5V/RST/A0/GND.
GPIO9/10 are flash pins -> not exposed (board model rejects them, like the real boards).
D3/D4 have boot strapping notes; D0 can only be open-drain output (documented in boards.ts).

## Session constraints

- **One concurrent agent max** (user instruction 2026-09-17): run subagents sequentially,
  one at a time, never in parallel.
- Servers max 5 min to start; verification via headless Chromium screenshots for GUI.
- Approval prompts disabled; sandbox = danger-full-access. Conversation in Polish, code in English.
