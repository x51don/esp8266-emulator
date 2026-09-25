# ESP8266 Visual Emulator (Wemos D1 mini / NodeMCU)

Browser-based emulator for the ESP8266 as used on Wemos D1 mini and NodeMCU v3
boards: drag-and-drop circuit canvas, live wiring, Arduino-sketch editor with
syntax highlighting, virtual Serial Monitor and a real-time simulation engine
(virtual clock, GPIO/PWM, pull-ups, LED currents, short/burnout detection).
Sketches get a working slice of the ESP8266 world: Wi-Fi association timing,
TCP-less but faithful HTTP server/client between chips, mDNS names, a 4 KB
EEPROM that survives reboots and page reloads, NTP time and `ESP.deepSleep` -
and the bench can hold **several ESP8266 devices on one virtual LAN** at once.

## Run

```bash
pnpm install
pnpm run dev      # http://127.0.0.1:5188
```

Production build: `pnpm run build` -> static files in `dist/` (serve with any
static server). Tests: `pnpm test` (Vitest). Browser E2E (needs `pnpm run build`
+ a static server on :8090 and system Chromium): `node scripts/verify.mjs` ..
`verify9.mjs` (each prints PASS/FAIL lines; `verify8` runs the two-device LAN
bench, `verify9` the project autosave round-trip).

Two examples (`roleta_LoLin_v20.ino`, `roleta_LoLin_WeMos_v19.7.6_k1_sm.ino`)
are **copies** of firmware that lives outside this repo. `npm run sync:examples`
refreshes them and records the hashes in `examples/sync-manifest.json`;
`pretest` runs `npm run check:examples` first, so the suite refuses to go green
against a stale copy (a test that passes on old firmware proves nothing).

## Using it

1. **Build the circuit** - drag components from the left palette onto the
   canvas: board, LED (symbol ships with its series resistor, pre-wired),
   resistor, capacitor, button, buzzer, battery, plus the ESPHome-style part
   library: **potentiometer, LDR, DHT11/22, SG90 servo, relay (NO/NC), SSD1306
   OLED, WS2812 NeoPixel strip, HC-SR04 ultrasonic ranger**, plus discrete
   semiconductors: **1N4148 diode, Zener diode (dbl-click sets Vz), BC547 NPN
   and BC557 PNP transistors, IRL540N logic-level MOSFET** (base/gate-driven
   switches, a documented approximation - not SPICE). The palette is grouped by function
   (Board, Power, Semiconductors, Passive, Outputs, Inputs, Displays).
   Preset examples drop these already wired to the right pins.
2. **Wire pins** - press on a pin dot and drag to another pin. Wires are
   orthogonal and route *around* component bodies and the board (an A\*
   fallback guarantees a body-free path even in tight corridors). **Drag a
   wire segment sideways** to pin a manual route; **Alt+click** a wire
   restores auto-routing. Wires that cross without being connected get a hop
   at the crossing point; wires that meet on one net get a solder dot.
   **Right-click a wire** to colour it from a 12-colour palette; by default
   wires paint themselves by net role - power rails red, GND white, signal
   nets green (the automatic mode is one click back).
   The banner also warns about bad practice, e.g. a transistor base tied
   straight to a GPIO with no ~1k series resistor (a MOSFET gate is fine
   direct).
   Double-click a wire to delete it; `Del` removes selected components (with
   connected wires) after a confirm. **Double-click a component** to open its
   properties dialog (resistance, capacitance, LED forward voltage, battery
   volts, NeoPixel count, OLED address, board model, ...); edits apply live,
   also while running. With a selection: `H` mirrors the component
   horizontally (diode direction and friends), `P` opens its properties. `R` rotates, shift-click multi-selects, wheel zooms,
   dragging empty space pans. Deleted the board? Drop a new one from the top of
   the palette (*Board*).
3. **Write the sketch** - Arduino subset in the editor: `setup()/loop()`,
   `pinMode/digitalWrite/digitalRead/analogWrite`, `delay/delayMicroseconds`.
   The panel header carries **`↓ .ino`** (download the active sketch as
   `<device-name>.ino`) and **`↑ .ino`** (load a `.ino`/`.txt` file into the
   active device), so real Arduino files round-trip with the emulator:
   `Serial.begin/print/println/printf/write`, `millis/micros`,
   `timerAlarmWrite/timerAlarmEnable` (cooperative ISRs), `String/map/min/max...`
   - and the part-library API (plain C-style functions, no classes):
   `analogRead(A0)`, `dhtSetup/dhtReadTemperature/dhtReadHumidity`,
   `hcsrSetup/hcsrDistanceCm/hcsrPulseUs`, `servoAttach/servoWrite/servoRead`,
   `oledBegin/oledClear/oledPrint/oledShow`, `npSetup/npPixel/npShow`.
   Sensors are found by wiring: the call matches the component of that type
   whose data pin sits on the same net as the board pin passed in
   (`dhtReadTemperature(D4)` reads the DHT wired to D4); unwired reads return
   `-999` (DHT) or behave like a floating pin.
   **Auto-wire** (toolbar) reads the open sketch and rebuilds the canvas from
   it: `digitalWrite/analogWrite` pins become resistor-fed LEDs,
   `digitalRead` pins become buttons, `analogRead` a pot on A0, and the
   peripheral APIs (`dhtRead*`, `servoAttach`, `npSetup`, `oled*`,
   `hcsrSetup`) drop their modules on the pins they name - including
   `#define`/`const` aliases and bare GPIO numbers.
   *Examples* loads a sketch **with a matching wired circuit preset** (blink,
   pwm-fade, button, serial-hello, pot-serial, ldr-led, dht-oled, servo-pot,
   neopixel-chase, hcsr-serial, relay-pump, web-server, lan-server, lan-client);
   it asks before replacing your work.
   The ESP8266 API works too: `WiFi.begin/localIP/config` (a static lease
   really moves the chip, `WiFi.config(IPAddress(...), ...)`),
   `ESP8266WebServer` (exact Arduino routing: `server.on("/led", ...)` +
   `server.arg`), `HTTPClient` (`begin/GET/POST/getString`, the response comes
   from the target chip's own clock), `MDNS.begin("name")` (names resolve in
   every other chip and in the HTTP panel), `EEPROM.begin/read/write/commit`
   (4 KB, kept across reboots and saved with the project), `configTime/
   localTime/hour/...` (NTP locks 0.5 s after `configTime`, `now()` follows the
   virtual clock), `setTime` TimeLib mode, `ESP.restart/deepSleep`.
4. **Run** - the toolbar Run loads the sketch and cold-starts the virtual chip.
   Wires and pin dots light up yellow on HIGH; LEDs glow (and burn out when
   wired without a resistor). While running, click a button to hold it and
   **drag pot / LDR / DHT / HC-SR04 bodies to change their values live**
   (pot: wiper, LDR: 10 lx..100 klx, DHT: temp sideways + humidity up/down,
   HC-SR04: target distance). Servo arms, the OLED panel and NeoPixel leds
   animate from the machine state; the relay contact arm follows its coil. Stop freezes; Reset
   is a cold chip reset. Faults (shorts, bus contention, burnt LEDs) appear in
   the toolbar banner.
   Under the editor the dock has three tabs: **Serial**, **HTTP** and
   **Variables**. Variables lists the sketch's globals live - name, type as
   written, current value - and the row lights up on the poll it changed.
   Everything shows by default; **hide** takes one out, the checkbox in the
   panel header lists what is hidden and **show** puts it back at the end,
   arrows (or dragging a row) set the order, **reset** returns declaration
   order with nothing hidden. The layout is per-bench, stored with the rest
   of the state, and follows the sketch: a global the sketch gained joins at
   the end, one it lost disappears.
5. **Two chips, one LAN** - the device bar under the toolbar is the bench:
   `+` adds a second ESP8266 (`esp-2 .43`, `esp-3` ...), each chip keeps its
   **own sketch, flash and serial log**; click a chip to drive it. Chips talk
   over the LAN registry exactly like over WiFi: `HTTPClient` pumps the target
   machine, so a request from `esp-2` to `http://serwer.local/ID` is served by
   `esp-1` even while its tab-side Run is paused. The HTTP panel fetches any
   host on the LAN, not just the active chip. Try `lan-server.ino` +
   `lan-client.ino` to see it working.
6. **Save & share** - *Save* stores the whole bench (every device's sketch +
   flash, the circuit, the board) under a name in the browser (Projects… to
   reload, Manage… to delete); an EEPROM commit in a running chip **autosaves**
   the open project, so a boot counter survives a page reload;
   *Export* downloads it as a single JSON file, *Import* loads such a file
   back (older single-device projects load fine and become one-chip benches).
   Everything also autosaves to localStorage. `window.__emu` exposes the live
   model (schematic, machine, `setSketch`, `devices`, `addDevice`,
   `switchDevice`, `variables`, `wirePath`) for console debugging and browser
   automation.

## How it simulates

No Xtensa machine code here: sketches run on a tree-walking interpreter for a
documented Arduino-C++ subset, executed cooperatively as JS generators against
virtual hardware (register file -> GPIO bus -> circuit solver), all driven by a
microsecond virtual clock. `docs/context/ARCHITECTURE.md` records the decisions;
`docs/context/milestone_*.md` the build journal.

### Known limitations (documented deviations)

- Sketch language = subset of Arduino-C++ (no classes, pointers, structs,
  templates; blocking calls are cooperatively scheduled).
- Arrays are sized by the declaration, like C: `int buf[40] = {0}` is 40
  elements and the tail past the last initializer is filled in (`String`
  arrays pad with `""`, `char t[8] = "abc"` stores bytes plus a NUL). Only too
  many initializers is an error, and it surfaces at run time - there is no
  compile step to report it in.
- Timer ISRs are cooperative: they run between `loop()` slices, never
  preempting it. They are also permissive: `delay()`, `millis()` and even an
  HTTP call inside a handler run like main-line code and spend virtual time,
  where a real ISR would hang or reset the chip.
- A `loop()` without any `delay()` spins the scheduler guard, mirroring a real
  CPU hogging the watchdog.
- Circuit model is logic-level with LED current limits and pull-ups; analog
  inputs use an ideal Thevenin divider (pot = ideal 10k tap, LDR = CdS curve),
  A0 is the only analog input (0..1023). A pin nothing drives reads 0: no
  floating-node drift and no last-bit jitter.
- The interpreter stops a call chain at 120 frames (`MAX_CALL_DEPTH`) and
  reports it as a sketch error; hardware overflows its stack at a depth that
  depends on the frame, and a deep-enough recursion there is a crash, not a
  message.
- `Adafruit_NeoPixel.show()` is instant. Real WS2812 timing is ~30 us per bit,
  so a 30-led refresh costs about a millisecond per frame on hardware and
  nothing here.
- The part API is C-style (`dhtReadTemperature(D4)`), not library classes -
  the sketch language has no objects.
- OLED renders an 8x21 text grid (what SSD1306 Arduino sketches display),
  not a 128x64 pixel framebuffer.
- Relay contacts are ideal switches; the coil loads the driving pin with
  150 ohms like a real 5V module.
- Capacitors are ideal open circuits at logic level (no charge/discharge
  curve - the solver is DC); they place, wire and label (uF/mF) normally.
- The virtual LAN is in-process: a healthy link is instant (no wire latency,
  no packet loss, ports are implicit per chip), HTTPS and WebSockets are not
  modeled. `MDNS.begin` registers a name in that registry - resolution is
  instant and local. One peer's link can be degraded on purpose with
  `setPeerLatency(host, ms)` (round trip the client blocks),
  `setPeerUnreachable(host)` (frames go nowhere; the client burns its whole
  `setTimeout()` and then fails) and `setPeerDown(host)` (connection refused,
  fails at once); `clearImpairments(host)` heals it. The stall is charged to
  the caller's own clock, so `millis()` arithmetic in the sketch sees it.
  A host that was never registered still fails immediately rather than
  hanging to the timeout like real hardware - use `setPeerUnreachable` for
  that case.
  Each chip owns its clock: a machine ages when the harness advances it or
  when another machine blocks on it, and by nothing else. Peers the harness
  does not tick fall behind on purpose (an unreachable one keeps running - it
  is deaf, not off); `tests/multi-machine.test.ts` is the reference bench that
  pins this down for four machines at once.
- Association is a fixed 1.5 s and there is no signal model (no RSSI, no
  scan, no wrong-password network), but the access point can be taken away:
  `setWifiDown(true)` drops the link at once - `isConnected()`/`status()`/
  `localIP()` go dead, a soft-AP stops existing, and the chip answers nobody
  over the LAN - while a join already in flight stops making progress.
  `WiFi.waitForConnectResult(t)` polls and returns `WL_DISCONNECTED` when its
  own timeout runs out, so a recovery loop costs virtual time instead of
  wedging the interpreter. Handing the AP back costs a fresh association
  (1.5 s) or AP bring-up (300 ms). The outage is an environment condition,
  not chip state: it survives `run()` and `ESP.restart()`.
- `millis()` and `micros()` are uint32 and roll over (49.7 days and 71.6
  minutes), and a declared integer type keeps its hardware width: `byte`
  wraps at 256, `word` at 65536, `char` is signed, `unsigned long` holds
  4294967295, and arithmetic with an unsigned operand wraps unsigned - which
  is what makes `millis() - previous >= interval` survive the rollover while
  `millis() >= previous + interval` does not. The virtual clock itself stays
  a plain µs counter; only the sketch sees the wrap. `setUptimeUs(us)` boots
  the chip near the boundary so a test does not wait 49.7 days; it is a
  harness setting and survives `run()`/`reset()`. `long long` is not 64-bit.
- An impossible pin state is simulated as written until a probe says
  otherwise: `addPinInvariant({ never: [['D5', 1], ['D6', 1]], label })`
  states the combination that must never happen (never both windings ON). The
  machine evaluates it on every `digitalWrite` and every `advance()` step, so
  it does not matter whether the sketch, an ISR or the circuit moved the pin.
  Hits land in `invariantViolations` as `{ tMs, label, pins }` - one entry per
  episode, cleared by a reboot - and count up in the toolbar;
  `invariantStrict = true` throws instead of logging. Probes come from a test
  or the `__emu` console, there is no dialog for them.
- The Variables tab watches **globals only**. A function's locals and its
  `static` locals live in the call frame that owns them and are gone between
  calls, so there is nothing to list while the sketch is parked in another
  function; the same goes for a value held behind a pointer. Arrays report
  their first 16 elements plus a `+N` count, and a library object reports its
  class (`HTTPClient`), not its internals. Values are read between steps, so
  a row shows the last committed value, never one torn out of the middle of
  an expression.
- EEPROM is a 4096-byte array behind a volatile mirror: `begin()` reloads the
  flash, `write()` dirties the mirror, only `commit()` spends one erase/write
  of the sector, and past 100000 cycles the sector stops persisting anything
  (`eepromStats()`, `eepromSetCycles()`). There is no wear leveling and no
  page-size error. `commit()` without `begin()` writes and reports success;
  the core returns false there. A commit still drives the project autosave.
- `configTime` locks to the **wall-clock** epoch plus virtual time since
  lock; `ESP.deepSleep(us)` is a delayed cold reboot (wake runs `setup()`
  from a cleared serial, flash kept, no power-current model).
- An inactive device's main loop is paused (its clock only advances when the
  GUI pumps it or a peer's request lands) - Run applies to the active chip.

## Layout

```
core/          clock, registers, machine facade, boards, sketch interpreter
peripherals/   GPIO bus, circuit netlist solver
gui/           React app: canvas engine, components, sim driver
scripts/       verify.mjs .. verify10.mjs (headless-CDP E2E, ports 933x), demo.mjs
examples/      blink, pwm-fade, button, serial-hello, pot-serial, ldr-led,
               dht-oled, servo-pot, neopixel-chase, hcsr-serial, relay-pump,
               web-server, lan-server, lan-client
tests/         Vitest suites, one per logic module
docs/context/  architecture + milestone journals
```
