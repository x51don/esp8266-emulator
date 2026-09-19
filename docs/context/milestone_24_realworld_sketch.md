# Milestone 24: prawdziwy szkic produkcyjny (roleta v19.7.6)

Zgloszenie uzytkownika: wgrany `roleta_LoLin_WeMos_v19.7.6_k1_sm.ino` (933
linie, realny kod RoLo) wywala sie na `expected a type but found 'Ticker'`.
Cel: emulator ma uruchomic taki szkic bez bledu.

## Co blokowalo (naprawione po kolei)

1. **`Ticker`** - klasa programowych timerow ESP8266. Dodana do TYPE_WORDS
   (parser), OBJECT_TYPES (interp) i jako `LibObj` w maszynie z metodami
   `attach(s)`, `attach_s`, `attach_ms(ms)`, `detach`. Wywolanie wpada na
   kooperacyjna ISR-lane (te sama co `timer0ISR`), wiec tyka nawet gdy glowny
   watek stoi w `delay()`. Period liczony przez `Clock.setInterval`.
2. **`Servo`** - obiekt (nie tylko `servoAttach()`): `attach/write/
   writeMicroseconds/read/detach/attached`, ten sam SG90 co wbudowane.
3. **Prototypy funkcji** - `void foo();` (nawet w ciele funkcji, jak w rolicie:
   `void ICACHE_RAM_ATTR foo();`). Parser zwraca `null` dla prototypu
   globalnego; w statementach wykrywa wzorzec `void [atrybuty] nazwa ( ) ;` i
   go pomija (atrybuty i tak zdejmuje lexer).
4. **Pusty statement `;`** - line 433; parser toleruje jako pusty Block.
5. **`noInterrupts()`/`interrupts()`** - no-op (model kooperacyjny: ISR tylko w
   punktach yield).

## Co juz wczesniej dzialalo

Lambda `[](){}`, atrybuty `ICACHE_RAM_ATTR` (zdejmuje lexer), WiFi/MDNS/
WebServer/EEPROM/NeoPixel mocki, aliasy `#define`, surowe GPIO.

## Weryfikacja

`tests/ticker.test.ts`: 4 testy - attach/attach_ms/detach/detach-idempotent +
pelny boot rolety v19.7.6 (4 s wirtualne, phase 'running', brak fault).
`scripts/verify17.mjs`: przegladarka - Run wladowanego rolety, phase running,
Serial pisze, zero bledow w pasku. `npx vitest run`: 43 pliki / 482 testy;
`tsc --noEmit` czysto; `vite build` OK.
