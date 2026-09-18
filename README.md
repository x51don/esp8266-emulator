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
+ a static server on :8090 and system Chromium): `node scripts/verify.mjs` and
`node scripts/verify2.mjs`.

## Using it

1. **Build the circuit** - drag components from the left palette onto the
   canvas: board, LED (symbol ships with its series resistor, pre-wired),
   resistor, button, buzzer, battery, plus the ESPHome-style part library:
   **potentiometer, LDR, DHT11/22, SG90 servo, relay (NO/NC), SSD1306 OLED,
   WS2812 NeoPixel strip, HC-SR04 ultrasonic ranger**. Preset examples drop
   these already wired to the right pins.
2. **Wire pins** - press on a pin dot and drag to another pin. Wires are
   orthogonal and route *around* component bodies and the board. Double-click a
   wire to delete it; `Del` removes selected components (with connected wires)
   after a confirm. `R` rotates, shift-click multi-selects, wheel zooms,
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
   neopixel-chase, hcsr-serial, relay-pump); it asks before replacing your work.
4. **Run** - the toolbar Run loads the sketch and cold-starts the virtual chip.
   Wires and pin dots light up yellow on HIGH; LEDs glow (and burn out when
   wired without a resistor). While running, click a button to hold it and
   **drag pot / LDR / DHT / HC-SR04 bodies to change their values live**
   (pot: wiper, LDR: 10 lx..100 klx, DHT: temp sideways + humidity up/down,
   HC-SR04: target distance). Servo arms, the OLED panel and NeoPixel leds
   animate from the machine state; the relay contact arm follows its coil. Stop freezes; Reset
   is a cold chip reset. Faults (shorts, bus contention, burnt LEDs) appear in
   the toolbar banner.
5. **Save & share** - *Save* stores the whole project (sketch + circuit +
   board) under a name in the browser (Projects… to reload, Manage… to delete);
   *Export* downloads it as a single JSON file, *Import* loads such a file
   back. Everything also autosaves to localStorage. `window.__emu` exposes the
   live model (schematic, machine, `loadExample`, `wirePath`) for console
   debugging and browser automation.

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

## Layout

```
core/          clock, registers, machine facade, boards, sketch interpreter
peripherals/   GPIO bus, circuit netlist solver
gui/           React app: canvas engine, components, sim driver
scripts/       verify.mjs + verify2.mjs + verify3.mjs (headless-CDP E2E), demo.mjs
examples/      blink, pwm-fade, button, serial-hello, pot-serial, ldr-led,
               dht-oled, servo-pot, neopixel-chase, hcsr-serial, relay-pump
tests/         Vitest suites, one per logic module
docs/context/  architecture + milestone journals
```
