// Loads bigger than an ESP pin switches through a BC547: the pin drives the
// base through a 1k resistor, the transistor carries the collector current.
// A 3.3V Zener (reverse-biased from 5V through 470R) clamps the rail branch -
// watch it glow while this sketch runs.
void setup() {
  Serial.begin(115200);
  pinMode(D2, OUTPUT);
}

void loop() {
  digitalWrite(D2, HIGH);
  Serial.println("transistor saturated, LED on");
  delay(700);
  digitalWrite(D2, LOW);
  Serial.println("transistor off");
  delay(700);
}
