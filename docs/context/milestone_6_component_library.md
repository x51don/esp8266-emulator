# Milestone 6 - biblioteka elementów jak w ESPHome (analogowy świat + peryferia)

Data: 2026-09-18. Stan: 256 testów jednostkowych (21 plików), 9 + 12 + 5
checków E2E przez CDP (verify, verify2, verify3), tsc czysty, `vite build`
przechodzi.

Trzecia runda zgłoszeń ("dodaj większą bibliotekę elementów (jak w esphome)")
wnosi na paletę 8 nowych elementów: potencjometr, LDR, DHT11/22, servo SG90,
przekaźnik NO/NC, OLED SSD1306, strip NeoPixel (WS2812) i HC-SR04. Razem z nimi
pojawia się pierwszy w emulatorze obwód analogowy.

## Model analogowy (peripherals/netlist.ts)

Rozwiązacz binarny (HIGH/LOW) nie wystarcza na dividerze, więc `Netlist`
dostał warstwę Thevenina:

- `analogVolts(terminal)` patrzy, co "siegnie" do węzła przez rezystancje
  (`reachSources`), i miesza najsilniejsze źródło z najsilniejszym upustem do
  masy. Kandydaci per element: `pot` to ideaalny odczep 10k (linki
  `(1-ratio)*10k` / `ratio*10k`), `ldr` to fotoopornik z krzywą CdS
  `ldrOhms(lux) = clamp(1e6 / lux^0.7, 500, 1e6)` - pierwsza próba
  `1e6/(1+lux)` zapadała się w dolny clamp przy kilkuset luksach.
- `analogRead(A0)` w machine skaluje napięcie węzła: `V/3.3*1023`. A0 to alias
  gpio 17 (stałe w env szkicu); GpioBus nadal operuje na 0..16, A0 nie ma
  trybu ani cyfrowego odczytu.
- Przekaźnik: cewka 150R obciąża pin sterujący; styk zwarty gdy na cewce
  >2 V i <=1.65 V na drugiej szpilce (`coilEnergized`, strzeżony zbiorem
  `coilGuard` przed rekurencją Dijkstry). NO zwarty aktywnie, NC przeciwnie -
  dzięki temu żarówka po NO zapala się dopiero gdy szkic podciągnie pin.

## API peryferiów (core/machine.ts)

Język szkiców nie ma klas, więc cała biblioteka to funkcje C-style (udokumentowane odchylenie):

| rodzina | funkcje |
|---|---|
| DHT | `dhtSetup(pin)`, `dhtReadTemperature(pin)`, `dhtReadHumidity(pin)` |
| HC-SR04 | `hcsrSetup(trig, echo)`, `hcsrDistanceCm(echo)`, `hcsrPulseUs(echo)` |
| servo | `servoAttach(pin)`, `servoWrite(pin, deg)`, `servoRead(pin)` |
| OLED | `oledBegin(addr=0x3C)`, `oledClear()`, `oledPrint(x, y, text)`, `oledShow()` |
| NeoPixel | `npSetup(pin, n)`, `npPixel(pin, i, r, g, b)`, `npShow(pin)` |

Wyszukiwanie elementu idzie po sieci, nie po nazwie zmiennej:
`machine.sensorAt(type, gpio, pin)` liczy etykietę gpio (`board.labelFor`),
potem `netlist.sameNet('mcu.D4', 'dht-1.data')`. Brak elementu w sieci:
DHT zwraca -999 (jak biblioteki na rozłączonym czujniku), reszta 0/false.

Stan widoczny dla GUI: `servoAngles()` (gpio -> stopnie, kąt igły),
`oledFrames()` (id -> 8 wierszy x 21 znaków), `strips()` (gpio -> RGB-y
0xRRGGBB). `reset()` czyści wszystko.

OLED to siatka tekstu 8x21, nie framebuffer 128x64 - dokładnie to, co
wyświetlają szkice SSD1306 z `display.drawString`; odchylenie wpisane do
README.

## GUI

- `footprintFor` + rysowanie: kąt igły servo liczony z `servoAngles()` przez
  `pinGpio()` (net sig -> szpilka board -> gpio), pasmo NeoPixel świeci
  kolorami ze `strips()`, panel OLED szkli wiersze ramek, ramię przekaźnika
  przeskakuje NO/NC wg napięć cewki z rozwiązanego obwodu.
- Strojenie na żywo: podczas biegu przeciągnięcie korpusu pot/LDR/DHT/HC-SR04
  zmienia parametr (`ratio`, `lux`, `tempC`/`humPct`, `cm`), wartość leci
  natychmiast do `machine.netlist.addComponent(...)` (reedycja parametrów =
  przeładowanie elementu), a `onEdit()` przy pointerup zapisuje projekt.
- Paleta: 8 nowych pozycji z hintami; przykłady `pot-serial`, `ldr-led`,
  `dht-oled`, `servo-pot`, `neopixel-chase`, `hcsr-serial`, `relay-pump`
  wnoszą gotowe okablowanie (presety w `gui/examples.ts`).

## Testy

- `tests/analog.test.ts` (6) - divider, LDR ~10k przy 300 lx, masa, rozwarcie.
- `tests/library.test.ts` (8) - DHT -999 bez okablowania i live value,
  HC-SR04 [1, 42, 2436], servo 120 stopni i clamp 180, przekaźnik zamyka NO
  dopiero przy sterowanym pinie.
- `tests/display.test.ts` (7) - ramka OLED, clip do 8. wiersza, clear, brak
  panelu; kolory stripu, cap 64, `npSetup` bez stripu.
- `tests/examples.test.ts` - wszystkie 11 presetów buduje się, parsiuje i
  rozwiązuje bez zwarć.
- E2E: verify2 dowie 12 checków (m.in. tekst na panelu OLED przez
  `__emu.machine.oledFrames()`, świeceący strip `strips().get(13)`,
  `adc = 512 -> 0` po zmianie `ratio`), verify3 dokłada servo/relay/HC-SR04/
  LDR plus "pętla renderowania żyje po narysowaniu każdego elementu".
