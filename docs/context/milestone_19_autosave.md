# Milestone 19 - F11: projekt = cala lawa + autosave EEPROM

Format projektu (v11): `devices: [{ name, sketch, eeprom }]` -
pierwszy wpis to urzadzenie glowne (jego szkic i flash ida tez w pola
gowne, wiec stare projekty czytaja sie bez zmian, a nowe otwiera sie w
starszych buildach jako lawa jednourzadzeniowa). Sanityzacja
`devices`: smieci z recznie edytowanego JSON-a wypadaja, reszta zostaje.

Autosave: zapisany projekt (`💾 Save`, `Projects…`) zapada sie sam, gdy
klatka licznika `eepromDirty` ktorejkolwiek maszyny drgnie w trybie
run (tykanie co 1 s). Baza porownania zyje poza efektem - commit w
`setup()` tego samego uruchomienia, ktore odpalil `running`, tez zostaje
zlowiony. Nowy projekt, import i przyklad czyscia otwarty projekt:
przyklad nigdy nie nadpisze projektu po cichu.

Weryfikacja: `tests/projects.test.ts` +2 (round-trip, smieci), E2E
`scripts/verify9.mjs` (port 9336): licznik bootow w EEPROM, drugi
klon na `esp-2`, reload strony bez recznego zapisu - oba urzadzenia,
oba szkice i oba flash (`BOOT=2` gdziekolwiek klikniec Run) wrocily.
Znany zlosliwy detal: `Run` to przełacznik - trzy klikniecia to jeden
boot, nie trzy (test o tym zapomnial przy pierwszym odczycie).
