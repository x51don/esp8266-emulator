// Potentiometer on A0: ends to 3V3 / GND, wiper to A0.
// Run, then drag the pot body left/right to turn the knob.

void setup() {
  Serial.begin(115200);
}

void loop() {
  int v = analogRead(A0);
  Serial.print("adc = ");
  Serial.println(v);
  delay(200);
}
