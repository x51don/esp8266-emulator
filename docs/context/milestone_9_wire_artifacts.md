# Milestone 9 - artefakty na połączeniach (podwójne linie, wchodzenie w korpus)

Zgłoszenie: "pojawiają się dziwne artefakty na połączeniach (eg GND->LED)" +
zrzut z podwójną, "rozdwojoną" linią przy drucie GND->LED.

## Przyczyny (ustalone przez reprodukcję w headless i w unitach)

1. **Zawroty trasy** - heurystyka potrafiła przejechać za pin i wrócić
   (`...[60,160],[-20,160],[0,160]`), co przy rysowaniu dawało podwójną
   kreskę. Naprawa: `dedupe` w `routes.ts` usuwa teraz też wierzchołki
   typu "180 stopni" (kolinearny wystrzał poza następny punkt), w pętli
   do stabilności.
2. **Przebicie korpusu z wyjątkiem stubu** - kontrola "czy drut wchodzi w
   cudzy korpus" w `routeWiresSequential` zwalniała pierwszy/ostatni
   odcinek niezależnie od jego długości, więc odcinek 336 px idący przez
   rezystor był "stubem" i A* nigdy nie startowało. Naprawa: kontrola
   body w sekwencji jest ścisła (korpusy własnych końcówki drutu są i tak
   wykluczone, więc wyjątków nie potrzeba).
3. **A\* nie dojeżdżało do pinów płytki** - kierunek wjazdu w cel był
   liczony `(dir + 2) % 4`, a przy tabeli kierunków R,L,D,U przeciwny
   indeks to `dir ^ 1`; dla celów z prawej strony "prawo" zamieniało się
   w "dół" i korytarz celu był nieosiągalny (A\* zwracało null, zostawał
   przebity path). Do tego wybijanie korytarza pinu czyściło jedną
   komórkę, a ściana komórek wokół dużego korpusu (body+PAD) bywa
   grubsza niż komórka - teraz korytarz jest wybijany do pierwszej wolnej
   komórki (max 8).
4. **Szum punktów przecięć** - dwa druty leżące na tej samej linii
   (wspólny pin, nakładające się stuby) generowały "węzły" w każdym
   wspólnym wierzchołku. `findCrossings` pomija teraz dotyki równoległe
   (wierzchołek, którego własna ścieżka biegnie wzdłuż dotykanej
   segmentu) - nakładające się odcunki to jedna narysowana linia, nie
   złącze.

Efekt na presecie button.ino: wszystkie trasy wracają na siatkę 10, zero
zawrotów, zero przebić cudzych korpusów, przecięcia tylko prawdziwe
(hop nad inną siecią + węzeł na pinie).

## Testy

`tests/wire-editing.test.ts` +3 (hygiena tras): brak zawrotów na łańcuchu
presetowym, nakładające się collinear druty to nie przecięcia, drut nie
przebija cudzego korpusu nawet gdy jego ostatni odcinek wygląda na stub.
Weryfikacja E2E: punkt startu checku 13 czyści dokument (poprzednie
części scenariusza zmieniały auto-trasy - checki miały zaszyte stare
ścieżki). Bramka: 274 unit, tsc, verify 9/9, verify2 24/24, verify3 5/5.
