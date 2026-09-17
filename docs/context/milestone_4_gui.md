# Milestone 4 - GUI: canvas, interakcje, edytor, monitor, E2E w przeglądarce

Data: 2026-02-19. Stan: aplikacja kompletna i zweryfikowana w headless Chromium.
209 testów jednostkowych (16 plików) + 8 checków E2E przez CDP, tsc czysty,
`vite build` przechodzi.

## Co powstało

- `gui/canvas/renderer.ts` - warstwowe rysowanie sceny: siatka (1-2-5, major co 5),
  korpusy boardów, przewody (kolor: szary/sygnal HIGH żółty/fault czerwony),
  elementy (LED z poświatą wg jasności PWM i stanem burnt, rezystor z etykietą,
  przycisk z stanem, buzzer, bateria), piny boarda na wierzchu (kropka = live level),
  etykiety silk, obrys selekcji. Fonty capowane (nie rosną z zoomem w nieskończoność).
- `gui/components/SchematicCanvas.tsx` - narzedzia wskaznika: pan (przeciągnięcie
  tła), zoom do kursora (wheel), przenoszenie komponentów (snap 10), rysowanie
  przewodów (pin -> pin, dedupe przez wyjątek schematu), multi-select shift-click,
  klawisze Del/R/Esc, klik-przycisk = chwilowe dociśnięcie (`machine.press`),
  HTML5 drop z palety (LED wnosi rezystor 220R wstępnie okablowany).
  Osobny `SimDriver` na instancję maszyny (useMemo po `machine`).
- `gui/components/Toolbar.tsx` - board select, Run/Stop/Reset, prędkość 0.25-64x,
  Examples, bannery błędu szkicu i zwarcia.
- `gui/components/CodeEditor.tsx` - CodeMirror 6 (cpp, oneDark, historia,
  autocomplete, foldowanie). `SerialMonitor.tsx` - linie z znacznikami czasu
  wirtualnego, follow-scroll, clear.
- `gui/App.tsx` - maszyna per board (nowy `Esp8266Machine` przy zmianie),
  transport (Run = load+cold start, Stop = freeze, Reset = cold), błąd kompilacji
  w bannerze, persistencja szkicu/schematu/boarda w localStorage, hak
  `window.__emu` (schematic, machine, viewport, setSketch) do debuga i automatyzacji.
- `examples/*.ino`: blink, pwm-fade, button, serial-hello (import `?raw`).
- `scripts/verify.mjs` - E2E bez playwright: surowe CDP do systemowego Chromium.
  Checki: start, Run->serial blinka, Stop zamraża czas, pointer-drag tworzy
  przewody D4-R-LED-GND, dociśnięcie przycisku -> serial "pressed", drag-drop
  z palety. `scripts/demo.mjs` - screenshot scenki z żarówką LED.

## Pułapki i rozwiązania

- **Stary SimDriver po zmianie maszyny**: `useRef(new SimDriver(machine))` trzyma
  maszynę z pierwszego renderu; App tworzy nową w efekcie boardId. Efekt: serial
  działa (to ta sama nowa maszynа), ale zegar stoi. Fix: `useMemo` drivera po
  `machine` + przeładowanie canvasu kluczem po boardzie.
- **Wstrzykiwanie kodu do CodeMirror**: `document.execCommand('insertText')` nie
  przechodzi w headless. Kanoniczna ścieżka aplikacji (`__emu.setSketch`) działa
  i jest stabilniejsza - tak robi E2E.
- **Syntetyczne PointerEvent**: `setPointerCapture` rzuca InvalidPointerId bez
  aktywnego wskaźnika - obsłużone try/catch (przydatne też dla realnych
  przeglądarkowych edge cases).
- **Warstwy**: przewody pod korpusem boarda znikały (źle się czytało okablowanie);
  kolejność: board -> druty -> drobne elementy -> piny boarda na wierzch.
- **`fit()`** przybliżał do 4x na małym schemacie - cap `maxZoom=1.15` przy
  pierwszym dopasowaniu.
- **printf z `\n` w środku formatu** nie flushował linii - cała ścieżka printów
  idzie teraz przez `appendText` (split po `\n`), odtworzony testem.
- `timeMs` to metoda - w evaluate przez CDP wywołanie bez `()` serializuje
  referencję funkcji i porównanie zawsze "passuje" fałszywie.

## Weryfikacja

- `npx vitest run`: 209/209. `npx tsc --noEmit`: 0. `npx vite build`: OK.
- `node scripts/verify.mjs` (dist na :8090, headless Chromium 1600x900):
  8/8 checków, w tym pełny przepływ: szkic button.ino + przycisk D3-GND ->
  21x "pressed" po dociśnięciu.
- Screenshoty: `shot-gui-2.png` (pusty start), `shot-gui-e2e.png` (scenka E2E,
  serial z pressed), `shot-gui-led.png` (blink 4x, żółty D4 HIGH, poświata LED).

## Zostało (opcjonalne)

- Servo/OLED/DHT11 jako kolejne typy netlisty; ADC/A0 suwak w UI.
- Eksport/import schematu do pliku; wiele szkiców naraz.
- Auto-podświetlanie konfliktu na canvasie przy probówce (teraz tylko banner).
