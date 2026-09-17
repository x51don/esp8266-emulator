// Classic hello-world: on-board LED on D4 (GPIO2) blinks at 2 Hz.
// Wire: D4 -> resistor -> LED -> GND, or just watch the pin dot.

void setup() {
  pinMode(D4, OUTPUT);
  Serial.begin(115200);
  Serial.println("blink started");
}

void loop() {
  digitalWrite(D4, HIGH);
  Serial.println("LED on");
  delay(500);
  digitalWrite(D4, LOW);
  Serial.println("LED off");
  delay(500);
}
