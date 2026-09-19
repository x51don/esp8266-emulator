# Milestone 15 - F7: nazwy mDNS wirtualnej sieci

`MDNS.begin("pokoj")` rejestruje IP maszyny w rejestrze LAN pod nazwą;
`HTTPClient` i panel GUI rozwijają `pokoj.local` (i samo `pokoj`) jak
prawdziwy resolver - bez DNS w stosie, bo stosu nie ma.

- `core/lan.ts`: mapa nazwa→ip obok mapy ip→host; `registerName`,
  `releaseName` (zwalnia tylko właściciel), `resolveHost` (IP przechodzi
  bez zmian, nazwa po znormalizowaniu: małe litery, bez `.local`, bez
  kończącej kropki), `routeHost`.
- `parseUrl` przyjmuje teraz każdy host (pole `ip` -> `host`);
  `HTTPClient.GET/POST` routuje przez `routeHost`, więc peer po nazwie
  działa identycznie jak po adresie.
- `fetchHttp` (panel GUI) też resolwuje: `http://pokoj.local/STATUS`
  trafia do własnej maszyny gdy nazwa ją opisuje; obca nazwa -> `null`
  (panel obsługuje swoją maszynę - druga maszyna w GUI to osobny punkt).
- `dispose()` uwalnia nazwy; `MDNS.addService/setHostname` zostają
  no-opami (usługi nie są widoczne dla szkiców).

Testy `tests/mdns.test.ts` (6): A→B po nazwie z `.local` i bez, nazwa
nigdy niezajęta -> `-1` bez faulta, panel GUI po nazwie, brak
stale-route po `dispose`, powtarzalny `MDNS.begin`.

Weryfikacja: 421/421, `tsc` czysto, build OK. Uproszczenie: brak
konfliktu nazw w czasie (kto ostatni `begin`-nął, ten ma nazwę - jak
 DHCP+DNS na prawdziwej sieci).
