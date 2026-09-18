// HC-SR04 on D5 (trig) + D6 (echo): prints the distance, LED on D4
// warns below 15 cm. Drag the sensor body to move the target.

void setup() {
  Serial.begin(115200);
  pinMode(D4, OUTPUT);
  if (!hcsrSetup(D5, D6)) {
    Serial.println("no sensor");
  }
}

void loop() {
  int cm = hcsrDistanceCm(D6);
  Serial.print("distance: ");
  Serial.print(cm);
  Serial.println(" cm");
  digitalWrite(D4, cm < 15 ? HIGH : LOW);
  delay(300);
}
