# Milestone 12 - luki pod szkic "roller shutter v20"

Start serii F1..F5 (patrz `gap_roller_shutter_v20.md`).每 element TDD:
test RED -> implementacja -> GREEN -> pełna suita.

## F1 - preprocesor: warunki i #define (done)

`core/sketch/lexer.ts`, `preprocess()`:

- `#ifdef / #ifndef / #else / #elif defined(X) / #endif` + bonus `#if 0|1`.
  Stos ramek `{active, taken}`; kod z nieaktywnych gałęzi NIE trafia do
  parsera (może być syntaktycznym śmieciem - jak bloki pokoi w v20).
  `#define`-y w odrzuconej gałęzi nie wchodzą do tabeli (zgodne z C).
  Wyjątki: `#endif`/`#else` bez pary, `#if` z wyrażeniem innym niż 0/1,
  niezamknięty `#ifdef`.
- Pusty `#define` (`#define FIXEDIP`, `ICACHE_RAM_ATTR`) rozwija się na
  pusty string, nie na `1` - dawniej `void ICACHE_RAM_ATTR f()` dawał
  `void 1 f()`.
- Komentarz po wartości (`#define M 48 // max time`) odcinany przez
  `stripLineComment()` - skan z ignorowaniem `"stringów"` i `'znaków'`,
  więc `#define U "http://a.b"` przeżywa nietknięty.
- Ekspansja makr podstawia przez `() => defines[name]` - `$&`/`$1` w
  wartości zostaje dosłowne (dawniej zjadane przez `String.replace`).

Testy: `tests/preprocessor.test.ts` (16) - jednostki `preprocess()` +
end-to-end "room select" (gałąź GABINET aktywna, `int target = 48`,
`_UP_RELAY_PIN 13`, śmieć w `#ifdef NO_SUCH_ROOM` niewidoczny dla
parsera). 368/368 zielone, tsc + build czyste.

Pułapki z tej sesji:
- `Serial.print` buforuje do newline'u - testy seriala muszą używać
  `println`, inaczej `m.serial` pozostaje pusty.
- `new Esp8266Machine()` wymaga `{ board }` (brak domyślnego).

## F2 - lambdy, referencje, kwalifikatory (pending)

`[](){}` jako wyrażenie (anonimowa funkcja rejestrowana pod
`__lambda_N`), parametr `int &out` (copy-out po `return`), `T* name`
traktowane jak `T`, `volatile` jako kwalifikator do zignorowania,
deklaracja z konstruktorem `ESP8266WebServer server(80);`.

## F3 - API rdzenia (pending)

Stałe D0..D8/A0 w env, `String.length()/toInt()`, `String(int)`,
`ESP.restart()/wdtFeed()`, `WiFi.mode/config/softAPConfig/reconnect/
isConnected/waitForConnectResult`, stuby MDNS i ArduinoOTA.

## F4 - NeoPixel obiektowo + IPAddress (pending)

`Adafruit_NeoPixel strip = Adafruit_NeoPixel(no, pin, typ)` spięty z
komponentem neopixel; `begin/show/clear/numPixels/Color/setPixelColor`.

## F5 - wirtualny LAN + WebServer + HTTPClient + panel HTTP (pending)

Kolejka żądań per `ESP8266WebServer`, dispatch handlerów-szkicu w
`handleClient()`, `HTTPClient.GET` z timeoutem wirtualnym, dok HTTP w
GUI. Największa pozycja; dopiero po niej szkic jest w pełni interaktywny.
