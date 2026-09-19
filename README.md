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

## Using it

1. **Build the circuit** - drag components from the left palette onto the
   canvas: board, LED (symbol ships with its series resistor, pre-wired),
   resistor, capacitor, button, buzzer, battery, plus the ESPHome-style part
   library: **potentiometer, LDR, DHT11/22, SG90 servo, relay (NO/NC), SSD1306
   OLED, WS2812 NeoPixel strip, HC-SR04 ultrasonic ranger**. The palette is
   grouped by function (Board, Power, Passive, Outputs, Inputs, Displays).
   Preset examples drop these already wired to the right pins.
2. **Wire pins** - press on a pin dot and drag to another pin. Wires are
   orthogonal and route *around* component bodies and the board (an A\*
   fallback guarantees a body-free path even in tight corridors). **Drag a
   wire segment sideways** to pin a manual route; **Alt+click** a wire
   restores auto-routing. Wires that cross without being connected get a hop
   at the crossing point; wires that meet on one net get a solder dot.
   Double-click a wire to delete it; `Del` removes selected components (with
   connected wires) after a confirm. **Double-click a component** to open its
   properties dialog (resistance, capacitance, LED forward voltage, battery
   volts, NeoPixel count, OLED address, board model, ...); edits apply live,
   also while running. With a selection: `H` mirrors the component
   horizontally (diode direction and friends), `P` opens its properties. `R` rotates, shift-click multi-selects, wheel zooms,
   dragging empty space pans. Deleted the board? Drop a new one from the top of
   the palette (*Board*).
3. **Write the sketch** - Arduino subset in the editor: `setup()/loop()`,
   `pinMode/digitalWrite/digitalRead/analogWrite`, `delay/delayMicroseconds`,
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
   `switchDevice`, `wirePath`) for console debugging and browser automation.

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
- Circuit model is logic-level with LED current limits and pull-ups; analog
  inputs use an ideal Thevenin divider (pot = ideal 10k tap, LDR = CdS curve),
  A0 is the only analog input (0..1023).
- The part API is C-style (`dhtReadTemperature(D4)`), not library classes -
  the sketch language has no objects.
- OLED renders an 8x21 text grid (what SSD1306 Arduino sketches display),
  not a 128x64 pixel framebuffer.
- Relay contacts are ideal switches; the coil loads the driving pin with
  150 ohms like a real 5V module.
- Capacitors are ideal open circuits at logic level (no charge/discharge
  curve - the solver is DC); they place, wire and label (uF/mF) normally.
- The virtual LAN is in-process: requests are delivered instantly (no wire
  latency, no packet loss, ports are implicit per chip), HTTPS and WebSockets
  are not modeled. `MDNS.begin` registers a name in that registry - resolution
  is instant and local.
- EEPROM is a 4096-byte byte array (no wear leveling, no page-size errors);
  `commit()` marks it dirty, which drives the project autosave.
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
