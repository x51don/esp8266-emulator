# Milestone 2 - Simulation core (Phase 2)

Date: 2026-09-17. Status: DONE. 105 tests green, `tsc --noEmit` clean.

## Implemented modules (each TDD, tests in tests/)

- `core/clock.ts` - virtual-time Clock + min-heap scheduler. Passive (advance-driven),
  FIFO tie-break, intervals with fixed period, past-due fires ASAP, runaway guard
  (100k firings/advance), nextEventTime() for the driver.
- `core/registers.ts` - ESP8266 GPIO register file: OUT/ENABLE + W1TS/W1TC trio at real
  addresses (0x60000300..0x600003fc, IN at 0x3ff00018), 16-bit mask, change listeners,
  injectable IN sampler, reset() reports diff.
- `core/boards.ts` - Wemos D1 mini + NodeMCU v3 rail tables (row/side for GUI layout),
  D0..D8 <-> GPIO map, gpioFor("D4"|"GPIO4"|"4"), flash pins 9/10 -> null.
- `core/sketch/lexer.ts` - tokenizer + preprocessor (#include dropped, object-like
  #define expanded, function-like macros rejected), line-numbered diagnostics.
- `core/sketch/parser.ts` - recursive-descent parser -> plain-object AST. Functions,
  globals (const/static), arrays (incl. `int f(int a[])` params), if/else, for, while,
  do-while, break/continue/return, full expression grammar (C precedence, casts,
  ternary, ++/--). Rejects goto/struct with message.
- `core/sketch/interp.ts` - cooperative tree-walking interpreter. Generator yields
  `{kind:'delay',us}` on delay/delayMicroseconds (host suspends + resumes) and
  `{kind:'tick'}` in loops (host can stop/repaint). C semantics: truncating int div,
  C modulo, &&/|| short-circuit, static locals (per-function cells), arrays by
  reference, assignment keeps destination type (int cells truncate), const guard,
  bounds-checked arrays, recursion depth 120. Values: tagged number/str/array cells;
  host boundary is plain JS (HostValue).

## Key architecture decisions

- Sketch execution = interpreter, NOT CPU emulation (see ARCHITECTURE.md).
- Generator-based coroutine => deterministic tests (drive() helper) + real-time GUI.
- Storage = mutable Val cells; assignments copy INTO destination => no accidental
  aliasing; arrays intentionally alias when passed (pointer semantics).
- Board pins: silk label is the sketch-visible name; GPIO is the electrical identity.

## Next step (Phase 3)

1. `peripherals/gpio.ts` - GpioBus: mode (INPUT/OUTPUT/INPUT_PULLUP), output latch,
   external drivers from the circuit, effective level + conflicts, PWM duty, GPIO16
   open-drain rule. Syncs with GpioRegisters.
2. `peripherals/netlist.ts` - wires as nets (union-find), component pin connectivity,
   settle/propagate pass, driver/receiver callbacks.
3. `peripherals/components.ts` - LED (with series-resistor current model), button,
   dip switch, resistor, breadboard-ish rules.
4. `core/machine.ts` - Esp8266Machine = clock + registers + gpio + serial + interpreter
   + Arduino API (pinMode/digital*/analogWrite/delay/millis/map/constrain/Serial.*),
   run/stop/reset, onPinChange events, timer0 alarm host functions.
