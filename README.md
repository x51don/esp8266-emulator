# ESP8266 Visual Emulator (Wemos D1 mini / NodeMCU)

Browser-based emulator for the ESP8266 as used on Wemos D1 mini and NodeMCU v3
boards: drag-and-drop circuit canvas, live wiring, Arduino-sketch editor with
syntax highlighting, virtual Serial Monitor and a real-time simulation engine
(virtual clock, GPIO/PWM, pull-ups, LED currents, short/burnout detection).

## Run

```bash
pnpm install
pnpm run dev      # http://127.0.0.1:5188
```

Production build: `pnpm run build` -> static files in `dist/` (serve with any
static server). Tests: `pnpm test` (Vitest). Browser E2E (needs `pnpm run build`
+ a static server on :8090 and system Chromium): `node scripts/verify.mjs`.

## Using it

1. **Build the circuit** - drag components (LED, resistor, button, buzzer,
   battery) from the left palette onto the canvas. Drop the LED next to a board
   pin: the LED symbol ships with its series resistor, pre-wired.
2. **Wire pins** - press on a pin dot and drag to another pin. Wires are
   orthogonal; drag components to reroute. `Del` removes, `R` rotates,
   shift-click multi-selects, wheel zooms, dragging empty space pans.
3. **Write the sketch** - Arduino subset in the editor: `setup()/loop()`,
   `pinMode/digitalWrite/digitalRead/analogWrite`, `delay/delayMicroseconds`,
   `Serial.begin/print/println/printf/write`, `millis/micros`,
   `timerAlarmWrite/timerAlarmEnable` (cooperative ISRs), `String/map/min/max...`.
   Pick a starting point from *Examples*.
4. **Run** - the toolbar Run loads the sketch and cold-starts the virtual chip.
   Wires and pin dots light up yellow on HIGH; LEDs glow (and burn out when
   wired without a resistor). While running, click a button to hold it; the
   speed selector scales wall -> virtual time (up to 64x). Stop freezes; Reset
   is a cold chip reset. Faults (shorts, bus contention, burnt LEDs) appear in
   the toolbar banner.

The schematic and sketch persist in localStorage. `window.__emu` exposes the
live model (schematic, machine) for console debugging and browser automation.

## How it simulates

No Xtensa machine code here: sketches run on a tree-walking interpreter for a
documented Arduino-C++ subset, executed cooperatively as JS generators against
virtual hardware (register file -> GPIO bus -> circuit solver), all driven by a
microsecond virtual clock. `docs/context/ARCHITECTURE.md` records the decisions;
`docs/context/milestone_*.md` the build journal.

### Known limitations (documented deviations)

- Sketch language = subset of Arduino-C++ (no classes, pointers, structs,
  templates; blocking calls are cooperatively scheduled).
- Timer ISRs are cooperative: they run between `loop()` slices, never
  preempting it.
- A `loop()` without any `delay()` spins the scheduler guard, mirroring a real
  CPU hogging the watchdog.
- Circuit model is logic-level with LED current limits and pull-ups; not SPICE.

## Layout

```
core/          clock, registers, machine facade, boards, sketch interpreter
peripherals/   GPIO bus, circuit netlist solver
gui/           React app: canvas engine, components, sim driver
scripts/       verify.mjs (headless-CDP E2E), demo.mjs
examples/      blink, pwm-fade, button, serial-hello
tests/         Vitest suites, one per logic module
docs/context/  architecture + milestone journals
```
