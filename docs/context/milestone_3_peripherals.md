# Milestone 3 - peryferia i maszyna (faza 3)

Data: 2026-02-19. Stan: komplet testów zielony (158 testów, 10 plików), `tsc --noEmit` czysty.

## Co powstało

### `peripherals/gpio.ts` - GpioBus (17 testów)
Elektryczny stan 17 pinów GPIO: tryby INPUT/OUTPUT/INPUT_PULLUP, latch wyjścia,
słabe pull-up 30k, open-drain na GPIO16 (HIGH = tylko pull-up), `analogWrite`
0-1023 z auto-przełączeniem w OUTPUT (read wraca HIGH przy duty>=512),
`setExternalDriver(gpio, 'high'|'low'|'none')` jako wejście z netlista,
`conflict()` wykrywa zwarcia wyjść, `onPinChange((gpio, snap))` dla GUI,
`snapshot()`/`reset()`.

### `peripherals/netlist.ts` - Netlist (13 testów)
Solver rysowanego obwodu (model "digital-ish", nie SPICE):
- pruwy/wires/zamknięte przyciski = łącza 0Ω; rezystory przewodzą z R;
- Dijkstra `reachSources` od każdego terminala do źródeł (rail 3V3/5V, GPIO push);
- LED = terminal z Vf: prąd (Vsrc-Vsink-Vf)/R, ON >0.05mA, wypalony przy R=0 lub >50mA,
  jasność min(1, I/20mA) - sterowana też duty PWM (analogWrite);
- `resolve()` zwraca `ResolveResult { leds, pinLevels, externals, faults, netOf, netVoltage }`;
- `pinLevels` = pełny widok pinu (mocny sterownik, else własne pull-up) dla GUI;
- `externals` = TYLKO obce mocne sterowniki - karmią `GpioBus.setExternalDriver`,
  więc pin nigdy nie napędza samego siebie przez tę ścieżkę;
- błędy: `short` (rail vs GND bez R) i `contention` (dwa pin MCU w walce).

### `core/machine.ts` - Esp8266Machine (~18 testów)
Facade dla GUI: `new Esp8266Machine({ board })`, `load(src)`, `run()` (cold start:
clock.restart + registers.reset + gpio.reset + świeży Interpreter; setup() dopalany
synchronicznie przez `clock.advance(10)`), `stop()`, `reset()`, `advance(ms)`
(pasywne - nic nie tyka bez klienta), `timeMs`, `serial: {tMs,text}[]` + `onSerial`,
`onCircuit`, `circuit()`, `pinLevel`, `pwm`, `press(switchId, closed)`.
API Arduino: pinMode/digitalWrite (przez rejestry W1TS/W1TC jak prawdziwy firmware)/
digitalRead/analogWrite/delay/delayMicroseconds/yield/map/constrain/abs/min/max/sq/
sqrt/pow/sin/cos/String, Serial.begin/print/println/printf(%d %s %f z precyzją %.-Nf,
%x %b %c)/write/available/read, timerAlarmWrite/Enable/Disable,
stałe HIGH..D8 z tablicy boardu, LED_BUILTIN=2.

## Model CPU (kluczowe decyzje)
- Dwa korutyny: `mainGen` (setup/loop) i jeden `isrGen` (timer0/1ISR), każda ma
  WŁASNĄ task-wake w zegarze (cpuTask/isrTask) - wake delay() i alarm nigdy nie
  walczą o ten sam slot (stale-wake guard porównuje id taska).
- ISR startuje gdy main siedzi w delay() (`mainSuspended`) - **interrupte
  kooperacyjne**, udokumentowane odstępstwo: prawdziwy ESP8266 preempuje wszędzie.
  Kompromat: bez wywłaszczania interpreter pozostaje prosty i deterministyczny.
- Slice budget PUMP_SLICE=5000 yieldów na przebudzenie + kwant 1us między
  przebiegami loop() - delay-free loop() nie zatka zegara (i tak dostanie
  Clock-runaway po 100k fire'ów, co jest uczciwą symulacją zapętlonego firmware).
- `run()` drynuje setup synchronicznie przez `clock.advance(10)` - GUI dostaje
  natychmiastowy efekt Start bez łamania pasywności zegara.

## Pułapki, w które wpadłem (do pamięci)
1. `Clock.advanceTo(now)` z guardem `target <= now` NIE odpala tasków due==now
   -> osobne `Clock.drain()` (ogień due<=now bez ruchu czasu) + testy.
2. Kwant 1us przesuwa wake na now+1 - `drain()` ich nie widzi; run() używa
   `clock.advance(10)` zamiast drain.
3. Zimny start bez `registers.reset()`: stary bit OUT zostaje, zapis HIGH w W1TS
   nie generuje change-listenera, magistrala stoi w LOW. reset() obiektów musi
   objąć WSZYSTKIE warstwy stanu.
4. `String(x)` jako host-funkcja - konstruktor C++ to zwykłe wywołanie.
5. printf: `%.2f` wymaga grupy precyzji `(?:\\.(\d+))?` w regexie formatu.

## Interfejs wyjściowy dla GUI (fazy 4-7)
- `machine.advance(dtMs)` z rAF (wall-time * speed), `onCircuit` -> świeże
  `ResolveResult` (LED-y, poziomy pinów, zwarte zwarcia) do renderowania,
- `onSerial` -> Serial Monitor, `gpio.onPinChange` ewentualnie do podświetleń,
- `netlist.addComponent/addWire` z palette drag&drop, `press()` z wirtualnych
  przycisków.

## Następny krok (faza 4)
`gui/canvas/` - silnik płótna: transform (pan/zoom), siatka, renderer warstw,
hit-testing; testy części czystych (matematyka transformacji, siatka, trafienia)
bez DOM.
