# Milestone 11 - V2 twardnienie: P0.1..P0.6 z plan_v2

Realizacja bloku P0 z `plan_v2.md` (audyt `audit_v1.md`), każdy punkt
red-green. Baza: `fbf7bdc`. Wynik końcowy: 311 testów (25 plików) na zero,
`tsc --noEmit` czysty, `verify.mjs` 9/9, `verify2.mjs` 24/24, `verify3.mjs`
wszystkie PASS (exit 0).

## P0.1 Izolacja pętli zdarzeń (B1, B2, B3)

- `core/machine.ts`: faza `'faulted'` + `faultReason` + `onFault(cb)`
  (zwraca unsubscribe); `advance()` **nigdy** nie rzuca - wyjątek z
  `clock.advance` (runaway guard Clock, błąd szkicu w przerwaniu) zatrzymuje
  maszynę, ustawia `faulted` i powiadamia słuchaczy raz. `run()` nadal rzuca
  synchronicznie (awaria setup() ma być głośna, `onRun` ją obstawia).
- `gui/sim/driver.ts`: interfejs `Advanceable.phase?()` - driver sam się
  zatrzymuje, gdy maszyna jest `faulted` (koniec z maszynami-zombie mielącymi
  CPU po awarii).
- `gui/components/SchematicCanvas.tsx`: pętla rAF w dwóch blokach try/catch
  (symulacja / render), re-arm `requestAnimationFrame` zawsze jako ostatnia
  instrukcja - jeden wyjątek nie zabija już całej animacji.
- `gui/App.tsx`: `onFault` -> banner + `setRunning(false)`; `safeStore`
  (QuotaExceeded -> banner) w persist/applyDoc/onRun/onProjectSave;
  `onExample` z try/catch (przykład nie mieści się na boardzie).
- Testy: `tests/resilience.test.ts` (7).

## P0.2 GPIO16 / D0 (B4)

Inaczej niż w planie, prościej i wierniej: zamiast równoległego bloku OUT16
`core/registers.ts` trzyma GPIO16 jako **wewnętrzny 17. bit** (`MASK17`), a
publiczne `read(GPIO_OUT/ENABLE)` zostają wierne 16-bitowe (bit 16 to na
prawdziwym chipie osobny blok RTC). Widok 17-bitowy (`outState()/enableState()`)
zasila diff-listener i `syncOut`; `read(GPIO_IN)` próbuje 17 pinów
(`0x1ffff`). Ścieżka `digitalWrite` przez `env` łapie to automatycznie
(maska `1 << g`). Deviacja od planu: bez osobnego "diff-listenera z bitem
16" - bit 16 jest zwykłym bitem rejestru, diff liczy się na stanie
17-bitowym.
Testy: `registers.test.ts` +5, `machine.test.ts` +3 (D0 HIGH/LOW na
magistrali, neutralność dla D4).

## P0.3 Budżet CPU na `advance()` (B5, B6)

Kluczowa decyzja: **dławimy interpreter, nie zegar świata** - zegar to czas
rzeczywisty układu (blink musi migać w tempie), interpreter to "prędkość
chipa". `FRAME_YIELD_BUDGET = 20_000` yieldów na `advance()` (~8 ms real przy
zmierzonych ~0,4 µs/yield), `run()` dostaje `SETUP_YIELD_BUDGET = 400_000`.
Wyczerpanie budżetu = ponowne przebudzenie z kwantą 200 µs (nie 0 jak w
planie: kwanta 1 µs budziłaby ~16k wake'ów na klatkę; 200 µs to ~80 wake'ów
i nadal ~20k iteracji pętli na klatkę).
`evalPure` (indeksowanie tablic, warunki): licznik `MAX_PURE_STEPS = 200_000`
-> `SketchRuntimeError('this expression loops without delay() - exceeded the
step budget', line)`.
Efekt: gorąca pętla bez `delay()`: wcześniej ~32 s na klatkę (zamrożona
karta), teraz ~6-7 ms/klatkę przy zachowaniu postępu szkicu.
Testy: `tests/resilience.test.ts` +5 (budget, tempo zegara, "alive" na
serialu, hang w setup < 500 ms, błąd z numerem linii).

## P0.4 Walidacja dokumentu i stanu startowego (B8, B9)

- `Schematic.fromJSON` przez strażniki kształtu (`isComp/isWire/...`):
  nieznany typ -> `Error("unknown component type 'x'")`, zgniłe
  pola/współrzędne/rot/końcówki drutu -> `invalid schematic document`,
  `type:'board'` z nieznanym `params.board` -> `unknown board id`.
  Walidacja typu idzie przez `footprintFor` (pojedyncze źródło typów), stąd
  bez eksportu `SCHEMATIC_TYPES` z planu.
- `gui/App.tsx`: `resolveBoardId` (wyeksportowany) - board z localStorage
  nieznany -> fallback `wemos-d1-mini` + `console.warn`; ścieżki startu
  (loadSchematic, project load, import) już łapały błędy, od teraz z
  konkretnymi komunikatami z walidacji.
- Testy: `schematic.test.ts` +5, nowe `tests/app-boot.test.ts` (2).

## P0.5 Spójność mutacji dokumentu (B7, H3)

- `Schematic.setParam` zawsze `touch()` - parametry karmią footprinty, więc
  stary cache `wireRoutes()` rysował druty do starych pinów po zmianie modelu
  boarda.
- Nowe `Schematic.setBoard(id)`: waliduje przez `getBoard`, zapisuje parametr,
  `touch()`; `App` (efekt maszyny) używa go zamiast bezpośredniego
  `boardComp.params.board = ...`.
- Testy: `schematic.test.ts` +2 (trasy liczone na nowo po zmianie modelu;
  wartość oczekiwana liczona z `getBoard`, nie na sztywno).

## P0.6 Higiena resetu, seriala, listenerów, raili (B10, B11, L1-L3)

- `machine.reset()` czyści teraz także `registers`, `alarms` i `printBuf`
  (wcześniej rejestr OUT przeżywał reset: szkic bez `pinMode` nie widział
  zmiany latcha, bo diff nie zachodził).
- `serialLog` cap 5000 linii (drop-oldest) + licznik `droppedLines`; szkic
  `while(1) println` nie zżera już RAM-u karty.
- `onSerial`/`onCircuit`/`gpio.onPinChange` zwracają unsubscribe; `App`
  odpina swoje subskrypcje w cleanupie efektu maszyny.
- `SchematicCanvas`: przycisk momentalny - uchwyt `pointerup` na `window`
  rejestrowany w `activeRelease` i zdejmowany przy unmount (trzymany przez
  odświeżenie panelu palec nie zostawia wiszącego listenera ani wciśniętego
  przycisku).
- `__emu` (hak debugowy na `window`) usuwany w cleanupie efektu.
- `core/boards.ts`: prawa strona NodeMCU = A0, D9, D10, 3V3, GND, D8..D5,
  NC, VU (zgodnie z realnym napisem v3; usunięte widma D11/D12 i **duplikat
  D10** - dwa raile o jednej nazwie to dwa terminale z tym samym etykietą).
  D9/D10 pozostają `gpio:null` (flash-internal).
- Testy: `machine.test.ts` +4, `boards.test.ts` +1 (unikalne nazwy sygnałowe;
  zasilanie może się powtarzać).

## Zależności i ryzyka

- P0.3 zmienia semantykę wydajnościową: przy ciężkich szkicach symulacja może
  zejść poniżej prędkości rzeczywistej zamiast zamrażać UI; `machine.timeMs()`
  zawsze zostaje spójny wewnątrz świata symulacji.
- P0.6 ruszył napisy NodeMCU: stare dokumenty z drutami do D11/D12 mają od
  teraz wiszące końcówki - `wireRoutes()` i `syncNetlist` pomijają wiszące
  druty bez wyjątku (tak jak wcześniej druty do skasowanych komponentów).
- `setParam` z `touch()` = pełne przeliczenie tras przy każdej zmianie
  parametru (także przy ciągnięciu potencjometru); ~0,3-1,5 ms na boardach z
  testów, docelowo optymalizacja w P1.2.

---

# Faza P1 - wydajność renderu i obwodu (plan_v2 pkt 7-10)

## P1.1 - `resolve()` tylko na sygnale zmiany

- `GpioBus` i `Netlist` mają publiczne liczniki `version`; `Machine`
  zapamiętuje parę wersji i przy braku zmian pomija `netlist.resolve()`.
- Wersje notowane PRZED przejściem zwrotnym `setExternalDriver`: ruch pinu
  wymusza jedno dodatkowe rozwiązanie w następnej klatce (stan ustala się po
  ≤2 przejściach).
- Brak zależności `resolve()` od czasu - sprawdzone grepem, cache bezpieczny.
- Pomiar: stan ustalony, 301 elementów, `advance(16)`: 9,5 ms -> **0,013 ms**
  (cel planu: <0,2 ms). 4 testy (`resolve on change signal`), z rozgrzewką
  `advance(0)` (pierwsze wywołanie to legalne pierwsze rozwiązanie).

## P1.2 - tani drag + indeksacja routingu

- `Schematic.beginDrag()/endDrag()`: w czasie przeciągania `touch()` nie
  unieważnia cache tras - klatki rysują ostatni commit (0,001 ms/mousemove),
  pełne przeliczenie raz przy puszczeniu. Canvas: `beginDrag` na pointerdown
  narzędzia move, `endDrag` na pointerup i na Escape (zamrożenie dokumentu
  nie może przeżyć przerwanej sesji przeciągania).
- Profil routingu na scenie 300 drutów (było: 9,5 s na każdy mousemove):
  1. `pathHits`: broad-phase bbox ścieżki + opcjonalny indeks siatkowy
     `ObstacleIndex` (64 px, segment = spacer po komórkach; ścieżki prostopadłe).
  2. `astarRoute`: okno siatki ograniczone do końcówek +/-140 px i PRZYCIĘTE
     do niego przeszkody (dawniej okno rósło do każdej przeszkody - jedna
     daleka część = wyszukiwanie po całej scenie); miękka kara rastrowana
     zakresami komórek (było O(węzły x przeszkody)); budżet 60k ekspansji
     (null -> ścieżka kandydata, jak dawny strażnik N>120k).
  3. `candidates()`: pasy autobusowe tylko od przeszkód w korytarzu drutu
     (+/-260 px) - dawniej róg każdej przeszkody w scenie generował kandydata
     (~8000 na dużych dokumentach).
  4. `routeWire`: kandydaci punktowani liczbą kolizji, detour tylko TOP-24
     (dawniej detour 6 przebiegów x wszystkich kandydatów - złożoność sześcienna).
- Pomiar (przeliczenie WSZYSTKICH tras od zera): typowy dokument 30 drutów
  20-40 ms; 90 drutów 0,3 s; stress 300 drutów 84 s -> **8,9 s** (scena
  syntetyczna, realne dokumenty <100 drutów). Drag w dokumencie typowym:
  ruch 0,001 ms, commit ~30 ms.
- Testy: 2 (zamrożenie/freeze-commit, endDrag bez beginDrag), +1 duży dokument
  (130 drutów: każda ścieżka spójna od-a-do-b). Usunięty zgubiony test
  tymczasowy `tests/_tmp-preset2.test.ts` ("isolate w5", pozostałość V1).

## P1.3 - statyczny kadr

- `Schematic.version` (publiczny licznik w `touch()`): sygnał brudności
  dokumentu dla pętli klatek.
- Tło + siatka rysowane do offscreen bitmapy keyed (cam, zoom, rozmiar, dpr);
  `drawImage` zastępuje też czyszczenie płótna.
- `SchematicCanvas`: klatka liczy sygnaturę (version, kamera, rozmiar, dpr,
  selekcja, hover, narzędzie+cursor drutu); bez zmian i bez `running` -
  `renderScene` w ogóle nie startuje. Idle+stop = tylko pusty bieg rAF.
- Test: `document version signal` (mutacje podnoszą, odczyty nie).

## P1.4 - SerialMonitor

- `SerialLine.id` (monotoniczny, nadawany w `flushLine`), klucze React po id
  (dawniej `key={i}`: każda nowa linia przerysowywała DOM całego okna).
- Okno App: 600 linii w stanie, przycinane do 500 (plan: 500; zapas po to,
  żeby ciecie nie zachodziło przy każdym secie).
- Test: id liczbowe, unikalne, rosnące.

## Status fazy P1

Wszystkie pozycje P1 z planu zrobione. Weryfikacja po fazie: 319 testów /
24 pliki, `tsc --noEmit` czysto, `verify.mjs` 9/9, `verify2.mjs` 24/24,
`verify3.mjs` exit 0 (w tym "render loop alive after all part draws").

---

# Faza P2 - interfejs (plan_v2 pkt 11-12)

## P2.11 - hover drutu, Del, kursor, ghost palety

- Hover drutu używa TEGO samego hit-testu co klik (`findWireSeg`): drut pod
  kursorem dostaje halo w kolorze selekcji (podświetlenie pod normalnym
  stroke'em), a płótno - kursor `pointer` (także na pinie).
- `Delete`/`Backspace` bez zaznaczenia, z kursorem nad drutem: usuwa ten
  drut (potwierdzane; zablokowane gdy maszyna biegnie).
- Drag&drop z palety: dashed ghost footprinta (rozmiar z `footprintFor`,
  przyciągnięty do siatki 10) rysowany w miejscu, gdzie nastąpi upuszczenie.
  `dataTransfer` jest nieprzezroczysty dla `dragover`, więc typ przeciąganej
  części idzie przez pamięć wspólną okna (`dragState` w `gui/dnd.ts`);
  paleta czyści go w `onDragEnd`, płótno w `onDrop`/`onDragLeave`.
- MIME `application/x-component` - jedna stała `COMPONENT_MIME` w nowym
  `gui/dnd.ts` (H1: była duplikowana w Palecie i kanwie).
- Sygnatura klatki (P1.3) objęła hover drutu i ghosta - inaczej halo i
  ghost nie odświeżałyby kadru.

## P2.12 - presety

- `hcsr-serial.ino`: okablowanie idzie przez `h.id` zamiast literału
  `'hcsr-1'` (H2; było martwe `void h;`). Aktualnie oba się pokrywały -
  fix usuwa kruche współzależnie od kolejności id, test gwaranta pilnuje
  braku wiszących końcówek: każdy preset musi mieć wszystkie końcówki drutów
  w istniejących komponentach i wszystkie druty w `wireRoutes()` (wiszące
  są pomijane po cichu - to była droga, którą ten bug uciekłby).
- Stałe geometrii boarda (`BOARD_RIGHT_X=160`, `BOARD_PITCH=20`) wyeksportowane
  z `schematic.ts`; `pinWorld` w presetach liczy stronę z `BOARD_RIGHT_X/2`
  zamiast magicznego `80` (H1).
- Walidacja + baner: ścieżki ładowania presetów i projektów już (od P0.4)
  idą przez rzucający `fromJSON` z `setError` - sprawdzone, bez zmian.

## Regresja złapana przez E2E (ważna lekcja)

Pierwsza wersja gate'a klatek z P1.3 miała sygnaturę `sig = running ? 'run'
: [...]`: przy `running` sygnatura była STAŁA, więc po pierwszej klatce
`sig !== lastSig` nigdy nie zachodził - przy włączonej maszynie płótno
renderowało się DOKŁADNIE RAZ i zamierało (maszyna tykała, serial działał -
scripts verify/verify3 tego nie widziały, bo zaglądają w serial). Poprawka:
warunek `runningRef.current || sig !== lastSig`. Weryfikacja: nowy
`scripts/verify4.mjs` (CDP, licznik nakłuty w `CanvasRenderingContext2D.stroke`):
1. idle+stop: 0 stroke'ów w 1,5 s;
2. hover na drucie: repaint + kursor pointer;
3. Del usuwa drut znad kursora;
4. po operacji znowu cisza (0 stroke'ów);
5. running: ciągły repaint (delta > 0).
Wniosek: testy dotykowe UI muszą patrzeć w piksele/liczniki rysowania, nie
tylko w stan modelu.

## Status po fazie P2

320 testów / 24 pliki, `tsc` czysto, `verify.mjs` 9/9, `verify2.mjs` 24/24,
`verify3.mjs` exit 0, `verify4.mjs` 6/6 (nowy). Usunięty zgubiony skrypt
`scripts/_dbg1.mjs` (pozostałość V1, tak jak `tests/_tmp-preset2.test.ts`).
Ghosta D&D zweryfikowano tylko wzrokowo-jednostkowo (brak testu E2E -
syntetyczne DragEvent przez CDP jest zawodne).

---

# Faza P3 - nowe funkcje (plan_v2 pkt 13), kolejność: wg zgłoszeń -> "wszystko po kolei"

## P3.1 - edytor wymuszenia ADC (suwak A0)

- `Netlist.pinForce(id, volts|null, terminal)`: wirtualna część `force` -
  IDEALNE źródło napięcia za 10 kΩ (stała `FORCE_R`). Słabe celowo: realny
  sterownik na tej samej sieci wygrywa dzielnik zamiast zgłaszać zwarcie
  szyn do szyny; wymuszenie na pinie, który ktoś już steruje, tylko domiesza.
- Źródła `force` są "przypięte" (osobna lista w Netlist) i przeżywają
  `clear()` - `Schematic.syncNetlist` kasuje i buduje siatkę od zera przy
  każdej edycji dokumentu, a suwak musi ostać.
- `Esp8266Machine.setAnalogForce(volts|null)` - jedyne API; trzyma siłę na
  `mcu.A0` i przelicza obwód od razu (wzorzec `press()`).
- UI: `AdcDock` - dok przytwierdzony w prawym dolnym rogu kanwy (checkbox +
  suwak 0..3,30 V + odczyt `V = kod ADC`). Bez checkboxa dok jest cichy i
  przeźroczysty; wartości suwaka przeżywają przeładowanie dokumentu.
- Testy (5, `tests/analog.test.ts`): wymuszenie na wiszącej A0, przeżycie
  `clear()`, słabość (10k do masy poławia napięcie, zero zwór), zdjęcie =
  znowu widmo, skalowanie `analogRead` + odporność na resynchronizację.
- E2E (`verify4.mjs` checki 7-8): klik checkboxa i ruch suwaka PRZEZ DOM
  (native setter + event `input`) realnie zmieniają `analogRead(17)` na 775,
  odznaczenie zeruje. 8/8 na żywej karcie.
- Uwaga modelowa: wymuszenie LICZY się też do `pinLevels` (A0 jako wejście
  cyfrowe). Realny ESP8266 nie ma na A0 cyfrówki - pozostawione świadomie,
  emulator traktuje A0 jak każdy pin; zmiana wymagałaby rozdziału
  "pin bez GPIO" w rejestrach i nie jest w planie.

## P3.2 - attachInterrupt(pin, isr, mode) na GPIO

- API: `attachInterrupt(pin, isr, CHANGE|FALLING|RISING)` i
  `detachInterrupt(pin)`; tryby zgodne z rdzeniem ESP8266 (CHANGE=0,
  FALLING=1, RISING=2).
- Detekcja krawędzi: jedno porównanie poziomów na `resolveCircuit()` (łapka
  P1.1). Dwa zbocza w jednym oknie rozdzielczym scalają się w jedno - jak
  zajęty MCU gubiący impulsy; udokumentowane uproszczenie.
- ISR jedzie tą samą kooperacyjną lane co `timer0ISR` (`isrQueue` +
  `scheduleWake`), więc ISRs startują, gdy main siedzi w `delay()` -
  znane odstępstwo (brak preempcji w połowie instrukcji).
- Nazwa funkcji jako argument: w interp goły identyfikator znanej funkcji
  ewaluuje do swojego stringa (dekay funkcja->wskaźnik). Nieznana nazwa
  wysypuje setup() komunikatem "'x' was not declared" - błąd widoczny
  natychmiast, nie przy pierwszym zboczu.
- Stan `attachments`/`isrPrev` czyszczony w `halt()` (czyli przez run/stop/
  reset); reset() + ponowne run() attachuje ponownie w setup() - dokładnie
  jak reset na sprzęcie.
- Pułapka złapana przy testach: rejestracja `mcu` w Netlist BEZ
  `params.pins` nie daje żadnych terminali w `pinLevels`/`externals`
  (`pinsOf` zwraca [] dla mcu) - poziomy pinów istnieją dopiero od listy
  pinów; testy muszą ją podawać, tak jak robi to `syncNetlist`.
- Testy: 7 w `tests/interrupt.test.ts` (oba zbocza, ignorowane zboczo,
  CHANGE=2, detach, błąd nazwy, reset). E2E bez zmian: 9/9, 24/24, ok, 8/8.

## P3.3 - WiFi mock (pulpit tylko na Serial)

- Model bez gniazd sieciowych: `WiFi.begin(ssid, haslo)` ustawia link na
  `teraz + 1,5 s` (asocjacja), `WiFi.status()` oddaje 6→3, `localIP()`
  '0.0.0.0' przed postawieniem linku i '192.168.1.42' po, `macAddress()` stale,
  `RSSI()` -55. Stałe `WL_*` i `WIFI_STA/AP` po warto sciach z biblioteki.
- Obiekty: `WiFiClient client;` oraz `WiFiServer server = WiFiServer(80);`
  (składnia konstruktora `WiFiServer server(80);` NIE jest parsowana -
  odstępstwo udokumentowane). Typy trafiły do `TYPE_WORDS`; w interp
  deklaracja typu WiFi produkuje token `@WiFiServer:80` i hook
  `env.objectDecl(name, type, port)` rejestruje egzemplarz po stronie
  maszyny. Wywołania `server.begin()` docierają do `env.call` jako nazwa z kropką
  i stamtąd do `wifiCall()` po resolve'ie odbiornika.
- Pulpit: każdy `client.print/println/write` jest mirrorowany na konsolę
  Serial z prefiksem `[net->host:port] ` - szkic "wysyła HTTP" i widać to
  w oknie Serial. `connect()` odmawia przed postawieniem radia, `stop` zrywa
  peera. `available()`/`read` zawsze puste: klienty z zewnątrz nie mają jak
  się połaczyć (świadome ograniczenie mocka).
- Nieznany obiekt (`relay.flip(1)`) wywala setup komunikatem z nazwą
  odbiornika.
- Testy: 8 w `tests/wifi.test.ts` (maszyna stanów radia, lokalny IP,
  lustro TCP na Serial, odmowa connectu, serwer, MAC, błąd obiektu).
  Pułapka: `wifiCall` to metoda klasy - nie ma dostępu do domknięcia
  `num()` z `env()`; konwersja argumentów lokalnie.

## P3.4 - kondensator z krzywą RC

- Model: między solve'ami napięcie płytki `p1` dąży wykładniczo do
  zastępnika Thevenina otoczenia - `Netlist.advanceTime(dtUs)` liczy
  `v <- vTh + (v - vTh)·e^(-dt/tau)`, `tau = R_th · C` (omy × mikrofarady
  = mikrosekundy). Ładowanie i rozładowanie tym samym równaniem.
- Kondensator wchodzi do solve'a jako źródło na płytce `p1`
  (`rInternal 1`, słabe): w t=0 wygląda jak zwarcie, naładowany trzyma
  napięcie; `p2` to wyprowadzenie odniesienia (w schemacie do masy).
- `advanceTime` wyklucza źródło własnego kondensatora (inaczej pętla
  samoodniesienia zamraża krzywą), a `reachSources` oddaje teraz `at`
  (terminal źródła) właśnie po to.
- `analogVolts` przepisane na ścisły Thevenin wielu źródeł (wagi
  konduktancji 1/r) zamiast pary hi/lo: źródło za 1 TΩ znika naturalnie,
  szyna r=0 wygrywa; stare testy działka/pota przechodzą bez zmian.
- Maszyna: `advance()` odpyla relaksację raz na klatkę (dokładne
  rozwiązanie wykładnicze dla dt klatki), `reset()` rozładowuje
  (`resetCapacitors`) - restart ma być deterministyczny.
- Zmiana wersji przy ruchu płytki: bez `version++` cache solve'ów P1.1
  pokazywałoby zamrożone napięcia.
- Testy: 6 w `tests/capacitor.test.ts` (63% w tau, nasycenie po 6 tau,
  10x C = 10x wolniej, krzywa na `analogRead`, brak upływu = ładunek
  stoi, `reset` rozładowuje).

## P3.5 - OLED framebuffer 128x64

- Panel SSD1306 dostał prawdziwy bufor pikseli 128x64 w formacie stron
  (1024 bajty, bit = piksel), identycznie jak sprzęt.
- Polecenia rysujące (`oledSetPixel`, `oledLine`, `oledRect`,
  `oledFillRect`, opcjonalny argument `on` = 1) malują bufor tylny;
  `oledShow()` przerzuca go na widoczny - połowa narysowanej ramki nigdy
  nie trafia na panel. Współrzędne spoza 0..127 / 0..63 są cicho odrzucane.
- `oledLine` to całkowitoliczbowy Bresenham na ośmiu oktancjach
  (akumulator błędu osobno od delt - pierwsza próba z `dy += dx` gubiła
  punkty).
- Warstwa tekstu 8x21 (`oledPrint`) działa jak poprzednio, natychmiast,
  bez `show()` - zgodność wsteczna ze starymi szkicami i przykładami.
  Ograniczenie: tekst nie ma fontu w buforze pikseli, GUI nakłada go
  z czcionki przeglądarki.
- `oledBegin` zeruje bufor tylny (re-init karty), widoczny zostaje do
  następnego `oledShow()`.
- Renderer schematu rysuje widoczny bufor jako piksele (ścieżka
  `fillRect` na ustawione bity) plus dotychczasowy tekst.
- Testy: 6 w `tests/oled.test.ts` (commit dopiero po `show`, clipping,
  Bresenham 11/11 pikseli, ramka vs wypełnienie, `oledClear`, tekst).
  E2E `scripts/verify5.mjs`: szkic rysuje blok/przekątną/ramkę, stan
  `fb` liczony w przeglądarce + zrzut canvasu do oceny wzrokowej.
