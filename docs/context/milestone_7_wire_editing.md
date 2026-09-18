# Milestone 7 - edycja przewodów, konfiguracja elementów, kondensator

Data: 2026-09-19. Stan: 267 testów jednostkowych (22 pliki), 9 + 20 + 5
checków E2E przez CDP (verify, verify2, verify3), tsc czysty, `vite build`
przechodzi.

Czwarta runda zgłoszeń: "linie nadal przechodzą przez elementy; dodaj
możliwość manualnego przesuwania linii; zaznaczaj wyraźnie kiedy się
krzyżują, ale nie są połączone (mała czapka nad linią); dodaj możliwość
konfigurowania elementów; nie ma kondensatora; pogrupuj komponenty wg
funkcji". Sześć punktów, sześć sekcji poniżej.

## 1. Trasa, która nie przebija korpusów (gui/canvas/routes.ts)

Heurystyczny `routeWire` (prosta -> kandydaci -> detour) ma fallback, który
w najgorszym razie idzie "przez wszystko". Dołożyłem A*:

- `astarRoute(a, b, da, db, hard, soft)` - ortogonalna A* po siatce 10 px
  (skala x2 przy >70k komórek); komórki korpusów (hard), spuchnięte o PAD=6,
  są zablokowane, komórki poprzednich przewodów (soft) kosztują CROSS=30,
  każdy zakręt BEND=8. Kopiec binarny leniwy; do pinu zawsze wpadamy
  wzdłuż dopuszczonego kierunku (`punch`/`punchBack`).
- `routeWiresSequential`: najpierw heurystyka (ciała + poprzednie przewody
  jako twarde - zachowane dotychczasowe "bez nakładek"); jeśli wynik wciąż
  przecina korpus (`pathThroughRects`) - A* z ciałami twardymi, a przewodami
  miękkimi. A* odpala tylko przy realnym przebiciu, bo renderer liczy trasy
  co klatkę (po cache'u schematu).
- `pathThroughRects(path, rects, stubA, stubB)` - eksportowany probe; flagi
  stubów muszą wynosić `path.length > 2 && w.da !== undefined` (dwupunktowa
  prosta musi być sprawdzana, a własny stub przy krawędzi pinu nie może
  generować fałszywego trafienia). Pułapka: dopóki probe brał stuby = true
  na sztywno, trasy dwupunktowe nigdy nie uruchamiały A*.

## 2. Manualne przesuwanie przewodów

- `WireSeg.custom?: Pt[]` - punkty pośrednie w dokumencie (serializowane za
  darmo, bo przewody zapisują się surowo); jeśli ustawione, auto-routing w
  ogóle nie startuje.
- Drag segmentu w `SchematicCanvas`: `findWireSeg` (najbliższy segment,
  tolerancja 6/zoom) -> narzędzie `{kind:'seg'}`; ruch prostopadły do
  segmentu, snap do 10; trasa liczona z migawki ścieżki z pointerdown.
  Punkty skrajne, które odjechały od pinu, wskakują do waypointów (inaczej
  drag dwupunktowej prostej gubił przesunięcie - `slice(1,-1)` zostawiał
  pustkę).
- `manualPath(a, pts, b)` wstawia łokcie "najpierw poziomo" i usuwa
  duplikaty (punkt równy pinowi znika, więc custom z waypointem równym pinowi
  jest bezpieczny).
- Alt+klik na przewodzie kasuje `custom` -> powrót do auto-trasy. Dwuklik
  nadal usuwa przewód (druty sprawdzane przed elementami).

## 3. Krzyżówki z czópką, złącza z kropką

- `findCrossings(routes)` (schematic.ts): przecięcia prostopadłe (margines
  2 px od wierzchołków) + T-złącza (wierzchołek jednego leży ściśle
  wewnątrz segmentu drugiego; wspólne piny pomijane). `wireCrossings()`
  zwraca `{x, y, w1, w2, endpoint}`; Mapę tras buduję w kolejności
  dokumentu, więc `w2` = przewód rysowany później = nosiciel czópki.
- Renderer (`drawCrossingGlyphs`): kasuje tło kółkiem r=5.5; ten sam net
  (przez `circuit.netOf`) -> przedłużenia odcinków + kropka lutowania;
  inny net -> dorysowanie odcinka `w1` + półkole-czópka na `w2` (kąt startu
  `d2 === 0 ? 0 : -PI/2`, r=4). Gdy maszyna nie działa (brak netów), czópki
  nadal się rysują - to informacja o geometrii, nie o spójności.

## 4. Kondensator (typ 'cap')

Piny p1/p2, korpus 36x24, symbol z dwiema okładzinami (jedna zakrzywiona) i
etykietą uF/mF. W siatce: `pinsOf` zwraca p1/p2, `links()` zostaje
domyślne `[]` - kondensator to rozwarcie DC. Udokumentowane odchylenie (model
jest równoległy DC, brak krzywej ładowania), za to element da się stawiać,
łączyć i konfigurować jak każdy inny.

## 5. Dialog właściwości

`gui/components/ComponentDialog.tsx`: modal z polami per typ (rezystancja,
uf, napięcie baterii, forwardV LED, ratio potu, lux LDR, model/temp/hum DHT,
cm HC-SR04, liczba pikseli, adres OLED 0xNN, model płyty). Dwuklik na
korpusie elementu -> `onConfigure(id)` -> dialog w App; Apply = `setParam`
po polach (+ `setBoardId` dla płyty) i `syncNetlist` + `advance(0)` -
parametry łapią na żywo także w trakcie symulacji (netlist przyjmuje
`addComponent` z nowymi parametrami bez przebudowy świata). Enter = Apply.

## 6. Paleta pogrupowana (Palette.tsx)

Grupy: Board / Power (bateria) / Passive (rezystor, kondensator) / Outputs
(led, buzzer, servo, przekaźnik, neopixel) / Inputs (przycisk, pot, LDR,
DHT, HC-SR04) / Displays (OLED). Tytuły grup `.palette-group-title`; pomoc w
palecie opisuje teraz drag segmentu, Alt+klik i dwuklik właściwości.

## Testy

- `tests/routes.test.ts` +3: korytarz między dwoma ścianami (A* znajduje
  obejście), ortogonalność + poszanowanie stubów, przewody miękkie vs ciało
  twarde.
- `tests/wire-editing.test.ts` (nowy): łokcie manualPath; setWirePath /
  clearWirePath; krzyż prostopadły (punkt + przypisanie w1/w2); przewody
  równoległe -> 0 krzyży; T-złącze; kondensator (footprint + rozwarcie +
  brak błędów); trasa omija korpus.
- E2E (verify2 #13-16): drag segmentu myszą (CDP) -> `custom` + oczekiwana
  polilinia; Alt+klik przywraca auto; krzyż z czópką wykryty w punkcie;
  dwuklik na rezystorze -> dialog -> Apply 4700 -> `params.resistance` +
  zamknięcie; kondensator z palety -> schemat -> netlist bez faultów i z
  rozwarciem na węzłach. Scenariusze E2E liczę względem bieżącego widoku
  (screenToWorld), bo okno 1600x900 + zoom 1.15 - stałe punkty świata
  wpadały poza okno i mysz nie trafiała w canvas.
