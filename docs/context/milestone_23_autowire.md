# Milestone 23: generowanie schematu z kodu (Auto-wire)

Życzenie użytkownika: opcja wygenerowania schematu z kodu szkicu.

## Podejscie

Parser regexowy (osobny `gui/autowire.ts`), nie AST interpretera: szkice
tworzy sie pod tym parserem, wiec nie musza byc idealne, musza nie przeszkadzac.
Warstwy: `planFromSketch(text)` (czysta funkcja: tekst -> plan czesci) i
`buildFromPlan(plan, boardId)` (materializacja tymi samymi helperami, ktorych
uzywaja presety przykladow - eksportujemy `addLedChain`, `addButton`,
`addPot`, `addDht`, `addOled`, `sideModule`, `wire`, `pinWorld` z
`examples.ts`).

## Zasady detekcji

- `digitalWrite/analogWrite/tone(pin, ...)` -> lancuch LED (rezystor + LED do
  masy); piny zapisywane wygrywaja z czytanymi na tym samym pinie.
- `digitalRead(pin)` -> przycisk do masy (konwencja INPUT_PULLUP emulatora).
- `analogRead(...)` -> potencjometr na A0 (jedyne ADC); A0 nigdy nie dostaje
  LED ani przycisku.
- `dhtReadTemperature/Humidity` -> DHT; `servoAttach/Write/Read` -> SG90;
  `npSetup` i konstruktor `Adafruit_NeoPixel(n, pin, ...)` -> NEP;
  `hcsrSetup(trig, echo)` -> ranger; cokolwiek `oled*` -> panel na stalej
  szynie I2C emulatora (D1/D2). Piny zajete przez moduly nie dostaja
  dodatkowych LED/przycisków.
- Argument pinu: nazwa z silkscreen (`D0..D8`, `A0`), surowy numer GPIO
  (odwrotna mapa `D_PIN_TO_GPIO`, wyjete na export z `core/boards.ts`) albo
  alias: `#define LED D4`, `const int KEY = D3;`, aliasy lancuchuja sie do
  glowbi 4.
- Komentarze (`//`, blokowe) sa zdejmowane przed skanem - zakomentowane wywolanie
  nie generuje sprzetu.
- Czegos sie nie da rozstrzygnac (np. samo `hcsrDistanceCm` bez setupu) -
  odpuszczamy; lepiej szkic z dwoch elementow niz puste plotno.

## UI

Przycisk `⚡ Auto-wire` w toolbarze za Importem: `confirmOr` z liczba grup
czesci, `applyDoc(buildFromPlan(plan, boardId), sketch)` - szkic zostaje,
canvas zostaje zastapiony; `openProject.current = null` (wygenerowany
przypadek nie nadpisuje projektu autosave'em). `__emu.autowire()` dla E2E.

## Weryfikacja

13 testow jednostkowych (`tests/autowire.test.ts`): aliasy, konflikty,
usuwanie komentarzy, surowe GPIO, moduly przejmuja piny, `buildFromPlan`
rozwiazuje sie bez bledow. E2E `verify16.mjs`: przycisk w toolbarsie, szkic z
`#define`/`const int`/GPIO numery -> wlasciwe typy i liczby elementow, Run
świeci LEDem PWM bez bledow. `npx vitest run` 42 pliki / 478 testow,
`tsc --noEmit` czysto, `vite build` OK.
