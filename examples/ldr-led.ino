// Night light: LDR + 10k divider on A0, LED on D4 lights up in the dark.
// Drag the LDR body to change the light level.

void setup() {
  Serial.begin(115200);
  pinMode(D4, OUTPUT);
}

void loop() {
  int v = analogRead(A0);
  digitalWrite(D4, v < 500 ? HIGH : LOW);
  Serial.print("dark adc = ");
  Serial.println(v);
  delay(200);
}
