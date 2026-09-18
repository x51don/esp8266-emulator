// Relay module on D5: the pin drives the coil, the NO contact switches
// the lamp circuit. Watch the contact arm snap over in the schematic.

void setup() {
  Serial.begin(115200);
  pinMode(D5, OUTPUT);
}

void loop() {
  digitalWrite(D5, HIGH);
  Serial.println("pump ON (contact closed)");
  delay(1500);
  digitalWrite(D5, LOW);
  Serial.println("pump off");
  delay(1500);
}
