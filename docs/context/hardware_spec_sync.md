# Hardware Spec Sync - audyt silnika vs fizyczna specyfikacja ESP8266

Start: 2026-09-19. Stan odniesienia: commit `458aaa7`, 482 testy zielone.
Cel: zgodność emulatora z datasheetem ESP8266EX + notami boards (Wemos D1
mini / NodeMCU v3) i z realnym rdzeniem esp8266/Arduino. Plik jest ciągłym
zrzutem stanu - każdy komponent ma sekcję: spec -> stan w kodzie -> luki ->
plan -> status. Kolejność pracy = kolejność sekcji F1.x, F2.x (zadania
sekwencyjne, Concurrency = 1).

## Źródła i ich dostępność

- Datasheet PDF ESP8266EX: **nieosiągalny z tej sieci** (www.espressif.com i
  documentation.espressif.com zwracają stronę challenge; Mouser/Pololu
  blokują; Wayback CDX: brak kopii). Parametry elektryczne poniżej jako
  wartości kanoniczne z datasheetu (sekcje DC characteristics) - oznaczone
  [DS]; tam gdzie nie mam pewności co do ostatniej cyfry: [DS~].
- **Oficjalne źródło behawioralne pobrane lokalnie** do `.ref/` (surowe
  pliki z gałęzi master repo esp8266/Arduino): `Esp.cpp`, `Esp.h`
  (WDT, restart, reset reason), `core_esp8266_timer.cpp` (timer0/1),
  `core_esp8266_wiring_analog.cpp`, `core_esp8266_main.cpp`,
  `core_esp8266_wiring_digital.cpp`. Używane jako wyrocznia dla zachowań
  rdzenia (nie datasheet).
- Web search w tej sesji niedostępny (brak DEEPSEEK_API_KEY) - ustne
  przekazy ("user twierdzi X") oznaczam, jeśli są sprzeczne z [DS].

## Parametry bazowe [DS]

| Parametr | Wartość | Gdzie używamy |
|---|---|---|
| Zasilanie VDD | 3.0-3.6 V | model rail 3V3 |
| Abs. max na pinie IO | -0.3 V ... VDD+0.3 V (4.0V abs max) | damage 5V |
| Logika HIGH wejścia | > 0.65*VDD ~ 2.0 V (model: próg 1.65 V) | netlist (istnieje) |
| Max prąd GPIO (source/sink) | 12.8 mA na pin [DS~: 12.8, user: 12] | limit pinu |
| Max suma prądów GPIO | ~48.8 mA (wszystkie piny) [DS~] | limit chipa |
| Pull-up wewn. GPIO0/GPIO2 | ~45 kOhm, aktywne w resecie [DS] | boot strap |
| Pull-down wewn. GPIO15 | ~45 kOhm, aktywny w resecie [DS] | boot strap |
| ADC TOUT | 10-bit, pełna skala 1.0 V, nieliniowy < 0.25 V [DS]/[core docs] | ADC |
| Soft WDT | timeout ~6.3 s, karmiony przez yield/delay; ESP.wdtFeed/wdtEnable/wdtDisable [core Esp.cpp] | WDT |
| Hard WDT | ~6.3 s, nienakarmialny z softu [core Esp.cpp komentarz "less than 6 seconds"] | WDT |
| Boot: GPIO15=L, GPIO0=H, GPIO2=H | boot normalny (SPI/flash) [DS] | boot mode |
| Boot: GPIO0=L (przy 15=L) | UART download mode [DS] | boot mode |
| Boot: GPIO15=H | brak bootu (SDIO/stop) [DS] | boot mode |
| Flash EEPROM-emulacja | 1 sektor 4 KiB, 100 000 cykli P/E [DS flash], commit = erase+write sektora | EEPROM |
| Timer0 | 22-bit, zarezerwowany przez stos WiFi [core] | timery |
| Timer1 | 23-bit, dzielnik /256 -> tick 3.2 us (80 MHz/256), max okres 0x7FFFFF*3.2us = 26.7 s [core] | timery |

---

# F1.1 Stany bootowania (boot straps)

**Spec.** GPIO0 i GPIO2 mają wewnętrzne pull-upy (~45k) domyślnie aktywne w
resecie, GPIO15 wewnętrzny pull-down. Tryb bootu próbkowany w zwolnieniu
resetu: 15=L+0=H -> flash boot; 0=L -> UART download; 15=H -> brak bootu.
GPIO2=L przy starcie -> hang ("eagle fw" panic w ROM-ie).

**Kod.** `GpioBus.reset()` [peripherals/gpio.ts:171] ustawia WSZYSTKIE piny
na floating input - brak jakichkolwiek strapów. Maszyna nie ma pojęcia o
trybie bootu; `run()` [core/machine.ts:251] zawsze startuje szkic. Brak
`weak-low` w modelu napędu (tylko float/push/weak-high/pwm).

**Luki.**
1. Brak strapów: digitalRead(GPIO0) w resecie = 0, a na sprzędzie = 1.
2. Brak GPIO15 pull-down.
3. Brak wykrywania trybu bootu - szkic startuje nawet gdy pin 0 trzymany w
   GND (na sprzędzie: wejście w bootloader, szkic NIE rusza).

**Plan.** `DriveState` += `weak-low`; `PinState.strap: 'pullup'|'pulldown'`;
reset(): piny 0,2 -> INPUT_PULLUP (tryb z pull-upem jak na sprzędziu po
resecie - uwaga: rdzeń Arduino po starcie i tak przesterowuje tryby, więc
strap żyje do pierwszego pinMode), pin 15 -> input+strap pulldown.
`Esp8266Machine.bootMode()` : 'flash'|'download'|'no-boot'|'crash-gpio2'
ustalany w run()/resecie przez rozwiązaney obwód (przycisk trzymający GPIO0
w GND realnie blokuje boot). Tryb != 'flash': szkic nie startuje
(faza 'loaded'), na serialu komunikat boot ROM-u. Normalny boot cichy
(testy liczą linie seriala - nie spamujemy).

**Status.** DONE 2026-09-19. `PinPull` + `DriveState weak-low` w gpio.ts,
strapy w `reset()`/`defaultPull()`, `setMode` zdejmuje strap przy każdym
pinMode (potwierdzone testem). `Esp8266Machine.bootMode()` + `sampleBootMode()`
(jednorazowe `netlist.resolve()` - nie rusza cache'u P1.1), `run()` w trybach
innych niż 'flash' drukuje komunikat ROM-u i zostawia fazę 'loaded'.
Testy: `tests/bootmode.test.ts` (8), `tests/gpio.test.ts` (+3). Dwa stare
aserty zmienione świadomie (GPIO2 po resecie = weak-high, nie float -
sprzeczne z datasheetem). Uwaga: `pinMode(INPUT)` na strapie go wyłacza.

---

# F1.2 Ograniczenia elektryczne: 12 mA/pin, abs. max, palenie pinu

**Spec [DS].** Max 12.8 mA source i sink na GPIO; suma ~48.8 mA. Napięcie
na pinie poza [-0.3, VDD+0.3] uszkadza pin (5 V na wyjściu = uszkodzenie).
Przewymażenie prądowe: najpierw degradacja (spadek poziomu, "niestabilność"),
przy dłuższym prądzie ~kilkukrotnym - trwałe uszkodzenie wyjścia.

**Kod.** Netlist liczy prądy LED/semis (BURN_MA=50 dla LED) i zgłasza
`short`/`contention`/`overcurrent` [peripherals/netlist.ts:491+], ale:
1. Brak ograniczenia na poziomie PINU MCU (12 mA) - pin może oddawać
   dowolny prąd przez np. rezystor 100R do masy (33 mA) bez żadnej reakcji.
2. Brak limitu sumy prądów chipa.
3. Brak uszkodzenia pinu (damage) - błąd 5V na wejściu zniesiony tylko jako
   "short" w faultach; pin dalej działa.
4. Brak akumulacji czasu przewymażenia (model "spalenie po czasie").

**Plan.** Netlist: atrybucja prądu gałęzi do pinu MCU źródła/sinka
(istnieje `at` w reachSources -> pin terminal). `ResolveResult.pinCurrent:
Map<gpio, mA>` + progi: >12.8 mA fault 'warn' (przewymażenie),
>~30 mA fault 'overcurrent'. Maszyna: akumulator czasu przeciążenia per pin
(w advance), >1 s przy >2x limitu -> `gpio.damage(gpio)`; uszkodzony pin:
stan float na stałe (przeżywa reset(), API `clearDamage()`), digitalRead
czyta float. Osobno: silne źródło >3.6 V (rail 5V) bezpośrednio na pinie sygnałowym
(< 100 Ω) -> natychmiast damage + fault "abs max exceeded".
Suma > 48.8 mA -> fault 'overcurrent' "total GPIO current" (brownout model).

**Status.** DONE 2026-09-19. Netlist: `ResolveResult.pinCurrent` (atrybucja
prądów gałęzi LED/semis do pinów MCU przez `src.at`/`snk.at`), fault 'warn'
>12.8 mA, 'overcurrent' >25.6 mA i >48.8 mA sumy; `overvoltPins` (silne
>3.6 V na 0-omowej sieci pinu) + fault "absolute maximum". Maszyna:
akumulator `pinStress` w `advance()` (przeciążenie × czas; 1000 ms ->
`gpio.damage()`), over-volt = natychmiast. `GpioBus.damage/isDamaged/
damagedPins/clearDamage`: pad = float na stałe, przeżywa reset(), write/
setMode/analogWrite no-op; uszkodzone piny dostają trwały fault w
`resolveCircuit`. OGRANICZENIA (udokumentowane): prąd liczy się tylko dla
gałęzi LED/semis (cewka relay i buzzer bez modelu prądowego); 5 V przez
szeregowy rezystor nie flaguje over-voltu (solver liczy napięcia po
rezystorach osobno), 5 V drutem - flaguje i zabija.
Testy: `tests/electrical.test.ts` (6).

---

# F1.3 Elementy zewnętrzne: diody LED (Vf) i drganie styków

**Spec.** Dioda LED: spadek progowy Vf zależny od koloru (czerwona ~1.8-2V,
niebieska/zielona ~2.8-3.2V). Przycisk mechaniczny: drganie styków
5-15 ms przy zamknięciu/otwarciu (kilka do kilkunastu zboczy).

**Kod.** LED ma `forwardV` (domyślnie VF_DEFAULT=2 V) używane w prawie
Ohma [netlist.ts resolve LED sekcja] - OK, ale bez domyślnej tabeli kolorów
(param jest, GUI go nie wystawia? - sprawdzić ComponentDialog). Przycisk:
`switches` dwustanowy, zero drgania. Testy interrupt traktują przycisk jako
idealny (oczekują dokładnie 1 zbocza na naciśnięcie).

**Plan.** Vf: tabela per kolor (`color` parametr: red 1.8, green 2.1,
blue/white 3.0, yellow 2.0) gdy brak jawnego forwardV. Drganie: parametr
`bounce` ms; model deterministyczny - zmiana stanu przycisku inicjuje okno
drgan liczone według czasu wirtualnego; `advanceTime` wykrywa przejścia
i podbija `version` (cached resolve musi widzieć drganie).

**Status.** DONE 2026-09-19. Netlist: `VF_BY_COLOR` (red 1.8, orange 1.9,
yellow 2.0, green 2.1, amber 2.0, blue 3.0, white 3.1, ir 1.4), jawny
`forwardV` wygrywa; `color` w ComponentDialog + tint świecenia w rendererze.
Drganie: `chatter` per przycisk {target, from, lenUs, startUs}, segmenty
[make .25 | break .25 | make .2 | break .3] × bounce, stabilizacja po oknie;
`advanceTime(dtUs)` prowadzi `nowUs`, podbija `version` na każdym zboczu
styku; `resetTime()` (run/reset maszyny) kasuje okna. Domyślne `bounce`:
przycisk z palety/GUI 1 ms, przyciski autowire 1 ms, komponenty bez parametru
0 (testy historyczne zostają idealne - świadoma decyzja, nie luka).
Udokumentowane scalanie: zbocza w obrębie jednego `advance()` dają jedno
wejście ISR (jak zajęty MCU gubiący impulsy z rzędu). Przy okazji:
zaimplementowany `digitalPinToInterrupt()` (tożsamościowy na ESP8266).
Testy: `tests/debounce.test.ts` (8).

---

# F2.1 Przerwania zewnętrzne

**Spec.** Zbocza narastające/opadające/zmiana; ISR wywłaszczający główny kod
w dowolnym momencie (sprzętowo ~kilka cykli opóźnienia). noInterrupts()
blokuje wejście w ISR (obsługa w kolejce czeka).

**Kod.** attachInterrupt/detachInterrupt, tryby CHANGE/FALLING/RISING
[machine.ts:1138, checkInterrupts:899]. ISR na osobnej "isr lane" -
startuje TYLKO gdy main stoi w delay() (`step()` warunek `mainSuspended`)
[dokumentowane odstępstwo w nagłówku]. Brak opóźnienia sprzętowego.
noInterrupts/interrupts = no-op [machine.ts:1324].

**Luki (zgodnie z zadaniem).**
1. Brak wywłaszczenia: pętla bez delay() nigdy nie obsłuży przerwania.
   Generator pozwala: punkt wywłaszczenia = każdy yield interpretera.
2. Brak latencji ISR (modelowo 2 us: ~40 cykli @80MHz + save context).
3. noInterrupts nie blokuje wejścia.

**Plan.** `runGen(main)`: przy każdym yield sprawdzaj `isrQueue` (jeśli
`interruptsEnabled`) -> odłóż main, odpal isrGen, po ISR wróć do main
(generator zachowuje stan). Latencja: `scheduleWake(ISR_LATENCY_US)` zamiast
0 w checkInterrupts/timer/ticker. `interruptsEnabled=false` -> ISR tylko do
kolejki, odpalane po `interrupts()`.

**Status.** DONE 2026-09-19. `isrQueue: {fn, at}[]` - wpis gotowy po
`ISR_LATENCY_US = 2` µs; latencja wymuszana per wpis, nawet gdy main yielduje
wcześniej. `step()` startuje ISR bez wymogu `mainSuspended` (wywłaszczenie w
dowolnym punkcie), `runGen` oddaje sterowanie przy każdym yield (tick i delay),
gdy ISR gotowy. `noInterrupts()` maskuje wejście (krawędzie zostają w
kolejce), `interrupts()` odblokowuje i kopie lane. Pending-bit: drugi krawędź
tego samego fn scala się w kolejce (przycisk drgający z maską = 1 ISR, nie N).
Timer0/1 i Ticker idą tą samą kolejką z latencją. Odstępstwo (wdrukowane w
nagłówek machine.ts): wywłaszczenie na punktach yield generatora, nie w środku
instrukcji.
Testy: `tests/irq.test.ts` (6); stare testy przerwań przeszły bez zmian.

---

# F2.2 EEPROM = sektor Flash, limity cykli

**Spec [DS flash].** ESP8266 nie ma EEPROM. Rdzeń emuluje: 1 sektor flash
4 KiB, RAM-image + `commit()` = erase sektora + zapis = 1 cykl P/E.
Wytrzymałość 100 000 cykli P/E. Odczyty nieograniczone (retencja 10 lat).

**Kod.** `eepromCall` [machine.ts:418]: płaski Uint8Array(4096), write
natychmiast mutuje "flash" (brak RAM-image + commit!), commit = czysto
kosmetyczne liczydło `eepromDirty`, brak cykli, brak granicznego zużycia.

**Luki.** 1. write() bez commit() nie może być "cofnięte" restartem (na
sprzędziu dane w RAM-image przepadają). 2. Brak licznika cykli P/E i
progu 100k. 3. commit() nie konsumuje cyklu / nie zachowuje się jak
erase+write.

**Plan.** Struktura `flash = { cells: Uint8Array, image: Uint8Array,
cycles, worn }`. write/writeX -> tylko image. commit(): if worn -> 0;
cycles++ ; cells := image; true (zawsze erase+write całego sektora -
zgodnie z rdzeniem). begin(): cells z flasha. readX czyta cells.
Po commit > 100_000 -> worn: commit zwraca 0, zapisy nie utrwalają się.
`eepromStats()` API. Persist przez save/restore zostaje (to projekty).
Testy: red = restart kasuje niezcommitowane / 100001 commit zwraca 0.

**Status.** DONE 2026-09-19 (źródła rdzenia ściągnięte do `.ref/eeprom_*`).
`eeprom` = komórki flash (4 KiB sektor, przeżywa restarty, to persistuje
save/restore); `eepromImage` = wolutylny mir RAM tworzony przez `begin()`
(rdzeń przy każdym begin() wczytuje sektor od nowa - tak samo tu). `write`
oznacza brud tylko przy zmianie baita (rdzeń: `if (*pData != value)`),
`commit()`: czysty mir -> 1 bez cyklu P/E (rdzeń: `if(!_dirty) return true`),
brudny -> `eepromCycles++` i `cells := image`; po wyczerpaniu
`EEPROM_MAX_CYCLES = 100_000` commit zwraca 0 i nic nie zapisuje
(`eepromWorn`). `erase()` = RAM-side (wymaga commitu). API maszynowe:
`eepromStats() {cycles, worn, modified}`, `eepromSetCycles(n)` (test/diag).
Mir spada przy halt/run (wolutylny). Odstępstwa: odczyt bez begin() dozwolony
(rdzeń zwraca 0), `length()` stałe 4096 (rdzeń: rozmiar z begin()).
Testy: `tests/eeprom.test.ts` +6 (11/11); F6 bez zmian.

---

# F2.3 Watchdog (SW + HW)

**Spec [core Esp.cpp].** Soft WDT ~6.3 s: karmiony przy powrocie do
schedulera (delay, yield, koniec loop). ESP.wdtFeed() karmi;
wdtDisable() zatrzymuje soft (komentarz rdzenia: nie dłużej niż 6 s, bo
zadziała HARD WDT ~6.3 s). Reset: "wdt reset" + reboot,
ESP.getResetReason() = "Software/Hardware Watchdog".

**Kod.** `ESP.wdtFeed` = no-op [machine.ts:1416]. Brak WDT, brak
getResetReason, brak reset reason. restartRequested -> run() bez powodu.

**Plan.** Stan `wdt = { softEnabled, softDeadline, hardDeadline, reason }`.
Punkty nakarmienia: podjęcie loopOnce, suspend delay, ESP.wdtFeed.
Timer kontrolny w step()/advance: przekroczenie deadline ->
`wdtTrip(kind)`: serial "wdt reset" banner, reason zapisany (przeżywa
run() jako rejestr reset-info), restart szkicu. ESP.wdtDisable -> tylko
hard. ESP.wdtEnable(ms) restartuje soft. getResetReason/getResetInfo.
Test: loop bez delay -> po ~6.3s wdt reset, licznik bootów w EEPROM
rośnie, getResetReason() zwraca "Software Watchdog".

**Status.** DONE 2026-09-19. Model: `wdtDeadline` (µs wirtualne) +
pojedyncze zadanie zegara; karmienie (powrót loopOnce, suspend delay,
ESP.wdtFeed) to przydanie liczby - zero operacji na clock przy gorącej
ścieżce (Clock.clear jest O(heap); pierwsza implementacja z clear+setTimeout
na każdą iterację loop zrobiła kwadratowy czas ścian w tests/resilience).
Wygaśnięcie deadline: faza != running / restartRequested / deep-sleep ->
cisza; main w delay -> przedłuż (delay karmi w rdzeniu); budżet yield
wyczerpany a szkic choć raz karmił przez ESP.wdtFeed -> przedłuż
(deviacja: artefakt cięcia CPU hosta nie może zabić programu, który karmi;
prawdziwy spin-lock bez karmienia nadal tripuje). Trip: reason latch
("Software Watchdog" / po wdtDisable "Hardware Watchdog"),
restartRequested -> advance() dokańcza reboot; run() zatrzaskuje
bootReason i tylko przy watchdog drukuje banner "wdt reset" (normalny boot
cisza - stare testy liczby linii). ESP.restart -> "Software System Restart",
wake z deep-sleep -> "Deep-Sleep Awake"; getResetReason/getResetInfo ->
bootReason bieżącego bootu. WDT rozbraja się przy deep-sleep i halt().

---

# F2.4 Przetwornik ADC (TOUT, A0 Wemos D1 mini)

**Spec [DS].** TOUT: 10-bit SAR, pełna skala 1.0 V, nieliniowość < ~0.25 V.
Sam chip nie ma dzielnika. W zadaniu: model Wemos D1 mini z wbudowanym
dzielnikiem A0 -> skala 0-3.3 V. UWAGA (oznaczyć użytkownikowi): znane
schematy D1 mini prowadzą A0 bezpośrednio na TOUT (zakres 0-1 V);
dzielnik (4:1, ~220k/52k) mają NodeMCU v3 [DS~ - nie udało się pobrać
schematu; teza użytkownika przyjęta jako spec zadania, odwzorowana jako
atrybut boarda, nie jako prawda o chipie].

**Kod.** `analogRead` [machine.ts:1079]: `round(v/3.3*1023)` - stały
przelot 3.3V na KAŻDYM boardzie, brak dzielnika w modelu boarda, brak
nieliniowości dolnego zakresu, float -> 0.

**Plan.** boards.ts: `adc: { chipFullScaleV: 1.0, divider: {series, shunt} | null }`;
oba boardy (wemos-d1-mini wg specu zadania, nodemcu-v3 fizycznie) dostają
dzielnik dobrany tak, by 3.3 V na A0 dawało 1.0 V na TOUT (szereg 230k,
równoległy 100k -> podział 1/3.3). Maszyna: analogVolts(A0) -> napięcie TOUT
przez dzielnik -> krzywa chipa: <0.25 V skompresowana (model liniowy
z offsetem), >= 1.0 V -> 1023; wynik 0..1023. Bez dzielnika: v/1.0.
Test: 1.65V na A0 (wemos) -> ~515 (3.3*515/1024=1.658), 0.66V -> ~206
(0.2V < 0.25 nieliniowość -> 206 skompensowane wg modelu),
1.0V TOUT saturacja.

**Status.** DONE 2026-09-19. `Board.adc = { chipFullScaleV: 1.0,
divider: {230k, 100k} }` (stała ADC_0_TO_3V3, oba boardy; komentarz
oznacza [DS~]: prawdziwe rewizje D1 mini prowadzą A0 prosto na TOUT -
dzielnik to atrybut boarda ze specu zadania, nie cecha chipa).
`adcChipCurve(vTout, fs)` [machine.ts]: >= fs -> 1023; < 0.25*fs ->
kwadratowa kompresja 1023*knee*(v/knee)^2 (dokładnie ciągła z liniową w
knee: 0.25 V -> 256); poza tym liniowa. analogRead: A0 -> dzielnik ->
krzywa. Uwaga do planu testu: przy dzielniku 1/3.3 skala A0 jest liniowa
0..3.3 V, więc różnica vs stary model widać dopiero w paśmie martwym
(0.66 V na A0: stary 205, model 164; 0.33 V: 102 vs 41) - testy
tests/adc.test.ts dokładnie to mierzą.

---

# F2.5 Timery sprzętowe

**Spec [core].** Timer0 = CCOUNT0, zarezerwowany przez stos WiFi (używanie
go z włączonym WiFi = konflikt). Timer1: 23-bit counter, dzielnik
/256 (0.125 us * 256 = 32 ns/tick? NIE: 12.5 ns * 256 = 3.2 µs/tick
przy 80 MHz) - max okres 0x7FFFFF * 3.2 us ≈ 26.7 s? Sprawdzić: rdzeń
timerAlarmWrite przelicza us na ticki: timer1: ticks = us * 0.3125?
[core_esp8266_timer.cpp: timer1_enable divider 256; 80MHz/256=312.5kHz
=> 1 tick 3.2us; max 0x7FFFFF*3.2us = 26.7s]. Timer0 max: 32-bit CCOUNT
80MHz? [core: ccompare0, ticks = us*80? -> max ~53s].

**Kod.** `timerAlarmWrite/Enable/Disable` [machine.ts:1345-1376]: okresy w
prostych µs na Clock, timer0 i timer1 traktowane identycznie, brak
rezerwacji timer0, brak limitów długości, ISR `timerNISR` w isrQueue.

**Plan.** (a) timer0 zastrzeżony: gdy radio aktywne (WiFi.begin rzucony /
lanLive) -> `timerAlarmEnable(0)` zwraca 0 + serial ostrzeżenie
"timer0 reserved by WiFi stack"; działa gdy WiFi off. (b) timer1: clamp
okresu do 26.7 s (23-bit), timer0 bez clampa rozsądnego;
(c) tick taktowany z Clock (już jest) - doliczyć: ISR timera też przez
latencję ISR i wywłaszczenie z F2.1.

**Status.** DONE 2026-09-19. `radioActive()` = WiFi.begin rzucony
(connectAt != null, do disconnect()) albo lanLive (WebServer.begin).
timerAlarmEnable(0) przy aktywnym radiu: serial "timer0 reserved by
WiFi stack", zwrot 0, brak uzbrojenia; po WiFi.disconnect() timer0
wolny. timerAlarmWrite(1): clamp `TIMER1_MAX_PERIOD_US` = 0x7FFFFF *
3.2 µs = 26 843 542 µs (23-bit /256 [core timer.cpp]). ISR timera
korzysta z kolejki F2.1 (latencja 2 µs + wywłaszczenie) - bez zmian.
Testy: tests/timers.test.ts (6).

---

# F2.6 WiFi: stany STA i AP

**Spec rdzenia.** WiFi.mode(WIFI_STA/AP/AP_STA/OFF); softAP() podnosi AP
(status AP osobny od statusu STA); getMode() zwraca maskę; WL_CONNECTED
dotyczy asocjacji STAn. softAPIP() = 192.168.4.1.

**Kod.** [machine.ts:1436+]: WiFi.softAP/mode/softAPConfig = `return 1`
(no-op, bez stanu). status() = tylko STA (join 1.5s). Brak getMode, brak
stanu AP, brak softAPgetStationNum. LAN (serwery) działa niezależnie od
stanu radia (brak zależności - serwer nasłuchuje nawet bez WiFi).

**Plan.** `radio = { mode, apUp, apUpAt, ssid }`. WiFi.mode(m) ustawia;
WiFi.softAP(ssid): mode |= AP, AP wstaje po 300 ms; WiFi.status(): STA
zassociowany -> WL_CONNECTED; AP-only po starcie -> WL_CONNECTED
(odstępstwo od rdzenia - odnotować; user wymaga "prawidłowych flag w AP").
WiFi.getMode(); disconnect() gasi STA; tryb OFF zdejmuje rejestrację LAN
i blokuje connect()/server.begin() (fault "radio off"). Serwer/HTTP:
wymagają STA-connected lub AP-up (test: begin() przed joinem -> brak
trasowania w LAN).

**Status.** DONE 2026-09-19. `wifi.mode` (maska bit1 STA / bit2 AP),
`wifi.apAt` (softAP wstaje po 300 ms). begin() implikuje STA, softAP()
implikuje AP; WiFi.mode(m) gasi interfejsy poza maską (OFF = oba);
WiFi.getMode(); softAPdisconnect(). Dwa odstępstwa od planu/rdzenia,
oba wymuszone przez istniejące kontrakty:
1. Flaga WL_CONNECTED z AP działa TYLKO w trybie czystym AP
   (maska bez bitu STA). W AP_STA status() zostaje asocjacjowo-
   stażowy jak w rdzeniu - szkic roleta czeka przez status() na
   asocjację i z odstępstwem wychodził z pętli po 300 ms z
   localIP 0.0.0.0 (test 'IP address: 192.168.1.150').
2. Serwery LAN NIE są bramowane stanem radia (plan zakładał
   begin() po joinie). Kontrakty web-f5/examples: ser.begin() bez
   zadnego WiFi i obsługa żądań - 20+ testów. softAPIP() za to
   oddaje 0.0.0.0 gdy AP leży (testowalne życie interfejsu).
softAPgetStationNum() = 0 (klientów AP nie symulujemy).
Testy: tests/wifi-ap.test.ts (6).

---

# F3.1 Silnik DC w outputs (życzenie użytkownika 2026-09-19)

**Model.** Typ `motor`, piny `+`/`-` (footprint jak buzzer). Obciążenie
dwukierunkowe: para source/sink wg konwencji netlisty (1,65 V); większa z
dwóch możliwych różnic potencjałów wygrywa -> kierunek. Uzwojenie =
`rOhms` (domyślnie 50 R), spadek szczotek 0,3 V, rozruch od 0,6 V skutecznych.
`rpm = rpmPerV (2000) * (V_skuteczne - 0,3)`; duty PWM skaluje prąd i obroty
(jak jasność LED). Brak siły przeciwelektromotorycznej w czasie - prąd to
prąd zwarciowy uzwojenia (najgorszy, grzewczo uczciwy; odstępstwo
odnotowane). Stan w `ResolveResult.motors` {spinning, dir, rpm, currentMa};
prąd księgowany do budżetu F1.2 na obu końcach -> silnik prosto na pinie
(60 mA) to fault overcurrent, tak jak cewka przekaźnika. MOSFET/5V:
(5-0,3)/(50+10) = 78 mA, bramka czysta. GUI: paleta Outputs, symbol z
obrotowym wałem i odczytem rpm/CW/CCW, dialog: rOhms + rpmPerV.
Testy: tests/motor.test.ts (7).

---

# F3.2 Etykiety komponentów + autonazewnictwo Auto-wire (życzenie użytkownika 2026-09-19)

**Spec.** Każdy komponent schematu może mieć `label` (pole dokumentu, nie
parametr elektryczny - do netlisty nie trafia). Rysowana pod obrysem
komponentu (podpis przycisku, diody...); edycja: dwuklik / klawisz P ->
dialog właściwości ma pole "Label" dla KAŻDEgo typu (dawniej typy bez
parametrów nie dawały się otworzyć sensownie). Round-trip przez
toJSON/fromJSON; walidator dokumentu odrzuca nie-łańcuchowe label.

**Auto-wire.** planFromSketch już rozwiązuje aliasy (#define, const int) -
teraz zapamiętuje też token, z którego rozwiązano pin. Jeśli token jest
identyfikatorem (nie literałem D4/2/A0), trafia jako `label` do części
planu, a buildFromPlan na część funkcjonalną (LED w łańcuchu, nie rezystor;
przycisk; DHT; pot; servo/neopixel/hcsr). Literały -> brak etykiety.
Zachowana kompatybilność: bez etykiety pole `label` nie istnieje (stare
asercje toEqual przechodzą).

**Kod.** schematic.ts: PlacedComponent.label?, setLabel()+touch, isComp
sprawdza typ; renderer.ts: rysowanie pod body (labelAt + kolor C.silk);
ComponentDialog: input Label, Apply aktywny zawsze; examples.ts: helpery
dostają opcjonalny label; autowire.ts: PlannedPart.label? + mapy tokenów.
Testy: tests/schematic.test.ts (3 nowe) + tests/autowire.test.ts (4 nowe).
**Status: DONE** (commit db3a5a3; 560 testów na zielono). Deviacja: dialog otwiera się
dla każdego typu także bez parametrów (kiedyś Apply był tam martwy) - aby dało
się nadać etykietę dowolnemu elementowi.

---
# F3.3 Przeglądarka panelu HTTP: pełny webserver szkicu (życzenie użytkownika 2026-09-19)

**Spec.** Dotąd HTTP-odpowiedzi szkicu dało się tylko wywoływać (GET/POST z
formularza panelu) - serwer WebServer szkiców roletowych (linki /UP, /STOP,
/TARGET?value=X, formularze) nie miał jak "otworzyć". Panel HTTP dostaje
widok Page: odpowiedź z ciałem HTML renderowana w iframe (srcDoc,
sandbox="allow-same-origin" - bez skryptów, zero XSS w aplikację); klik w
<base href>-zględny link i submit <form> idą przez te same co dotąd
wywołania LAN (każdy host wirtualnej LAN odpowiada, F10). Historia wstecz w
pamięci sesji. Log (dotychczasowy widok) zostaje.

**Status: DONE** (2026-09-19; 569 testów). Sandbox iframe: brak skryptów
ze strony szkicu (brak JS w roledze), klik i submit wiringuje rodzic.

**Kod.** gui/webview.ts (czyste, testowalne): resolveHref (base+href ->
absolutny http(s) albo null dla javascript:/mailto:/#frag), looksHtml
(detekcja po ciele), formRequest (method/action/pola -> {method,url,body},
www-form-urlencoded). HttpPanel: toggle Log|Page, iframe + podsłuch
click/submit wdokumencie srcDoc, wstecz. Testy: tests/webview.test.ts.

---
# N1 Kopie `examples/*.ino` + straznik swiezosci (naprawa 1 z 6, commit F1)

**Spec.** Dwa przyklady w repo to kopie firmware lezacego poza repo
(`../Rolety/*.ino`). Testy mogly chodzic na nieaktualnym firmware byc zielone:
kopia v20 roznila sie od zrodla 89 liniami, a `roleta-v20.test.ts` to
przechodzil. Symlink odpada (dangling link w checkout bez katalogu `Rolety/`
rozwalilby `vite build`), wiec: kopia + manifest hashy + test strazniczy.

**Status: DONE** (2026-09-25; 576 testow).

**Kod.** `scripts/sync-examples.mjs` (`readManifest/inspect/sync`, CLI z
`--check`) + `examples/sync-manifest.json` (sciezka zrodla i sha256 kopii z
ostatniego syncu). Trzy niezalezne kontrole wiersza: `copyDrift` (kopia !=
manifest, zawsze fatalna, zrodlo niepotrzebne), `stale` (zrodlo != manifest),
`copyMissing`; brak zrodla = skip, nigdy fail. `pretest` odpala `--check`,
wiec `npm test` nie przejdzie na swiezym zrodle bez syncu;
`npm run sync:examples` nadpisuje kopie i przepisuje hashe. Testy:
`tests/examples-sync.test.ts` (strazniki na prawdziwym repo + test mechanizmu
na fixture w /tmp). Manifest seeduje sie hashem KOPII, nie zrodla - inaczej
realny defekt klasyfikuje sie jako DRIFT zamiast STALE.

---
# N2 Model latencji i awarii kolegi w LAN (naprawa 2 z 6, commit F2)

**Spec.** Wirtualna LAN byla binarna: zarejestrowany host odpowiadal w 0 us,
niezarejestrowany dostawal -1 natychmiast. Prawdziwy ESP8266 wisi w
`connect()`/odczycie do wlasnego `setTimeout()` i zna stan "zyje, ale wolno".
Brakowalo inzynierii bledów widocznej dla szkicu, nie tylko dla panelu.

**Status: DONE** (2026-09-25; 586 testow).

**Kod.** Tabela wad lacza mieszka w `Lan` (klucz = host tak jak go zapisano,
plus rozwiązywany mDNS -> IP); przezywa restart kolegi, znika przy `unregister`.
API: `setPeerLatency(host, ms)` (round-trip, o ktory blokujey klient),
`setPeerUnreachable(host)` (ramki gina, kolega w ogole nie widzi zadania,
klient pali caly `setTimeout()`), `setPeerDown(host)` (connection refused,
fail za 0 ms), `clearImpairments(host)`, `impairmentFor(host)`; facade maszyny
pzekazuje wywolania. `httpCall` GET/POST liczy `elapsed` z wady lacza (nie z
iteracji pumpa) i zwraca `{ suspend:{kind:'delay',us}, value }`, wiec zegar
KLIENTA idzie o tyle samo co zegar kolegi - `millis()` w szkicu widzi zator.
Zdrowe lacze zostaje darmowe (0 ms): tak bylo udokumentowane i na tym trzymaly
sie istniejace testy. `lanFetch` (panel GUI mowiacy do INNEGO czipu) tez
respektuje wade; `fetchHttp` (konsola wlasnego czipu) nie - to polaczenie
lokalne, nie przez drut. Swiadome odstepstwo: niezarejestrowany host wciaz
dostaje -1 natychmiast (gdyby wisial do timeoutu, `web-f5` odpalalby 3x5000 ms
w `setup()`); do modelu "wisi i wisi" sluzy `setPeerUnreachable`. Testy:
`tests/net-impair.test.ts` (10: 300 ms -> 200 po ~300; 3000 ms -> -1 dokladnie
po 1500, a kolega i tak obsluzyl zadanie; unreachable -> -1 po 1500 i zero
trafien na serwerze; down -> -1 za ~0 ms; heal; per-host; mDNS; sprzatanie po
dispose; facade).

---
# N3 Znikajacy punkt dostepowy (naprawa 3 z 6, commit F3)

**Spec.** WiFi bylo stoperem: `begin()` zawsze konczyle sie 1.5 s pozniej,
wiec zaden szkic nie dal sie pokazac jako niepolaczony, a petla ratunkowa
`while (WiFi.waitForConnectResult() != WL_CONNECTED)` albo przechodzila, albo
zawieszala interpreter na zawsze.

**Status: DONE** (2026-09-25; 596 testow).

**Kod.** `Esp8266Machine.setWifiDown(true|false)` - warunek srodowiska, nie
stan czipu, wiec przezywa `run()` i `ESP.restart()`. `staUp()` (nowe, jedyny
interpreter "czy lacze zyje") liczy `connectAt !== null && !wifiDown &&
now >= connectAt`; `isConnected`, `status`, `localIP` i `apUp` pytaja wlasnie
jego. `deliver()` i `fetchHttp` przy awarii odrzucaja zadania - czip bez
radia nie obsluguje nikogo, wiec klient wypala caly wlasny timeout.
`waitForConnectResult(t)` dostal semantyke rdzenia: pytaj `status()` az do
`WL_CONNECTED`, a po wlasnym timeout zwróc `WL_DISCONNECTED` (6). Zeby to
dzialalo bez wieszania interpretera, `HostResult` ma `again`: host moze
zaparkowac kawalek czasu (50 ms) i poprosic o ponowne wywolanie z tymi
samymi argumentami; petla jest w jednym miejscu `interp.ts` (jedyne
`env.call`), a z `again` korzysta tylko to jedno wywolanie - musi byc
idempotentne. Powrot punktu dostepowego kosztuje nowa asocjacja (1.5 s) albo
nowy bring-up AP (300 ms) - radio nie wznawia polowy polaczenia. Testy:
`tests/wifi-down.test.ts` (10: link w dol i w gore; join started w czasie
awarii nigdy sie nie konczy; `waitForConnectResult(2000)` zwraca 6 dokladnie
po 2000 ms a sketch drukuje "alive"; zaparkowany join konczy sie po powrocie
AP; petla `while(...) != 3` tyka zamiast stac; soft-AP; zdjecie awarii,
ktorej nie bylo, nie rusza lacza; awaria serwera kosztuje klientow caly
timeout; panel HTTP milczy; kryterium: blink+HTTP miga przez cala awarie i po
powrocie AP drukuje link 1, IP i http 200).

---
# N4 32-bitowy uplyw czasu (naprawa 4 z 6, commit F4)

**Spec.** `millis()` i `micros()` zwracaly nieskonczone `double` - licznik
czipu nigdy sie nie przepeinia, wiec klasyczny bug "po 49 dniach stanelo" byl
w emulatorze niewidoczny, a cala szkola `millis() - t0 >= X` nie miala
zadnego sensu do sprawdzenia. Glebiej lezal drugi blad: interpreter obcinal
kazda liczbe cala do `int32` przy przypisaniu, wiec `unsigned long t = millis();`
dawal -1500 zamiast 4294965796 - gorna polowa zakresu byla po prostu
nieosiagalna.

**Status: DONE** (2026-09-25; 606 testow).

**Kod.** `Clock.setNow(us)` przesuwa zegar bez odpalania timerow, a
`Esp8266Machine.setUptimeUs(us)` ustawia moment startu (nakladany po obu
`clock.restart()`, wiec przezywa `run()` i `reset()`) - to jedyny sposob, zeby
test nie czekal 49.7 dnia. Maska `% 2**32` stoi WYLACZNIE na granicy `env()`
(`millis`, `micros`); wewnatrz emulatora zegar zostaje pelnym licznikiem µs,
zeby `delay`, WDT i latencja LAN nie gubily precyzji.
Szerokosci typow sa teraz deklarowane: `intKindOf()` (interp.ts) z nazwy typu
liczy szerokosc i znak, `stampType()` wbija je w nowa komorke (deklaracje
globalna, lokalna, statyczna, parametr), `assignInto()` zawija wartosc do
szerokosci celu (`byte` 8 bitow, `word` 16, `unsigned long` 32 bez znaku), a
`operandsAreUnsigned()` sprawia, ze arytmetyka z operandem bez znaku tez sie
zawija - stad `millis() - t0` przez granice daje 1500, a nie -4294965296.
`>>` na wartosci bez znaku jest logiczny, na znakowej arytmetyczny. `millis()` i
`micros()` zwracaja wartosc unsigned, tak jak w rdzeniu. Parametry skalarnie
sa przez wartosc (kopia komorki); tablice (pointer) i `byRef` wciaz aliasuja.
Testy: `tests/millis-wrap.test.ts` (10: millis i micros przez granice;
wlasciwa arytmetyka modularna tyka rowno 1000 ms rowniez ZA granica;
`millis() >= t0 + 1000` gubi rytm i strzela seriami - emulator rozroznaje oba
zachowania; `delay` i scheduler dzialaja przez przepeinienie; start offset
przezywa reboot; szerokosci `byte`/`word`/`char`/`unsigned long`/`int`;
licznik `byte` przez 255; `100 - 200` w uint32; `>>` logiczny vs znakowy;
przekazanie przez wartosc).

Odstepstwa od sprzetu (wpisane do README): `long long` wciaz 32 bity;
porownanie `signed` z `unsigned` liczy sie jak w C na double, nie przez
konwersje znaku; GUI nie ma kontrolki uplywu czasu (API testowe wystarcza).

---
# N5 Probe na stany zakazane (naprawa 5 z 6, commit F5)

**Spec.** Emulator symulowal stan, ktorego fizyka nie pozwala przezyc: szkic
trzymajacy oba wejscia polmostka w HIGH dostawal dokladnie to, co napisal -
zwarcie uzwojen do masy - i nic o tym nie mowilo, choc prad pinu byl liczony.
Brakowalo sposobu, zeby powiedziec emulatorowi "ten stan nigdy nie ma prawa
wystapic" i dostac dowod, kiedy jednak wystapil.

**Status: DONE** (2026-09-25; 617 testow).

**Kod.** `core/invariants.ts` (nowy plik, czysta logika): `PinInvariant`
(`never: [[pin, poziom], ...]` + `label`), `matchPinInvariant()` zwraca
naruszenie albo null, `PinInvariantError` z gotowym komunikatem. Maszyna trzyma
`pinInvariants`, `invariantViolations` i flage `invariantStrict`;
`checkPinInvariants()` wywolywane jest z `case 'digitalWrite'` (natychmiast po
zapisie rejestru) oraz z `advance()` zaraz po `resolveCircuit()`, wiec probe
widzi rowniez pin poruszony przez uklad, nie tylko przez szkic. Nazwy pinow
idza przez `board.gpioFor()`, wiec dziennik mowi `D5`, a nie `14`; nazwa
nieznana nie pasuje nigdy. Wpis idzie raz na epizod (flaga `held`) -
trzymanie stanu przez sekunde nie generuje tysiaca rekordow - i kasuje sie przy
reboocie, bo to okno obserwacji, nie stan czipu. `invariantStrict` rzuca
`PinInvariantError`; `advance()` przepuszcza ten blad dalej (nie jest to blad
szkicu, wiec nie zmienia maszyny w `fault`). GUI: licznik w toolbarze
(`invariantBadge()` w App.tsx + `.banner-invariant`), ten sam interwal 250 ms
co banner zwarc; probe przypina sie z testu albo z konsoli `__emu`.
Testy: `tests/invariants.test.ts` (11: moment naruszenia z timestampem 250 ms;
cisza, gdy reguta nie zachodzi; jeden wpis na epizod; probe dolozony do juz
zlamanego stanu lapie nastepny krok zegara; strict rzuca i nie kolekcjonuje;
numer GPIO i 'GPIO12' obok 'D5'; nieistniejacy pin; reguta na LOW; zdjecie
probu; czyszczenie przy reboocie; licznik GUI).

Odstepstwa od sprzetu (wpisane do README): probe to przyrzad harnessu, nie
sprzetu - emulator sam z siebie zaden stan nie zabrania (zwarcie nadal plynie);
brak okna dialogowego do definiowania regul, zostaje konsola `__emu`.

---
# N6 Bench wielomaszynowy (naprawa 6 z 6, commit F6)

**Spec.** Testy byly jednomechanizmowe: latencja osobno, WiFi osobno, zwarcie
osobno. Zadne z nich nie odpowiadalo na pytanie, czy cztery czipy naraz - hub,
klient i dwóch sąsiadow, jeden wolny, jeden nieosiagalny - utrzymuja spojne
liczniki i zegary, i czy ktorys z nich nie wiesza interpretera.

**Status: DONE** (2026-09-25; 626 testow).

**Kod.** `tests/multi-machine.test.ts` (9 testow, bez zmian w rdzeniu): trzy
serwery + klient, jeden `HTTPClient` i trzy GET-y na iteracje petli, log
`kod,kod,kod,millis`. Bench jest napedzany zegarem klienta (`step()` rusza
tylko jego), wiec kolega dostaje tyle czasu, ile sam kosztowal - i wowczas
"daden czip nie moze wyprzedzic tego, na ktorego czekal" jest twierdzeniem,
ktore da sie sprawdzic. Aserty: rowny odstep rundy (400 ms latencji + wypalony
timeout + 20 ms szkicu), hub i wolny kolega obsluguja, nieosiagalny nigdy nie
jest w to wlaczony ale nadal sie starzeje, zegar wolnego kolegi = lacznie czas
laczny, brak faultow i postep w kazdym plastrze czasu, dwa identyczne przebiegi
daja identyczny log i identyczne zegary, probe F5 na pinach silnika zostaje
czysty, a po naprawieniu kolegi w polowie scenariusza zostaje on obsluzony bez
rebootu. Ostatni test tyka wszystkie cztery maszyny naraz (model GUI) - to
sciezka, ktora przy re-entrancji `pump()` moglaby dac rekurencje; nie daje.

Weryfikacja, ze bench gryzie: mutacja `elapsed = flight` -> `0` wywala 6 z 9
testow, mutacja ignorujaca `unreachable` wywala 6 z 9.

Odstepstwa: bench to test, nie funkcja GUI; wielomaszynowosc w GUI istnieje
osobno (zakladki urzadzen) i nie jest tu objeta asercjami.

---
# Dziennik zmian implementacji
- 2026-09-25 | Przegląd metodą: dokumentacja vs kod | 626/626 | README "Known limitations" opisalo piec rzeczy, ktorych nie mialo w nim byc: delay() w ISR (emulator wykonuje, sprzet wiesza), stany zakazane... zamiast tego: EEPROM (zuzycie 100k cykli liczy sie od F2.2, bullet byl starszy), ADC pływajacy = 0, limit 120 ramek rekurencji, show() NeoPixel bez kosztu czasowego. Zweryfikowane sondu, zero zmian w rdzeniu.
- 2026-09-25 | N6 bench wielomaszynowy (commit F6) | tests/multi-machine.test.ts 9x green; suite 626/626 | hub + klient + 2 poszkodowanych kolegow; bench kreci zegar klienta, wiec zegar kolegi = czas, ktory kosztowal; odstep rundy dokladnie 400+1500+20 ms; dwa przebiegi identyczne; tykanie wszystkich naraz bez re-entrancji; mutacje rdzenia wywoluja 6/9 bledow.
- 2026-09-25 | N5 probe na stany zakazane (commit F5) | tests/invariants.test.ts 11x red -> green; suite 617/617 | `addPinInvariant({never,label})` sprawdzany w `digitalWrite` i po kazdym `resolveCircuit()`; wpis raz na epizod (timestamp + stan pinow), kasowany przy reboocie; `invariantStrict` rzuca i `advance()` przepuszcza blad dalej; licznik w toolbarze.
- 2026-09-25 | N4 32-bitowy uplyw czasu (commit F4) | tests/millis-wrap.test.ts 10x red -> green; suite 606/606 | `millis`/`micros` maskowane `% 2**32` tylko na granicy `env()` (zegar wewnetrznie pelnym µs); `Clock.setNow` + `setUptimeUs` = start przy granicy zamiast czekania 49.7 dnia; `intKindOf`/`stampType`/`wrapInt` daja deklarowanym typom ich sprzetowa szerokosc (bez tego `unsigned long` nie miescil millis()); arytmetyka bezznakovowa zawija sie, `>>` logiczny; parametry skalarnie przez wartosc.
- 2026-09-25 | N3 znikajacy punkt dostepowy (commit F3) | tests/wifi-down.test.ts 10x red -> green; suite 596/596 | `setWifiDown` to stan srodowiska (przezywa run/restart); `staUp()` jedynym source of truth lacza; `HostResult.again` = parkuj i wywolaj ponownie (jedno `env.call`); `waitForConnectResult` zwraca 6 po wlasnym timeout zamiast wieszac interpreter; przy awarii czip nie obsluguje LAN.
- 2026-09-25 | N2 latencja/awarie kolegi w LAN (commit F2) | tests/net-impair.test.ts 10x red -> green; suite 586/586 | wady lacza w `Lan` per host, przezywa restart kolegi, kasowane przy unregister; `elapsed` liczony z wady lacza a nie z iteracji pumpa; suspend przesuwa zegar klienta; zdrowe lacze wciaz 0 ms; unregistered host wciaz -1 natychmiast (udokumentowane).
- 2026-09-25 | N1 kopie examples/*.ino + straznik (commit F1) | tests/examples-sync.test.ts 7x red -> green; suite 576/576 | kopia v20 rozjechana ze zrodlem o 89 linii wobec zielonego suite; manifest seedowany hashem KOPII; `pretest` = `sync-examples --check`; +@types/node (typecheck nie widzial node:*).
- 2026-09-19 F3.3 fix: panel HTTP sam podaza za IP czipu (sketch z WiFi.config() przepisywuje sie na .150 - pole URL i hint), komunikat "no response" podaje biezacy adres; zweryfikowane headless (Playwright): auto-IP, klik linkow, back.
- 2026-09-19 F3.3: widok Page w panelu HTTP - HTML serwera szkicu (rolema) renderowany w iframe sandbox, linki i formularze nawigują przez LAN; gui/webview.ts + 9 testów; 569 zielone.
- 2026-09-19 F3.2: etykiety komponentów pod symbolem (dialog Label, round-trip, walidacja) + Auto-wire podpisuje części nazwami stałych/zmiennych ze szkicu; 7 nowych testów, 560 zielone. commit db3a5a3

(format: data | komponent | test red -> zielony | uwagi)

- (start) audyt wykonany, plik utworzony, nic nie zmienione w kodzie.
- 2026-09-19 | F1.1 boot straps | tests/bootmode.test.ts 8x red -> green; suite 493/493 | przy okazji usunięty duplikat `case 'setReuse'` (warning esbuild).
- 2026-09-19 | F1.2 limity prądowe + palenie pinu | tests/electrical.test.ts 6x red -> green; suite 499/499 | model termiczny: 1 s przeciążenia = pad martwy; over-volt 5V drutem = natychmiast.
- 2026-09-19 | F1.3 Vf diody + drganie styków | tests/debounce.test.ts 8x red -> green; suite 507/507 | bounce oknem czasu wirtualnego (determ.); zbocza w jednym advance scalą się do 1 ISR; +digitalPinToInterrupt.
- 2026-09-19 | F2.1 przerwania: wywłaszczenie + latencja 2 us + maska | tests/irq.test.ts 6x red -> green; suite 513/513 | ISR startuje przy yield głównego kodu (busy loop też); pending-bit scala krawędzie; timer i Ticker wspólną kolejką.
- 2026-09-19 | F2.2 EEPROM = sektor flash: mir RAM + cykle P/E | tests/eeprom.test.ts 5x red -> green; suite 519/519 | commit czystego = bez cyklu; 100001 commit = 0 i worn; erase RAM-side; eepromStats/eepromSetCycles.
- 2026-09-19 | F2.3 watchdogi SW+HW 6.3 s + reset reason | tests/wdt.test.ts 5x red -> green; suite 526/526 | deadline-model (karmienie bez clock ops; clear+setTimeout na iterację = kwadratowy czas ścian); banner "wdt reset" tylko przy tripie; wyjątek głodzenia budżetu dla jawnego wdtFeed.
- 2026-09-19 | F2.4 ADC: dzielnik boarda + krzywa chipa 0-1V | tests/adc.test.ts 5x red -> green; suite 534/534 | Board.adc (230k/100k, fs 1.0V [DS~]); knee 0.25V kwadratowo, ciągłe w 256; dzielnik 1/3.3 = stara skala w zakresie liniowym, różnica tylko w paśmie martwym.
- 2026-09-19 | F2.5 timer0 zarezerwowany + timer1 23-bit | tests/timers.test.ts 5x red -> green; suite 540/540 | enable(0) z aktywnym radiem = 0 + ostrzeżenie serial; disconnect() oddaje timer0; clamp 0x7FFFFF*3.2us; lanLive (server.begin) też liczy się jako radio.
- 2026-09-19 | F3.1 motor DC w outputs | tests/motor.test.ts 7x red -> green; suite 553/553 | dwukierunkowe obciazenie 50R + szczotki 0,3V; księgowanie prądu do F1.2; GUI: paleta/symbol/dialog.
- 2026-09-19 | F2.6 stany radia STA/AP | tests/wifi-ap.test.ts 6x red -> green; suite 546/546; roleta-v20 wymusiła korektę | getMode/mode maska; softAP 300 ms; WL_CONNECTED z AP tylko w trybie czystym AP (AP_STA = rdzeń, roleta wait-for-join); softAPIP 0.0.0.0 gdy AP leży; LAN bez bramy radia (kontrakt web-f5).
