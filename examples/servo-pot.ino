// SG90 servo on D3 steered by the potentiometer on A0.
// Drag the pot body to sweep the arm.

void setup() {
  Serial.begin(115200);
  servoAttach(D3);
}

void loop() {
  int angle = map(analogRead(A0), 0, 1023, 0, 180);
  servoWrite(D3, angle);
  Serial.print("angle = ");
  Serial.println(angle);
  delay(50);
}
