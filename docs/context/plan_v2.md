# Plan V2 - mapa drogowa refactoru (2026-09-18)

Zasady: **bezwzględny zakaz przepisowania od zera** - operujemy na istniejących
modułach, każdy punkt = test red-green + aktualizacja `docs/context/` + pełna
suite zielona przed następnym punktem. Priorytety wg hierarchii z zadania:
P0 blokery, P1 wydajność renderu, P2 interfejs, P3 nowe funkcje.
ID (`B4`, `P1`, ...) wskazują na `audit_v1.md`.

## P0 - Blokery i błędy krytyczne (stabilność pętli zdarzeń, emulacja rejestrów)

Kolejność podpunktów = kolejność implementacji (każdy osobny red-green).

1. **P0.1 Izolacja pętli zdarzeń i maszyn-faulted** (B1, B2, B3)
   - `machine.advance()`: `try/catch` wokół `clock.advance`; każdy wyjątek ->
     `halt()`, faza `'faulted'`, `faultReason`, powiadomienie `onFault(cb)`;
     `advance()` nigdy nie rzuca. `run()` zachowuje rzucanie (caller `onRun`
     obstawiony).
   - `SimDriver`: po `machine.phase()==='faulted'` sam się zatrzymuje.
   - `SchematicCanvas.frame()`: `try/catch` wokół drivera I renderScene;
     re-arm rAF w `finally`; błąd renderu = konsola + ominięcie klatki;
     fault maszyny = callback do App (banner + `setRunning(false)`).
   - `App`: `onFault` -> `setError(...)`; `onExample`/`onImport` z `setError`;
     wrapper `safeStorage()` dla `setItem` (Quota -> banner).
   - Testy: `tests/resilience.test.ts` - runtime error w `loop()` nie rzuca z
     `advance()`, faza `faulted`, kolejne `advance()` nie rzucają; szkic-pętla
     z `advance()` zwraca w budżecie czasu; driver zatrzymuje się na fault.
2. **P0.2 GPIO16 / D0** (B4)
   - `GpioRegisters`: równoległy 1-bitowy blok OUT16 (udokumentowane: na
     prawdziwym chipie poza blokiem GPIO_OUT) + diff-listener z bitem16 w masce;
     `reset()` czyści oba bloki.
   - `machine.env.digitalWrite/digitalRead` przez nowy path; `syncOut`
     obsługuje bit16; `sampleIn(mask|1<<16)`.
   - Testy: `registers.test.ts` (bit16 diff, reset), `machine.test.ts`
     (D0 HIGH/LOW na magistrali, open-drain HIGH = weak-high przez bus).
3. **P0.3 Budżet CPU na wywołanie `advance()`** (B5, B6)
   - Budżet yieldów liczony **per `advance()`** (stała `FRAME_YIELD_BUDGET`,
     domyślnie 20 000; `run()` dostaje hojny `SETUP_YIELD_BUDGET`): wyczerpanie
     = `scheduleWake(0)` i powrót sterów do wołającego. Budżet licznika
     globalnego maszyny, nie per wake.
   - Konsekwencja: symulacja zwalnia względem czasu rzeczywistego zamiast
     zamrażać UI (udokumentować: interpreter to "prędkość chipa").
   - `evalPure`: ten sam limit kroków rzuca `SketchRuntimeError('loop inside
     an expression exceeded the step budget', line)` zamiast kręcić wiecznie.
   - Testy: `advance(20)` gorącej pętli < 250 ms real i `timeMs()` poszło o
     ~20 ms; po 100 `advance()` serial szkicu nadąża (pętla żyje);
     `arr[f()]` z `while(true)` w `f()` -> throw z numerem linii, `run()`
     zgłasza błąd (path `onRun`), nie wiesza.
4. **P0.4 Walidacja importu dokumentu i stanu startowego** (B8, B9)
   - `schematic.ts`: eksport `SCHEMATIC_TYPES`; `fromJSON` weryfikuje typy
     pól i `type` (rzut `Error('unknown component type ...')`); renderer i
     hit-test już nie widzą śmieci.
   - `App.tsx`: `boardId` z localStorage sprawdzany po `listBoards()`,
     fallback + `console.warn`; `loadSchematic` łapie też błąd walidacji.
   - Testy: `schematic.test.ts` (odrzucony typ, zły kształt), nowe
     `tests/app-boot.test.ts` tylko tam gdzie da się bez DOM (fabryka
     `resolveBoardId(saved)`).
5. **P0.5 Spójność mutacji dokumentu** (B7, H3)
   - `setParam` woła `touch()`; `Schematic.setBoard(id)` (walidacja + touch);
     `App.tsx` używa mutatorów zamiast bezpośrednich zapisów w efekcie;
     `ComponentDialog` apply przez `setBoard`.
   - Test: zmiana `count` neopixela/uniform boarda unieważnia cache
     `wireRoutes()` (test porównuje pinWorld przed/po bez innych mutacji).
6. **P0.6 Higiena resetu, seriala i raili** (B10, B11, L1, L2, L3)
   - `machine.reset()` -> `registers.reset()` + `printBuf=''`;
     `serialLog` cap 5000 (drop-oldest, licznik `droppedLines`);
     `onSerial/onCircuit/gpio.onPinChange` zwracają unsubscribe;
     listener `window.pointerup` sprzątany przy unmount; `__emu` usuwany
     w cleanupie.
   - `boards.ts`: NodeMCU right = A0, D9, D10, 3V3, GND, D8..D5, NC, VU
     (unikalne silk; D9/D10 pozostają gpio:null - flash).
   - Testy: cap seriala, reset czyści rejestry (bit D4 po Resecie), brak
     duplikatów nazw raili w boardach (test przez listBoards).

## P1 - Wydajność renderu (redukcja przerysowań)

7. **P1.1 `resolve()` na sygnale, nie co klatkę** (P1): wersja obwodu =
   licznik mutacji GpioBus (drive-state) + wersja netlisty (comps/wires/switch)
   ; `advance()` re-solve'uje tylko gdy wersja wzrosła. Sonda celu: pusta
   scena i scena 301-el. -> < 0,2 ms/klatkę w stanie ustalonym.
8. **P1.2 Tani drag** (P2): `bodyRects` liczone raz na przebudowę tras
   (parametr `wireObstacles` z puli), przecięcia liczone przy commit
   (pointerup) a w trakcie dragu rysowane z ostatniego commita; A* tylko
   przy realnym przebitciu (jest) + limit węzłów.
9. **P1.3 Statyczny kadr** (P3): offscreen canvas dla siatki (key: zoom,
   pan, rozmiar); pełne `renderScene` tylko gdy: brudny dokument, interakcja,
   albo maszyna bierze klatkę. Idle+stop = 0 kosztu CPU.
10. **P1.4 SerialMonitor**: klucze po id linii, okno ostatnich 500 linii,
    wirtualizacja zbędna przy oknie.

## P2 - Rozbudowa interfejsu (routing, czytelność D&D)

11. Przewód podświetlany przy hoverze (ten sam hit-test co klik), kropki
    złącza tylko dla wspólnego netu (jest) + usuwanie przez Del przy
    zaznaczeniu drutu, widoczny ghost/przyciąganie przy drag&drop z palety,
    MIME palety jako wspólna stała (H1), kursor-pin pod kursorem.
12. Presety: `hcsr` przez `h.id` (H2), stałe layoutu presetów współdzielone
    z footprintem (H1), preset load przez walidację P0.4 z bannerr.

## P3 - Nowe funkcje i peryferia

13. ADC: suwak napięcia A0 w UI (pinLevel już liczy węzeł - dodać edytor
    wymuszenia), `attachInterrupt` (change/falling) na GPIO, WiFi mock
    (Serial-only dashboard), kondensator z krzywą ładowania (model RC),
    OLED framebuffer 128x64. Kolejność wg zgłoszeń użytkownika.

## Rygory

- Każdy punkt: test red-first, potem fix; suite pełna (277+ oraz tsc) przed
  zamknięciem; po każdym punkcie aktualizacja tego pliku (checkbox + status)
  i wpis do `milestone_11_v2_hardening.md`.
- Nie ruszamy modelu pasywnego zegara ani API `Esp8266Machine` publicznego
  (E2E przez `__emu` musi przechodzić bez zmian ścieżek).

## Status realizacji

- [x] P0.1 - izolacja pętli zdarzeń (machine.phase 'faulted' + onFault, advance() bez wyjątków, rAF w dwóch blokach try/catch, SimDriver staje na fault; 7 testów w tests/resilience.test.ts)
- [x] P0.2 - GPIO16/D0 jako 17-ty bit wewnętrzny (MASK17 w registers.ts, wierne 16-bitowe read(), outState()/enableState(); 8 testów)
- [x] P0.3 - budżet yield interpretera na advance() (FRAME_YIELD_BUDGET 20k, SETUP 400k, guard pętli bez delay w evalPure; hot loop: 32 s/frame -> ~7 ms/frame; 5 testów)
- [x] P0.4 - walidacja Schematic.fromJSON (typy/kształty pól, nieznany board; 5 testów) + walidacja boardId z localStorage (App.resolveBoardId)
- [x] P0.5 - spójność mutacji dokumentu (setParam zawsze touch(), nowe Schematic.setBoard, App używa mutatora; 2 testy)
- [x] P0.6 - higiena resetu i wycieków (reset czyści rejestry/printBuf/alarms, limit serialLog 5000 + droppedLines, onSerial/onCircuit/onPinChange z unsubscribe, pointerup i __emu sprzątane przy unmount, unikalne silki NodeMCU; 5 testów)
- [x] P1.1 - resolve() na sygnale (gpio.version/netlist.version, cache w machine; stan ustalony 301 el: 9,5 ms -> 0,013 ms/klatkę; 4 testy)
- [x] P1.2 - tani drag (beginDrag/endDrag + indeks siatkowy, okno A*, wąskie pasy kandydatów, TOP-24 detour; stress 300 drutów: 9,5 s/mousemove -> 0,001 ms ruch + 8,9 s commit; typowy 30-drutowy commit ~30 ms; 3 testy)
- [x] P1.3 - statyczny kadr (Schematic.version, offscreen siatka, renderScene tylko przy zmianie sygnatury albo running; idle+stop = 0 renderów)
- [x] P1.4 - SerialMonitor: id w SerialLine + klucze po id, okno 500 linii (wcześniej index-key i okno 2000)
- [x] P2.11 - hover drutu (halo + kursor pointer + Del), ghost z palety ze snapem, MIME jako stała `gui/dnd.ts`
- [x] P2.12 - preset hcsr przez `h.id` (H2), stałe `BOARD_RIGHT_X/BOARD_PITCH` współdzielone (H1), ścieżki presetów już przeszły walidację P0.4 + baner (sprawdzone); testy gwaranta + `scripts/verify4.mjs` (6 checków E2E, w tym idle+stop = 0 stroke'ów)
- [x] P3.1 - suwak A0: `Netlist.pinForce` (słabe źródło 10k przeżywające clear), `machine.setAnalogForce`, dok `AdcDock` na kanwie; 5 testów + 2 checky E2E
- [x] P3.2 - `attachInterrupt`/`detachInterrupt` (CHANGE/FALLING/RISING) na lane ISR; nazwa ISR przechodzi przez interp jako 'fn-to-pointer'
- [x] P3.3 - WiFi mock: stan radia (join 1,5 s), `WiFiClient`/`WiFiServer` jako obiekty deklarowane, ruch TCP → Serial z prefiksem `[net->host:port]`
- [x] P3.4 - kondensator: relaksacja RC (`Netlist.advanceTime`, tau=R_th·C), liczenie `analogVolts` przez wagi konduktancji
- [x] P3.5 - OLED: framebuffer 128x64 (`oledSetPixel/oledLine/oledRect/oledFillRect`, podwójny bufor + `oledShow`), render pikseli w schemacie
