# Analiza luk: symulacja "Roller shutter controller v20.0"

Źródło: szkic LoLin/WeMos roleta v20.0 (GABINET_PARTER). Zestawienie: wymagania
szkicu vs realny stan emulatora po P3.5 (352 testy). Każda luka sprawdzona
bezpośrednio w `core/sketch/lexer.ts`, `core/sketch/parser.ts`,
`core/sketch/interp.ts`, `core/machine.ts`.

## Co już JEST (bez zmian)

- `millis()`, `delay`, `yield`, `analogRead(A0)` + suwak A0 (P3.1), edytor siły.
- `attachInterrupt(pin, fn, FALLING)` z kolejką ISR (P3.2) - a szkic v20
  świadomie robi w ISR tylko `flag = true`, więc model bez preempcji pasuje.
- `Serial.begin/print/println/printf`, WiFi radio + join (P3.3),
  `WiFiClient client;` / `WiFiServer server = WiFiServer(80);`.
- `String` +/+= z int, porównania, rzuty `(uint32_t)/(float)/(int)`,
  `static` lokalne, tablice globalne z `{...}`, operatory C, pętle.
- Siatka zewnętrzna: komponenty `relay`, `button`, `ldr` istnieją w netliście.

## Luki blokujące (bez tego szkic nawet się nie sparsuje)

### F1. Preprocesor (`core/sketch/lexer.ts`) - ZROBIONE (milestone 12)
1. `#ifdef / #ifndef / #else / #elif / #endif` → `throw 'unsupported
   preprocessor directive'`. Cały szkic to 10 bloków wyboru pokoju +
   `FIXEDIP`, `_NIGHT_CLOSE`, `SALON_M_PARTER`, `KUCHNIA2_M_PARTER`.
2. Pusty `#define` (`#define FIXEDIP`, `#define GABINET_PARTER`,
   `#define ICACHE_RAM_ATTR`) dziś rozwijany na `'1'` - `void ICACHE_RAM_ATTR
   f()` zamieniłoby się w `void 1 f()`. Musi rozwijać na pusty string.
3. Komentarz po `#define` wchodzi do wartości: `#define _MAX_COUNTER 48 // max
   time...` → ekspansja wstrzykuje `// ...` w środek linii kodu i kaleczy
   resztę. Trzeba odcinać `//`/`/*` od wartości makra.
4. Wartości-makra z cudzysłowem (`#define _VERSION "..."`) - ekspansja regexem
   działa, ale `$` w `String.replace` to znak specjalny: podstawiać funkcją.

### F2. Parsowanie (`core/sketch/parser.ts`) - ZROBIONE (milestone 12)
5. Lambda `[]() { ... }` - 18 wystąpień (`server.on(path, lambda)`,
   `ArduinoOTA.onProgress([](...){...})`). Parser nie zna składni; potrzebna
   anonymous function (zarejestrowana jako `__lambda_N`) + wartość = nazwa.
6. Parametr przez referencję: `bool getArgValue(String name, int &out)` -
   brak; wymagany przynajmniej model copy-out (wartopść odpisana po `return`).
7. Deklaracje wskaźnikowe: `const char* ssid = "HomeAP";` - parser odrzuca
   wskaźniki z założenia; najtaniej: traktować `T*` jak `T` (String).
8. `volatile bool x` - `volatile` nie na liście kwalifikatorów.
9. Deklaracja z konstruktorem: `ESP8266WebServer server(80);`,
   `IPAddress wemos_ip(192,168,1,_MY_IP);` - parser zna tylko `T n;` i
   `T n = expr;`. Rozszerzyć `n(args)` na tokeny obiektów (jak `wifiToken`).

## Luki API (parsuje się, ale wywala w locie)

### F3. Rdzeń
10. Stałe `D0..D8` jako identyfikatory w szkicu (tu przez makra
    `_UP_SWITCH_PIN D7`); mapowanie jest w `boards.ts`, ale nie w `env` -
    dodać D0..D8 (+ `A0`) jako stałe GPIO.
11. Metody String: `v.length()`, `v.toInt()`, konwersja `String(octet)`.
12. `ESP.restart()` (restart = reset maszyny + ponowne setup()) i
    `ESP.wdtFeed()` (no-op).
13. WiFi brakujące: `WiFi.mode`, `WiFi.config`, `WiFi.softAPConfig`,
    `WiFi.softAP(ssid,pw)` (jest), `WiFi.reconnect`, `WiFi.isConnected`,
    `WiFi.waitForConnectResult`.
14. `MDNS.begin` → stub 1; `ArduinoOTA.onStart/onEnd/onProgress/onError/
    begin/handle` → stuby (przyjmują lambdy).

### F4. Usługowe biblioteki (rdzeń symulacji)
15. `ESP8266WebServer`: `on(path, fn)`, `onNotFound`, `handleClient()`,
    `send(code, type, body)`, `uri()`, `method()`, `args()`, `argName(i)`,
    `arg(i)`, stała `HTTP_GET`. Wymaga kolejki zapytań per serwer i wywołania
    funkcji szkicu w środku `handleClient()` (interpreter to umie - call
    użytkownika w kontekście main).
16. `HTTPClient`: `setTimeout`, `begin(client, url)`, `GET()`, `end()` -
    wywołanie wychodzące po wirtualnym LAN-ie; peer nieosiągalny → `-1` po
    `setTimeout` czasu wirtualnego (szkic liczy na 1500 ms).
17. `Adafruit_NeoPixel strip = Adafruit_NeoPixel(no, pin, typ)`: obiekt
    spinający się ze szkicowym komponentem neopixel; `begin/show/clear/
    numPixels/Color(r,g,b)/setPixelColor(i,c)`. Rdzeń już jest (np*), brakuje
    powłoki obiektowej.
18. `IPAddress` - token obiektu przyjmowany przez `WiFi.config/softAPConfig`.

## Luka systemowa (największa pozycja)

### F5. Wirtualny LAN + panel HTTP - ZROBIONE (milestone 12)
Sens tego szkicu to serwer HTTP z endpointami i fan-out do 10 peerów
(`192.168.1.150..160`). Bez warstwy sieciowej szkic odpala się, ale nic nie
można mu "kliknąć". Potrzeba:
- magistrala LAN w aplikacji: maszyny adresowane IP (na start: jedna maszyna
  + loopback + "nieznany peer" dla reszty zakresu - peer_cmd musi zwracać -1
  po limicie, żeby ścieżka fan-out była testowalna bez wielości maszyn),
- dok "HTTP" przy Serial Monitorze: pole URL + odpowiedź serwera szkicu
  (odpowiednik kliknięcia /TARGET?value=50),
- (opcjonalnie) wiele instancji Esp8266Machine na symulację WAKE_UP/
  RESTART_ALL end-to-end.

## Propozycja kolejności (każdy krok = testy RED → implementacja → zielone)

1. F1 preprocesor (ifdef + puste define + komentarze w define) - bez tego nic.
2. F2 lambdy + referencje (copy-out) + `T*` + `volatile` + `T n(args);`.
3. F3 D-stałe, metody String, ESP.*, WiFi dokończenie, stuby MDNS/OTA.
4. F4 NeoPixel obiekt + IPAddress.
5. F5 LAN + WebServer + HTTPClient + panel HTTP (największa wartość dydaktyczna).

Po kroku 3 szkic powinien RUSZYĆ (serial, przyciski, tick 0.5 s, A0, relay),
po kroku 5 - pełny scenariusz HA: /TARGET, /FOTO, fan-out, /RESTART.

## Znane uproszczenia do udokumentowania przy implementacji

- `handleClient()` obsługuje kolejkę natychmiast (brak symulacji TCP
  kolejkowania) - tak samo jak P3.3 pomija handshake.
- `ESP.restart()` zachowa stan siatki (przekaźniki wrócą do INPUT jak na
  sprzęcie), wyczyści stan szkicu - dokładnie jak zresetowanie płytki.
- `ArduinoOTA` = akceptacja wywołań bez realnego flashowania.
- `WiFi.waitForConnectResult()` = zwróć status po dokończeniu joina (1.5 s).
- referencje: copy-out nie obsługuje referencji rekurencyjnie (wystarczy
  `int&`, `String&` jako kopie).

---

## Weryfikacja na prawdziwym szkicu (milestone 13) - ZROBIONE

`examples/roleta_LoLin_v20.ino` + `tests/roleta-v20.test.ts`: szkic
uruchamia się, serwuje /STATUS /TARGET /STOP /WAKE_UP, fan-out do 11
peerów kończy się `-1` bez wieszania. Po drodze doszły: stałe
rozmiary tablic, ICACHE_*, `void f(void)`, typedefy w parametrach,
switch/case, `String += n`, `String == String`, indeksowanie Stringa
(szczegóły w `milestone_13_roleta_v20.md`).

---

## F6 - EEPROM (poza szkicem v20, z listy brakow) - ZROBIONE

Trwały sektor 4096 B przez `ESP.restart()`, maszyna + projekty (base64).
Szczoly: `milestone_14_eeprom.md`.

---

## F7 - nazwy mDNS (z listy braków) - ZROBIONE

`MDNS.begin(nazwa)` + resolver w `HTTPClient`/panelu (`pokoj.local`).
Szczegóły: `milestone_15_mdns.md`.

---

## F8 - czas/NTP (z listy braków) - ZROBIONE

`configTime`/`time`/`localTime` + TimeLib; epoka = zegar sciankowy +
czas wirtualny. Szczegoly: `milestone_16_time.md`.

## F10 - wiele urzadzen w GUI + WiFi.config (ZROBIONE)

`lanFetch` (panel HTTP trafia w kazdy host LAN), pasek chipow urzadzen
w App, szkic/EEPROM/serial per urzadzenie, `WiFi.config(IPAddress)`
przenosi IP maszyny wraz z nazwami mDNS, `WiFi.localIP()` po leasingu
stalem odpowiada od razu. Milestone 18, E2E verify8 ALL OK.

Pozostalo z listy "co brakuje": `WiFi.onEvent` (brak stacji w
emulatorze - bez uzasadnienia), WiFiEvent_t (j.w.), HTTPS/WebSocket
(poza zasiegiem).

## F11 - lawa urzadzen w projekcie + autosave flasha (ZROBIONE)

`ProjectData.devices` (szkic + EEPROM per urzadzenie, wstecz
kompatybilne), autosave otwartego projektu przy kazdym commitcie
strony EEPROM, przyklad/nowy projekt/import nie zapisuja po cichu.
Milestone 19, E2E verify9 ALL OK.

Z listy zostaja tylko pozycje bez uzasadnienia w emulatorze
(`WiFi.onEvent` - brak stacji WiFi; HTTPS/WebSockets - poza zasiegiem).

## F12 - przyklady LAN + wskaznik snu (ZROBIONE)

`lan-server.ino`/`lan-client.ino` w Examples (para na dwie lawki),
`sleepRemainingMs()` + `zZ` na chipie urzadzenia, fix: `run()` kasuje
`wakeAt`. Milestone 20.
