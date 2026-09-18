# Milestone 5 - ławka GUI: przykłady z okablowaniem, trasy omijające ciała, projekty

Data: 2026-09-18. Stan: 229 testów jednostkowych (18 plików), 9 + 8 checków E2E
przez CDP, tsc czysty, `vite build` przechodzi.

Sześć zgłoszonych poprawek GUI:

1. Przykłady wczytują szkic RAZ Z POŁĄCZENIAMI (predefiniowany obwód).
2. Po usunięciu boarda da się go dodać z powrotem (paleta).
3. Przewody omijają korpusy elementów i board (wcześniej szły "najkrótszą"
   drogą na wylot przez board).
4. Usuwanie czegokolwiek pyta o potwierdzenie.
5. Zmiana przykładu pyta przed nadpisaniem szkicu i schematu.
6. Zapis/projecty: Save do przeglądarki, Export/Import do pliku JSON.

## Jak zrobione

- `gui/canvas/routes.ts` - przepisany router: `routeWire(a, b, da, db, obstacles)`.
  Per-kolejność: (1) prosta/Z/L klasycznie; jeśli któryś odcinek środkowy
  wpada w ciało - (2) ekstrapolacja stubów `extendStub` za krawędź korpusu
  (PAD 6), (3) kandydaci Z/L z magistralami na krawędziach przeszkód
  (`r.x-12`, `r.x+r.w+12`, snap 10) i (4) wieloprzejściowy `detour()` jako
  ostatnia deska ratunku. Ważny detal: flagi stubów per koniec (`da !== undefined`) -
  bez nich prosta przez przeszkodę była błędnie czytana jako "czysta"
  (środkowy odcinek mylony ze stubem). 11 testów, w tym asercja "środek
  odcinka nigdy wewnątrz prostokąta".
- `Schematic.wireObstacles(a, b)` - przeszkody dla przewodu: WSZYSTKIE korpusy,
  poza własnymi małymi (<=44px) końcami przewodu. Board jako koniec zostaje
  przeszkodą - kabel od pina GND musi iść dookoła, a nie pod płytką. Wyjście
  z pinu i wpin w korpus to odcinki stubów, pomijane w teście kolizji.
- `gui/canvas/hit.ts` - `polylineHit()`: klik w przewodnik liczy się po
  faktycznie narysowanej trasie (ten sam `routeWire` co renderer), nie po
  prostej p-p. Double-click na drucie = usunięcie po potwierdzeniu.
- `gui/examples.ts` - `EXAMPLE_SKETCHES` (?raw importy .ino) + `loadExample(name, boardId)`:
  dokłada obok boarda łańcuch R+LED na D4 (blink), PWM na D1, przycisk D3 + LED
  D4 (button), goły board (serial-hello). Wszystkie presety przechodzą
  `Netlist.resolve()` bez faults (test z prawdziwą siatką).
- `gui/projects.ts` - `ProjectStore` na wstrzykiwalnym `StorageLike`:
  list/save/load/remove + `exportJson`/`parseImport` (walidacja: wersja, pola).
  Klucze `esp8266-emu.projects` + `esp8266-emu.project.<nazwa>`.
- Potwierdzenia: jedno `confirmOr(msg)` w SchematicCanvas (natywny
  `window.confirm`, pomijany gdy `window.__noConfirm` - haczyk dla E2E).
  Użyte przy: Delete/Backspace (komponenty + kaskadowo przewody), double-click
  drutu, zmiana przykładu, wczytanie/usunięcie projektu, import pliku.
- `App.tsx`: schemat w `useState` + `docEpoch` (wymiana całego dokumentu =
  nowy `key` canvasu, przeładowanie maszyny). `loadSchematic` akceptuje teraz
  dokument bez boarda (bo można go usunąć). `__emu.loadExample/wirePath` dla
  automatyzacji.
- `Toolbar`: Examples… (lista nazw), Projects… / Manage… (delete), Save
  (prompt o nazwę), Export (download `esp8266-project.json`), Import (ukryty
  `<input type=file>`).
- `Palette`: pierwsza pozycja "Board" - drop dokłada/usuwa-i-przywraca board
  pod kursorem (jeśli board już jest - tylko przeniesienie).

## Weryfikacja

- `npx vitest run`: 229/229 (nowe: routes 11, examples 7, projects 6, hit+, schematic+).
- `npx tsc --noEmit`: 0 błędów; `npx vite build`: OK.
- `node scripts/verify.mjs`: 9/9 (stara suite bez regresji).
- `node scripts/verify2.mjs`: 8/8 - przykład z 3 drutami, trasy poza boardem,
  double-click usuwa drut, Delete+confirm usuwa board, paleta przywraca board,
  Save/Export/Import w toolbarze, cykl save->load->delete projektu przez UI.
- Screenshot: `/home/donpedro/shot-presets.png` (preset button.ino: kabelki
  wyprowadzone dookoła płytki).

## Zostało (opcjonalne)

- Import projektu nie łączy się z istniejącym szkicem (zastępuje) - można
  dodać tryb "dopisz do canvasu".
- Auto-zapis nazwanego projektu (teraz tylko autosave bieżącej pracy).
