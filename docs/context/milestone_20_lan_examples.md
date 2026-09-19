# Milestone 20 - F12: przyklady LAN + wskaznik deep sleep

Dwa nowe szkice w `Examples…`: `lan-server.ino` (staly leasing
192.168.1.150 z `WiFi.config`, `MDNS.begin("serwer")`, `GET /led?on=1`,
`GET /ID`) i `lan-client.ino` (drugie urzadzenie pyta co 2 s przez
`http://serwer.local/ID` i przylacza LED kolegi). Para demonstruje
lace F10 bez pisania czegokolwiek - dokladnie ten scenariusz, co E2E
verify8/verify9.

`machine.sleepRemainingMs()`: milisekundy do przebudzenia albo null
(chip czuwa). Chip urzadzenia w paskie dostaje `zZ`, gdy maszyna ma
oczekujace `ESP.deepSleep`.

Przy okazji wpadl prawdziwy bug F9: `run()` nie kasowalo `wakeAt`,
wiec zaladowanie nowego szkicu po usypianiu "budzilo" maseyne po
starym liczniku, a `sleepRemainingMs()` klamal. Wake i tak dzialal
wlasciwie (zegar startuje od zera, jak sprzetowo po deep sleepie -
test okresowego `ESP.deepSleep` w `setup()` to pilnuje).
