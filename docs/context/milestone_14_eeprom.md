# Milestone 14 - F6: EEPROM

Emulacja `EEPROM` z rdzenia ESP8266: sektor 4096 B, API `begin/read/
write/commit/length/erase/clear/readString/writeString/readInt/
writeInt/readFloat/writeFloat` (+ Double). Układ jak w korzeniu:
String z 4-bajetową długością LE, liczby surowe, obszar skasowany =
0xFF (zapisany `readString` -> ""). `begin(size)` zwraca 0 dla
size > 4096. Brak `put/get` - to szablony C++, poza zakresem
interpretera; szkice używają jawnych read/write.

Trwałość - trzy poziomy:
1. **Restart chipa** - `EEPROM` żyje w maszynie, `ESP.restart()` i
   `run()` go nie ruszają (test licznika boot: N=1,2,3 przy
   kolejnych restartach w tym samym `advance`).
2. **Wymiana maszyny w GUI** (zmiana płytki) - nowy `Esp8266Machine`
   dostaje `eepromRestore` ze starej (efekt cyklu życia,
   `machineRef`), jak realny flash na PCB.
3. **Projekt** - `ProjectData.eeprom` (base64, opcjonalne dla
   starych projektów -> karta wymazana); `eepromToB64/
   eepromFromB64` w `gui/projects.ts`; eksport/import JSON bierze
   pole za darmo. "New project" sadzi kartę 0xFF.

`eepromDirty` (licznik `commit()`) - hak dla GUI do brudzenia
projektu; na razie nic go nie konsumuje (autozapis to osobna sprawa).

Zgodność z hardware: brak zużycia/limitu zapisów (bylyby szumem w
emulacji), brak `EEPROM.end()` (usuniety w rdzeniu 3.x).

Weryfikacja: `tests/eeprom.test.ts` (5), `tests/projects.test.ts`
(+2), 415/415, `tsc` czysto, build OK; E2E `scripts/verify7.mjs` -
w przeglądarce szkic z `ESP.restart()` naliczyl N=58 przy 3 s pracy,
`eepromBytes()` spójne z logiem. Zrzut: /tmp/emu-eeprom.png.
