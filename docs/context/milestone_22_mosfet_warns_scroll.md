# Milestone 22: MOSFET logic-level, ostrzeżenie o bazie, dioda zwrotna, scroll polety

Następstwo listy "co brakuje" z milestonu 21.

## MOSFET IRL540N (typ `mosfet`, piny g/d/s)

W solverze kanał d-s to spolaryzowane złącze jak u poprzedników: link
`SEMI_R` gdy `V(GS) >= vth` (parametr, domyślnie 2 V - stąd "logic-level",
3.3 V z GPIO już otwiera). Bramka nie pobiera prądu: nie ma jej w `links()`
ani nie łapie jej ostrzeżenie o rezystorze bazowym. Spalenie: 5 V
bezpośrednio na d-s z otwartą bramką -> `burnt` + fault `overcurrent`,
identycznie jak tranzystor. `semiBias` ma gałąź mosfet z progiem `vth`,
`resolve()` liczy prąd d->s ze spadkiem 0.1 V. Testy: trzy w
`tests/semiconductors.test.ts` (załączanie z pinu 3.3 V, prąd bramki zerowy
- LOW i flotujące wejście trzymają odbiornik wyłączony, bare channel burn).
Symbol: oddzielona płytka bramki (izolacja!), przerwana płytka kanału,
strzałka na źródle skierowana do kanału (N), etykieta IRL540N, poświata
przewodzenia jak tranzystor. Paleta: grupa Semiconductors, glyph ⊢|.

## Ostrzeżenie o braku rezystora bazowego (kind `warn`)

Nowa kategoria błędu w `Fault`: `warn` - żółty pasek tak samo, ale to rada,
nie awaria. W `resolve()` po pętli semis: dla każdego tranzystora szukamy
`reachSources(b)` źródła mocnego w promieniu <= 1 oma - driver tuż przy bazie
znaczy, że w ścieżce nie ma żadnego rezystora (GPIO push-pull ma
`rInternal` 0, szyny też). Komunikat: "... has no base resistor: a driver
sits directly on the base ... add ~1k". Emulator nadal przełącza (prąd bazy
jest niemodelowany), ale w realu pin poszedłby z dymem. MOSFET celowo
pomijany - bramka nie pobiera prądu, bezpośrednie sterowanie jest poprawne.
Testy: samo ostrzeżenie + cisza za dowolnym rezystorem + cisza dla bramki.

## Dioda zwrotna w presetcie przekaźnika

`relay-pump.ino`: dioda przez cewkę (anoda na `coiln`, katoda na `coilp`).
W stanie ustalonym nie przewodzi (sprawdzono: preset wciąż przechodzi test
"bez błędów"), więc nic nie zmienia w solverze, a uczę poprawnej praktyki.

## Paleta się scrolluje

`.palette` nie miała `overflow` przy ~40 pozycjach - dolne grupy znikały w
oknie 900 px. Dodane `overflow-y: auto; overflow-x: hidden; min-height: 0`
(min-height dla kurczenia się w flexie). Weryfikacja E2E: przy 1440x900
`scrollHeight - clientHeight = 651`, `scrollTop > 0` po ustawieniu.

## Bramka

`npx vitest run` 41 plików / 465 testów, `tsc --noEmit` czysto, `vite build`
OK, `verify15.mjs` ALL OK (paleta + scroll + MOSFET bench + ostrzeżenie w
pasku; symbol sprawdzony screenshotem).
