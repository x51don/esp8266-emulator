# Milestone 16 - F8: czas, NTP, TimeLib

Rdzeń ESP8266: `configTime(gmt, dst, serwer)` ustawia blokadę - emulator
"zwalnia blokadę NTP" 0.5 s wirtualnego czasu po wywołaniu; przed tym
`time()` zwraca 0 (dokładnie ten warunek `< 1000` piszą szkice).
Zablokowany epoka = ** zegar ścienny** (Date.now()) w chwili blokady +
czas wirtualny od blokady: `delay(2000)` przesuwa `time()` o 2, nie o
ile upłynęło w przeglądarce. `localTime()` dodaje skonfigurowane
gmt+dst. `run()`/restart resetują blokadę (re-sync po reboocie).

TimeLib: `setTime(t)` ustawia własną epokę, `now()` = epoka +
wirtualne sekundy; bez `setTime` `now()` idzie za NTP.
`hour/minute/second/day/month/year/weekday/dayOfWeek/dayOfYear/isPm/
isLeapYear` z opcjonalnym argumentem-epoką, liczone po UTC (jak
TimeLib bez strefy), `weekday()` w numeracji TimeLib (niedziela = 1).
`setSyncProvider/Interval/TickInterval`, `setTimeZone`,
`getDaylightOffset` - przyjmowane.

Przy okazji: `NULL` i `nullptr` jako stałe 0 (wcześniej
`time(nullptr)` faultowało).

Brak wsparcia (świadomie): `struct tm`, `gmtime/strftime` - struktury
poza interpreterem; `settimeofday` - po co, skoro epoka jest prawdziwa.

Testy `tests/time.test.ts` (5): 0 przed blokadą i zaraz po
`configTime`, skok o dokładnie 2 s wirtualne, zgodność ze ścianą
(<10 s), offset localTime, komplet helperów TimeLib na sztywnej
epoce 2024-01-01T12:00Z.
