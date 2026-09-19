# Audit V1 - bezlitosna analiza krytyczna (2026-09-18)

Metoda: pełna lektura `core/`, `peripherals/`, `gui/` (8,9k LOC), sondy wykonawcze
(vitest, patrz "Dowody") + audyt równoległy warstwy GUI. Stan odniesienia:
commit `fbf7bdc`, 277 testów zielonych, `tsc --noEmit` czysty.

Konwencja: B = blocker (stabilność/poprawność), P = wydajność, L = wycieki,
H = skruty/separacja. Numery są stabilne - używaj ich w planach i commitach.

## Teza kontrolna: założenia dokumentacji vs kod

Dokumentacja (`ARCHITECTURE.md`, milestone_*) jest uczciwa i aktualna co do
struktury, ALE trzy stwierdzenia są **fałszywe**:

1. `machine.ts` / milestone_3: "slice budget PUMP_SLICE=5000 ... delay-free
   loop() nie zatka zegara". Nieprawda: budget jest **per przebudzenie**, a
   przebudzeń na jedno `advance()` jest ~1 na 1 us czasu wirtualnego. Pętla bez
   delay zatyka czas rzeczywisty wielokrotnie mocniej niż zegar (B6).
2. `registers.ts` (komentarz nagłówkowy): "GPIO16 ... the machine handles that
   pin outside this file". Nieprawda: maszyna nigdzie nie obsługuje GPIO16
   poza 16-bitową maską -> `digitalWrite(D0, ...)` jest po cichu gubiony (B4).
3. `ARCHITECTURE.md`: "Loops additionally yield tick so the host can pause ...
   without waiting for the sketch to sleep". Prawda dla pętli w ciele instrukcji,
   fałsz dla wyrażenia indeksu/inicjalizatora: `evalPure` nie ma budżetu (B5).

Testy (277) tego nie łapią: brak testów D0/GPIO16, brak testów pętli
nieskończonych, brak testu izolacji rAF, brak walidacji `fromJSON`.

## A. Stabilność pętli zdarzeń (BLOCKERY)

### B1. rAF-loop umiera na pierwszym wyjątku - cała aplikacja
`SchematicCanvas.tsx:111-137`: `frame()` nie ma `try/catch`, a
`raf = requestAnimationFrame(frame)` jest **ostatnią** instrukcją. Każdy
wyjątek z `driver.frame()` (RuntimeError szkicu, "Clock runaway") lub z
`renderScene()` (nieznany typ komponentu, dangling reference) przerywa frame
przed re-armem -> canvas i symulacja zamrażają NA ZAWSZE, faza maszyny zostaje
'running', jedynym ratunkiem jest reload. Ścieżki dojścia: każdy runtime error
szkicu; import JSON z `"type":"foo"` (B8); `pinWorld` throw na wiszącym
referencyjnie przewodzie.

### B2. "Clock runaway" tworzy maszynę-zombie
`clock.ts:76` rzuca po 100k fire'ów w jednym `advanceTo`. Rzucony wyjątek:
(a) propaguje się na zewnątrz `machine.advance()` (patrz B1), (b) zostawia
fazę 'running', `mainGen != null`, `cpuTask` z id nieistniejącego taska i pustą
heapa. Sonda: po throw kolejne `advance(100)` trwa 0 ms, czas płynie, szkic
nigdy już nie ruszy. Brak żadnej informacji dla użytkownika.

### B3. Wyjątki w handlerach narzędziowych gaszą UI po cichu
`App.tsx:104-114 onExample` - `loadExample()` rzuca (preset twardo kabelkuje
'D4','A0','3V3','GND'; board bez pinu -> throw z `pinWorld`) -> brak `setError`,
brak reakcji UI. `onRun` jest obstawiony, `onExample`/`onImport` częściowo.
`localStorage.setItem` bez obstawy w `persist`/`applyDoc`/`store.save` -
QuotaExceededError wyskakuje z `onPointerUp` canvasu.

### B9. boardId z localStorage niewalidowany -> biały ekran przy starcie
`App.tsx:48-50,65`: `new Esp8266Machine({board: localStorage...})` w
inicjatorze `useState`; `getBoard()` rzuca -> whole-app crash przy mocie,
banner błędu nie istnieje (React nie zdążył nic wyrenderować). Uszkodzony/obcy
klucz `esp8266-emu.board` = aplikacja nie startuje.

## B. Poprawność emulacji (BLOCKERY)

### B4. GPIO16 / pin D0 nie do zapisu (potwierdzone sondą)
`registers.ts:21` MASK16=0xffff -> `write(W1TS, 1<<16)` maskuje się do 0 ->
brak diffa -> brak listenera; `syncOut` iteruje po masce. Sonda:
`pinMode(D0,OUTPUT); digitalWrite(D0,HIGH); advance(5)` -> `pinLevel(16) === 0`.
Na prawym ESP8266 GPIO16 siedzi w innym bloku (RTC) i nie mieści się w masce
GPIO_OUT - emulator powinien traktować bit16 poza 16-bitowym rejestrem (zgodnie
ze własnym komentarzem w pliku). D0 to często używany pin (deep sleep, NeoPixel
wake), więc to nie jest egzotyka.

### B5. `evalPure` = niezrywalna pętla synchroniczna
`interp.ts:476-490`: wyrażenie indeksu tablicy (`arr[f()] = x`, `arr[i]++`) i
inicjalizatory deklaracji są evalowane przez `evalPure`, który **kręci
generatorem bez budżetu** (`while (!r.done)`). `while(true){}` w wywołaniu
użytkownika użytym w indeksie = nieskończona pętla wewnątrz `gen.next()`:
żaden PUMP_SLICE ani rAF nie ma szans - twardy freeze karty. delay() jest
tu obstawiony throwem, pętla bez delay - nie.

### B6. Pętla bez delay zamraża UI na dziesiątki sekund na klatkę (SONDA)
Model: wake co `max(1,us)` us, każdy zjada do 5000 yieldów; `advance(16 ms)`
przy 1x = 16 000 wake'ów = 80 mln kroków interpretera.
Sonda: `advance(0.1 ms virtual) = 198 ms real` -> klatka rAF 16 ms ≈ **32 s
zamrożenia**; osobna sonda: `advance(16)` nie skończyła się w 60 s (proces
victim). Przy 64x ten sam szkic dochodzi do progu 100k fire'ów -> B2.
Brak limitu kroków interpretera na **wywołanie** `machine.advance()` -
pompowany jest czas wirtualny, nie budżet CPU.

### B7. `setParam` nie unieważnia cache'u geometrii
`schematic.ts:256-259`: `setParam` nie woła `touch()`, a parametry wpływają na
footprint (`neopixel.count` - szerokość i piny; `board` - model płytki).
Zmiana długości stripa lub modelu boarda w dialogu zostawia stare trasy/przeciecia
aż do przypadkowej mutacji dokumentu. `App.tsx:74` dokłada mutację
`boardComp.params.board = boardId` bezpośrednio w efekcie React - poza
mutatorami Schematic (por. H3).

### B8. `Schematic.fromJSON` bez walidacji
`fromJSON` akceptuje dowolne `type`; wybuch następuje dopiero w
`footprintFor` (render, hit-test, routing) -> prosta droga do B1. Import
pliku JSON jest oficjalną ścieżką aplikacji (Toolbar). Brak też sprawdzenia
typów pól (rot, liczby).

### B10. `machine.reset()` nie resetuje rejestrów ani bufora druku
`run()` robi `registers.reset()`, `reset()` nie -> po Reset bity OUT zostają
HIGH przy wyczyszczonym latchingu magistrali (rozjazd stanów; praktycznie
niewidoczny, bo kolejny Run czyści, ale łamie zasadę "reset = wszystkie
warstwy" z milestone_3). `printBuf` nieczyszczony w `halt/run` -> ogon
urwanej linii po Stop dokleja się do pierwszej linii następnego uruchomienia.

### B11. Tabela NodeMCU: zdublowane raile 'D10' (i niekonsekwencje silk)
`boards.ts:108-118` - 'D10' na right row 1 i row 11, '3V3' po obu stronach
(możliwe na prawdziwej płytce, ale dubel D10 daje dwa różne terminale
`mcu.D10` w sicie -> mylące błędy przy kablowaniu i fałszywe fault).

## C. Wydruk wybranych scenariuszy brzegowych (Krok 2)

1. **Pętla nieskończona / brak yield w szkicu**: B6 (freeze ~32 s/klatkę),
   B5 (freeze bezwarunkowy w wyrażeniach indeksu), B2 (po progu 100k - zombie),
   B1 (wyjątek run-away gasi pętlę renderu). `while(true)` w samym `setup()`
   jest bezpieczny: `run()` limituje się do ~10 wake'ów (advance(10)).
2. **Zwarcia wirtualnego obwodu**: solver wykrywa `short` (dwie sztywne
   szyny różnej wartości w jednym węźle 0 Ω) i `contention` (dwa wypchnięcia
   MCU). Banner odpytuje co 250 ms. Reakcja: ostrzeżenie, brak odcięcia
   zasilania i brak prądowo-cieplnego modelu - świadome uproszczenie DC, do
   udokumentowania w README jako "ostrzega, nie chroni". Przypadek
   "pin MCU vs GND przez przycisk" idzie przez `gpio.conflict` -> poprawnie.
3. **Szybki PWM / obciążenie canvasu**: `analogWrite` nie generuje zdarzeń
   (duty-averaging), więc sam PWM jest tani. Kosztem jest **stały** koszt
   klatki: pełny `resolve()` + `renderScene` co rAF (patrz P1-P3), a nie
   częstotliwość PWM. Szybki PWM widoczny jako migotanie jasności LED tylko
   gdy klatka nadąża.
4. **Timery vs event loop**: czasy całkowite w us, `Math.round` na
   przebudzeniach, kwant 1 us - precyzja wirtualna dobra. Problem to mapowanie
   ściana->wirtualny: `maxStepMs=50` x 64x = 3,2 s symulacji w jednej klatce
   (skokowość), ISR tylko kooperacyjny gdy main siedzi w `delay()`
   (udokumentowane), a okres alarmu < ~1 us + masywna pętla główna przy
   dużym speed prowadzi do progu runaway (B2). Brak `attachInterrupt`.

## D. Wydajność

- **P1. `resolve()` pełny co ramkę, bez dirty-checku.** Sonda (rozbudowane
  LED+R na pinach): 61 elementów -> 0,33 ms/klatkę; 151 -> 1,55 ms;
  301 -> 9,52 ms (57% budżetu 16,6 ms, zanim cokolwiek się narysuje).
  Koszty: `links()` skanuje WSZYSTKIE wires+buttons per odwiedzony węzeł;
  Dijkstra per terminal (sort na każdej iteracji); `coilEnergized` =
  rekurencyjna Dijkstra wewnątrz relaksacji; `netOf` per terminal.
- **P2. Drag komponentu = pełny re-route wszystkich przewodów +
  `findCrossings` O(W²·S²) co klatkę** (`move()` -> `touch()`;
  `wireObstacles` per drut = O(W·C) `footprintFor`-ów; A* per drut gdy
  heurystyka padnie). 30 elementów + 30 przewodów: dziesiątki ms/klatkę,
  zacinanie przy przeciąganiu.
- **P3. Render 60 fps w bezruchu**: siatka i scena rysowane od zera co
  rAF nawet bez zmian i przy zatrzymanej maszynie; `allPinWorlds()`
  budowane co klatkę; brak offscreena dla warstw statycznych.
- **P4. SerialMonitor**: `key={i}` + trym 2000->1500 wymusza re-render
  ~1500 linii przy każdym burcie.

## E. Wycieki pamięci

- **L1. `machine.serialLog` rośnie bez limitu** (cap 2000 jest tylko w
  stanie React). Godzina symulacji z `Serial.println` co 10 ms przy 64x =
  ~23 mln linii. `machine.circuit()`/`lastCircuit` - OK (zastępowane).
- **L2. `window.addEventListener('pointerup', release)`** przy dociśnięciu
  przycisku: unmount w trakcie wciśnięcia zostawia listener + maszynę.
- **L3. `window.__emu`** nie sprzątany przy unmount (pinned refs do
  schematu/maszyny) - tooling, ale trzyma cały dokument.
- Brak realnych timerów/wall-clock uchwytów poza fault-bannerem (sprzątany)
  i rAF (sprzątany) - dobra wiadomość.

## F. Skróty, hardkody, separacja

- **H1.** Duplikaty stałych: klucze `esp8266-emu.*` (App.tsx i projects.ts),
  board `RIGHT_X=160/PITCH=20` vs test `<=80` w examples.ts, grid BASE=10 vs
  snap 10 vs PAD/STUB w routes.ts, MIME `application/x-component` w dwóch
  plikach, `'wemos-d1-mini'` i `'blink.ino'` magiczne.
- **H2.** examples.ts kabelkuje `'hcsr-1'` dosłownie, ignorując `h.id`
  (martwe `void h;`) - kruchy preset.
- **H3.** Mutacje dokumentu w efektach React (`params.board`, pętla
  `setParam` w App) - źródło B7; Schematic nie wystawia `setBoard()`.
- **H4.** Martwy kod: `routes.ts:413` `db ? b : b`; `void GPIO_ENABLE_W1TS`
  w konstruktorze maszyny; `Serial.begin` zwraca 1 bez znaczenia.
- **H5.** Fidelity drobne: `printf` ignoruje lewe wyrównanie `%-8d`;
  `map()` liczy `Math.round` zamiast integer-truncacji core'a; OLED `addr`
  z parametru nieużywany przez `oledBegin` (binding po pierwszym OLED).
- **H6.** `load()` parsuje source 2x (walidacyjnie + w `run()`);
  bez błędu, ale podwaja koszt i kusi desynchronizacją AST.
- **H7.** `SchematicCanvas` łapie wyjątki w 3 miejscach po cichu
  (`catch {}`) - rzucanie do `console` zamiast do bannera.

## Dowody (sondy)

1. `digitalWrite(D0,HIGH)` -> `pinLevel(16)=0` (test, zielony FAIL bazy).
2. HOT-loop `advance(0.1ms) = 198 ms`; `advance(16 ms)` > 60 s (timeout
   procesu).
3. Po "Clock runaway": faza 'running', heap 0, `advance(100)=0 ms`, szkic
   martwy.
4. `resolve()`: 0,33/1,55/9,5 ms/klatkę dla 61/151/301 elementów.

## Co jest dobre (nie psuć)

Pasywny zegar (deterministyczne testy), cache tras keyed na `touch()`,
unia Dijkstra+Thevenin bez SPICE, czyste moduły `viewport/grid/hit`,
walidacja JSON projektów w `projects.ts`, pasywność maszyny (zero wall-timerów),
testy integracyjne presetów przez prawdziwy solver.
