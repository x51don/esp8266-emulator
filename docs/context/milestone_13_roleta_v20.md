# Milestone 13 - prawdziwy szkic roleta v20 jako test zwrotny

Szkic produkcyjny `examples/roleta_LoLin_v20.ino` (946 linii, wariant
GABINET_PARTER, IP 192.168.1.150) odpalony end-to-end na emulatorze:
boot, serwowanie endpointów HA, relay state machine, NeoPixel.
Test: `tests/roleta-v20.test.ts` (6 testów - boot/STATUS, TARGET+clamp,
TARGET 400 z byRef `getArgValue`, DOWN/STOP na ticku 0.5 s, WAKE_UP
fan-out do nieistniejących peerów, 404 z `handleNotFound`).

Szkic wymusił 8 braków, których próbki i analiza nie pokazały:

1. **Stałe rozmiary tablic z wyrażeń** - `int _WU[_ROLLERS + 1]`.
   `parseDeclRest` czytał jedno literalne num; teraz: wyrażenie ->
   `constInt` (stałe +/-/*///% << >> & | ^, unary). Błąd: "size must be
   a constant expression".
2. **Makra atrybutów ESP** - `void ICACHE_RAM_ATTR UP_switch_irq()`.
   `preprocess` wymazuje `ICACHE_RAM_ATTR|ICACHE_FLASH_ATTR|
   ICACHE_RODATA_ATTR|IRAM_ATTR|DRAM_ATTR|PROGMEM|NOINLINE` z linii
   kodu (definicje `#define` użytkownika i tak wygrywają - F1
   expanduje je wcześniej dla `#ifdef`; tu czyszczymy tylko ciało).
3. **`void setup(void)`** - parametr-lista `void` w C. Dwa miejsca:
   `looksLikeParamList` (inaczej `(void)` szło ścieżką konstruktora)
   i `parseParamList` musiał *skonsumować* `void` przed break.
4. **Parametry z nieznanym typedefem** - `[](ota_error_t error)`.
   Gdy po rzekomym "name" idzie drugi ident - pierwszy był typem.
   Dotyczy funcdefów i lambd (wspólny `parseParamList`).
5. **`switch/case/default`** - był świadomie odrzucony; szkic używa
   (cykl kolorów paska). `SwitchStmt` w AST, `parseSwitch` (etykiety
   tylko w switchu), w interp: skan testów (kolejność jak w C),
   `default`, **fallthrough zachowany**, `break` kończy switch,
   `return/continue` uciekają na zewnątrz. `walk()` statyków liczy
   ciała case'ów.
6. **`String += number`** - `message += curent_pos` leciało ścieżką
   numeryczną i faultowało maszynę w handlerze; teraz dokleja `strOf`.
7. **`String == String`** - `server.argName(i) == name`: runtime
   Binary `==`/`!=` z operandom stringowym porównuje teksty jak
   Arduino (druga strona stringifikuje się: `method() == HTTP_GET`
   daje fałsz - dokładnie tak jak na sprzęcie).
8. **Indeksowanie Stringa** - `v[0] == '-'` w `getArgValue`; `Index`
   na wartości `s` zwraca kod znaku (spójnie z literałem `'c'`),
   poza zakresem 0.

Zachowanie szkicu potwierdzone obserwacją: boot zamyka roletę
(`moveing = -1`, `target_pos = 0` - komentarz w szkice), `moveing`
przeliczany na ticku 0.5 s (test STOP musi przepompować tick),
peery 150..160 bez drugich maszyn = `-1` bez wieszania handlerów.

Weryfikacja: 408/408 (testy +6), `tsc --noEmit` czysto, build OK.
Rejestr odstępstw w `gap_roller_shutter_v20.md` bez zmian - F5 nadal
ostatni punkt.
