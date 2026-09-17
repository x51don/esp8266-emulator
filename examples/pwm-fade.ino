// PWM breathing on D1 (GPIO5). analogWrite takes 0..1023.
// Wire: D1 -> resistor -> LED -> GND and watch the brightness.

void setup() {
  pinMode(D1, OUTPUT);
}

void loop() {
  for (int i = 0; i <= 1023; i += 8) {
    analogWrite(D1, i);
    delay(4);
  }
  for (int i = 1023; i >= 0; i -= 8) {
    analogWrite(D1, i);
    delay(4);
  }
}
