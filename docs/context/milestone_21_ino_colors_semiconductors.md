# Milestone 21: pliki .ino, kolory połączeń i półprzewodniki (F13-F15)

Zamówienie użytkownika: (1) kolorowanie połączeń z domyślnym
zasilanie-czerwony / GND-biały / sygnał-zielony i wyborem z większej palety,
(2) load i save szkicu jako pliku .ino, (3) nowe elementy: dioda, dioda
Zenera, tranzystory.

## F13: szkic jako plik .ino

`gui/fileio.ts` (nowy): `inoFileName(label)` sanitizuje nazwę urządzenia do
bezpiecznej nazwy pliku (znaki nie-ASCII i spacje na `_`, cyfra na początku
dostaje strażnika `_`, pusta nazwa to `sketch`, pień skrócony do 40 znaków)
oraz `downloadText(name, text)` - blob + anchor click. W panelu szkicu dwa
przyciski w tytule: `↓ .ino` pobiera aktywny szkic, `↑ .ino` to ukryte
`<input type=file accept=".ino,.txt">`, które podmienia szkic aktywnego
urządzenia (z potwierdzeniem). `window.__emu` dostał getter `sketch()`, że
testy E2E czytały zawartość edytora bez wewnętrznych CodeMirrora.
Testy: `tests/fileio.test.ts` (4) + E2E `scripts/verify11.mjs`. Pułapki
headless Chromium: pobrania bloba bez gestu nigdy nie lądują na dysku (węszy
się na `URL.createObjectURL`), `DOM.setFileInputFiles` odmawia dla
`display:none` (trzeba input odsłonić JS-em), a pliki w `/tmp` są dla
chromium niewidoczne - plik sonduje z `scripts/.tmp/`.

## F14: kolory połączeń

Modele czysto topologiczne, bez równań. `Schematic.netRoles()` (schematic.ts)
buduje DSU po końcach przewodów (przewody scalają sieci przez wspólne piny,
przez elementy nie) i klasyfikuje rolę sieci: `power` jeśli choć jeden pin
netu pasuje do `VCC/VIN/5V/3V3/+...`, `gnd` dla `GND/VSS/-`, inaczej
`signal`; rangi łączą się przez cały net ( bateria plus-red, minus-white).
Kolory domyślne: `WIRE_ROLE_COLORS` - power `#ff5252`, gnd `#e8eef5`,
signal `#4ade80`. Ręczny kolor to `WireSeg.color` (hex walidowany regexem,
śmieci odrzucane rzutem), zapisywany w dokumencie; "auto" w menu go kasuje.
Renderer (`wireColor`) bierze kolor ręczny, inaczej rolę; zwarciowy
`C.wireFault` i żółta poświata prądu (nakładka 0.55 alfa) działają na
wierzchu, a znaczkami skrzyżowań rysuje się kolor własnego przewodu.
UI: prawy przycisk na drucie otwiera menu `WireColorMenu` (auto + 12
próbników), znika po kliknięciu poza i po scrollu. Cache ról kasowany w
`touch()`. Testy: `tests/wire-color.test.ts` (12) + E2E `verify12.mjs`
(piksele płótna: czerwony/biały/zielony, paleta, zapis dokumentu).
Pułapka E2E: `worldToScreen` zwraca współrzędne względem płótna (nie strony),
a środek L-owej trasy potrafi wypaść za krawędzią - punkt próbki bierze się
z pierwszego segmentu mieszczącego się w kadrze, kolor dopasowuje się do
oczekiwanego RGB (antyaliasing), nie szuka "najjaśniejszego".

## F15: dioda, Zener, tranzystor

Solver (netlist.ts), udokumentowane przybliżenie a nie SPICE: spolaryzowane
złącze staje się rezystancyjnym łączem (10 Ω) w grafie przewodzącym, więc
prąd przez dalsze elementy liczy się normalnie. Polaryzacja sprawdzana leniwie
`semiBias()` na wzór cewki przekaźnika (strzeżenie rekurencji = "off"):
dioda - przewodzi gdy źródło na anodzie przewyższa odpływ na katoce o 0.7 V;
Zener dodatkowo przełącza się w `rev` gdy różnica odwrotna >= Vz (parametr,
domyślnie 5.1 V); tranzystor zamyka klucz C-E gdy złącze B-E (NPN) albo E-B
(PNP) jest spolaryzowane - baza nigdy nie przewodzi. Stany w
`ResolveResult.semis` (`on/mode/currentMa/burnt`); prąd przez samo złącze bez
ogranicznika (>50 mA lub brak rezystora w ścieżce) = `burnt` + nowa rodzina
błędów `overcurrent`. Dioda LED wpuszczona w stronę przewodzenia jako
endpoint: `reachSources` wchodzi Anodą i wychodzi Katodą (sieć za nią
pozostaje widoczna), dzięki czemu dioda wstawiona przed odbiornik działa.
Rezerwa modelu: spadki kolejnych złączy nie odejmują się od progów innych
elementów - dokumentacja w komentarzach.

GUI: footprinty w `footprintFor` (dioda jak LED, tranzystor B/C/E w pionie),
symbole w rendererze (trójkąt + kreska, kolanka Z dla Zenera, koło z
strzałką na emiterze i etykietą BC547/BC557, poświata przy przewodzeniu,
czerwień przy spaleniu), grupa palety "Semiconductors" (dioda, Zener, NPN,
PNP), dialog komponentów (Vz, wybór NPN/PNP). paleta przekazuje teraz parametry
przez `dragState.params` (PNP = ten sam typ, inne parametry).

E2E `scripts/verify13.mjs`: paleta, sterownik niskostronowy na NPN (baza
przez 1k do D1), zaświecona LED1 przy HIGH, gasnąca przy LOW, odwrócona dioda
blokuje LED2, symbole malują piksele. Testy jednostkowe:
`tests/semiconductors.test.ts` (11).

## Bramka

`npx vitest run` 41 plik / 459 testów, `tsc --noEmit` czysto, `vite build`
OK, `verify11/12/13` ALL OK.
