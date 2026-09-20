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

**Status.** TODO

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

**Status.** TODO

---

# Dziennik zmian implementacji

(format: data | komponent | test red -> zielony | uwagi)

- (start) audyt wykonany, plik utworzony, nic nie zmienione w kodzie.
- 2026-09-19 | F1.1 boot straps | tests/bootmode.test.ts 8x red -> green; suite 493/493 | przy okazji usunięty duplikat `case 'setReuse'` (warning esbuild).
- 2026-09-19 | F1.2 limity prądowe + palenie pinu | tests/electrical.test.ts 6x red -> green; suite 499/499 | model termiczny: 1 s przeciążenia = pad martwy; over-volt 5V drutem = natychmiast.
- 2026-09-19 | F1.3 Vf diody + drganie styków | tests/debounce.test.ts 8x red -> green; suite 507/507 | bounce oknem czasu wirtualnego (determ.); zbocza w jednym advance scalą się do 1 ISR; +digitalPinToInterrupt.
- 2026-09-19 | F2.1 przerwania: wywłaszczenie + latencja 2 us + maska | tests/irq.test.ts 6x red -> green; suite 513/513 | ISR startuje przy yield głównego kodu (busy loop też); pending-bit scala krawędzie; timer i Ticker wspólną kolejką.
- 2026-09-19 | F2.2 EEPROM = sektor flash: mir RAM + cykle P/E | tests/eeprom.test.ts 5x red -> green; suite 519/519 | commit czystego = bez cyklu; 100001 commit = 0 i worn; erase RAM-side; eepromStats/eepromSetCycles.
- 2026-09-19 | F2.3 watchdogi SW+HW 6.3 s + reset reason | tests/wdt.test.ts 5x red -> green; suite 526/526 | deadline-model (karmienie bez clock ops; clear+setTimeout na iterację = kwadratowy czas ścian); banner "wdt reset" tylko przy tripie; wyjątek głodzenia budżetu dla jawnego wdtFeed.
- 2026-09-19 | F2.4 ADC: dzielnik boarda + krzywa chipa 0-1V | tests/adc.test.ts 5x red -> green; suite 534/534 | Board.adc (230k/100k, fs 1.0V [DS~]); knee 0.25V kwadratowo, ciągłe w 256; dzielnik 1/3.3 = stara skala w zakresie liniowym, różnica tylko w paśmie martwym.
