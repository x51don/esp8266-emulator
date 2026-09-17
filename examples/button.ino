// Button on D3 (GPIO0, internal pull-up) wired to GND, LED on D4.
// Place a button between D3 and GND, run, then click the button.

void setup() {
  pinMode(D3, INPUT_PULLUP);
  pinMode(D4, OUTPUT);
  Serial.begin(115200);
}

void loop() {
  if (digitalRead(D3) == LOW) {
    digitalWrite(D4, HIGH);
    Serial.println("pressed");
  } else {
    digitalWrite(D4, LOW);
  }
  delay(20);
}
