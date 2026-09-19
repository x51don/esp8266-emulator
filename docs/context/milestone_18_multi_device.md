# Milestone 18 - F10: wiele urzadzen ESP8266 w jednej stronie

Pasek urzadzen pod toolbarze: chip na ESP8266 (`esp-1 .42`, `esp-2 .43`,
dalsze od .44 w gore). Aktywny chip steruje edytorem, schematem,
serialem i panelem HTTP; kazde urzadzenie to pelna maszyna w rejestrze
LAN, z wlasnym szkicem (mapa `sketchesRef`), wlasnym EEPROM i wlasnym
logiem seriala (historia zachowana przy przełączaniu).

- `lanFetch(host, method, url, body)` w `core/lan.ts` - panel HTTP
  trafia w kazdy host wirtualnej sieci, nie tylko w aktywny chip;
  pompuje zegar CELU, wiec odpowiedz przychodzi nawet gdy maszyna
  celu jest nieaktywna w GUI.
- `WiFi.config(IPAddress(...), gw, mask[, dns])` przenosi maszyne na
  staly adres (`setLanIp`): wyrejestrowanie starego IP, rejestracja
  nowego, nazwy mDNS ida za leasingiem; `WiFi.localIP()` po konfiguracji
  odpowiada od razu (`staticLease`) - dokladnie tak, jak w szkicu
  roleta v20.
- Przyklad z E2E: serwer z `WiFi.config(...150)` + klient z
  `HTTPClient` na drugim urzadzeniu; `CODE=200`, `PEER=192.168.1.150`,
  panel HTTP przez `http://serwer.local/ID` tez dostaje odpowiedz.

Zalozenia MVP (udokumentowane): szkic projektu zapisuje kod urzadzenia
gownego, reszta zyje do przeładowania dokumentu; schemat jest wspolny
(synchronizowany do aktywnego urzadzenia); nieaktywna maszyna stoi -
jej petla nie tyka, az cos ja napompuje (HTTPClient kolegi albo panel).
Testy: `tests/mdns.test.ts` +2 (lanFetch, staly leasing); E2E
`scripts/verify8.mjs` (port 9337) - 4/4 PASS.
