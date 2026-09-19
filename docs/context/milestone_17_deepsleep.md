# Milestone 17 - F9: ESP.deepSleep

`ESP.deepSleep(us)` to w emulatorze opóźniony reset: maszyna notuje
`wakeAt = teraz + us` (µs, tryb uśpienia ignorowany) i w `advance()`,
gdy czas wirtualny go minie, wywołuje `run()` - czysty boot,
`setup()` od nowa, serial skasowany, EEPROM zostaje (test liczy boot
przez 10-sekundowe uśpienia). `deepSleepStart/deepSleepEnd` z tym
semantyką; `ESP.deepSleepSleep`-owe warianty poza tym no-op.

Uproszczenie: deep sleep to NIE jest stan maszyny - kod po
`ESP.deepSleep()` dożywa końca bieżącego odcinka interpretacji (tak
jak po `ESP.restart()`), a `phase()` nadal mówi `running`. W
przeglądarce nie ma prądu do oszczędzania; liczy się efekt dla
szkicu: reset po N mikrosekundach wirtualnych.

Test `tests/deepsleep.test.ts`: BOOT=1, cisza do t=5 s, BOOT=2 po
wake'u przy 10.02 s, bez logu poprzedniego bootu.
