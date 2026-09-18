# Milestone 10 - długość paska NeoPixel to konfiguracja, nie program

Zgłoszenie: ustawienie 15 LED w konfiguracji, po Run licznik wskakiwał na 8
(tyle ile podawał szkic). Szkic nie może zmieniać sprzętu.

## Model

- Fizyczna długość paska = `params.count` komponentu (konfiguracja).
- `npSetup(pin, n)` mówi tylko, jak daleko sięga rejestr przesuwny programu.
- Zapisy `npPixel` poza `min(n, fizyczne)` spadają z końca linii;
  diody powyżej `n` zostają ciemne (tak jak na sprzęcie - nie dostają
  ramek).

## Zmiany

1. `core/machine.ts` - `npStrips` ma teraz `{ count (program), physical,
   pixels[fizyczne] }`; `npSetup` czyta `physical` z parametru komponentu
   (clamp 1..64), `npPixel` sprawdza oba limity.
2. `gui/canvas/renderer.ts` - pasek rysuje `physical` diod (podpis
   `NEOPIXEL x15`), kolory bierze z bufora fizycznego; przed Run bez
   zmian (bufor ciemny).
3. `tests/display.test.ts` +2: 15/8 (wyświetla 15, steruje 8, zapis pod
   8 tracony) i 5/20 (dłuższy szkic nie rozsadza paska). Poprawiony
   stary expected (`pixels.length` = fizyczne, nie szkicowe).

## Audyt "program nadpisuje konfigurację"

Przeszukane intrinsiczy maszyny: DHT (temp/hum), HCSR04 (cm), servo
(kąt to stan wyjścia, nie konfiguracja), buzzer/relay/wyjścia (stan),
OLED `addr` - nieużywany przez `oledBegin` (wiązanie po pierwszym OLED,
to osobne uproszczenie, nie nadpisywanie). Jedyny przypadek wycieku
parametru ze szkicu do renderu to `npSetup` - naprawiony.

Weryfikacja: headless E2E - preset neopixel-chase, konfiguracja 15, Run:
`configAfterRun:15 physical:15 program:8 len:15 lit:8 litPast8:0`,
zrzut pokazuje "NEOPIXEL x15". Bramka: 277 unitów, tsc, verify 9/9,
verify2 24/24, verify3 5/5.
