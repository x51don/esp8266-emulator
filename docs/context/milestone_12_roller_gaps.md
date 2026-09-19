# Milestone 12 - luki pod szkic "roller shutter v20"

Start serii F1..F5 (patrz `gap_roller_shutter_v20.md`).Kazdy element TDD:
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

## F2 - lambdy, referencje, kwalifikatory (done)

Parser (`core/sketch/parser.ts`):

- Lambda `[](...) { ... }` w dowolnym wyrażeniu: łapania (`[x]`, `[=]`,
  `[&]`) odrzucane z komunikatem; bez łapanć lambda staje się
  `FuncDef`iem `__lambda_N` doklejanym do `Program.globals`, a
  wyrażenie to `Ident(__lambda_N)` - wartość to nazwa (decay jak za
  `attachInterrupt`).
- Parametry: `int &out`, `String& s`, `char* p` - kwalifikatory między
  typem a nazwą; `byRef: true` tylko gdy referencja (stare AST bez
  pola - testy strukturalne nie pękły).
- Współdzielona `parseParamList()` dla funkii i lambd.
- Deklaracje: `const char* ssid = "..."` (global i lokalnie) - `*`
  przed nazwą podnosi `char` do typu `String`; `&` pomijany.
- Deklaracja z konstruktorem: `Server server(80);` na poziomie globalu
  odróżniana od definicji funkcji heurystyką `looksLikeParamList()`
  (`)` lub typ po `(` = parametry; literał/identyfikator = argumenty
  konstruktora -> `init = Call(type, args)`).
- `volatile` jako kwalifikator bez znaczenia (parseModifiers,
  startsDecl).

Interpreter (`core/sketch/interp.ts`):

- Dynamiczna dyspozycja w `Call`: nazwa nie jest funkcja -> zaglądamy
  do zmiennej; trzyma nazwę funkcji użytkownika -> wywołujemy ją.
  To ścieżka wywołania lambd (i wskaźników funkcji).
- `byRef` = copy-out: `Call` zbiera `RefOut{param, store}` ze
  wskaźników na l-wartość wywołującego (`storeInto`), a
  `callUserExpr` odpisuje wartości parametrów po `return`.
- `assignInto` pozwala `int = string` (komórka zmienia `k` w miejscu) -
  inaczej `int cb = [](){...}` nie przechodzi.
- `evalConst`: `true/false`, stałe środowiska i wcześniejsze globalne
  inicjalizatory (`int b = a;`).
- Tokeny obiektów: jedna tabela `OBJECT_TYPES` (WiFi*/WebServer/
  HTTPClient/IPAddress/Adafruit_NeoPixel), argumenty konstruktora
  jako `number[]` lecą do `env.objectDecl`; machine trzyma je w
  `wifi.objs.args` (F4/F5 z tego skorzystają).

Testy: `tests/syntax-f2.test.ts` (9): lambda przez parametr, lambda ze
zmienną, parametry lambdy, odrzucenie capture, `int&`/`String&`
copy-out (w tym brak zapisu gdy early-return), `const char*` +
`volatile`, `ESP8266WebServer server(80);` + `HTTPClient h;` +
`IPAddress ip(...)` jako deklaracje tokenów. 377/377, tsc + build
czyste.

Znane ograniczenia: `T x(nazwaZmiennej);` na poziomie globalu może
zostać wzięte za definicję funkcji bez typu parametru; referencja nie
działa dla tablic; capture brak.

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
