// Serial output tour: print, println, printf and millis() stamps.

void setup() {
  Serial.begin(115200);
  Serial.println("ESP8266 emulator says:");
  Serial.print("2 + 3 = ");
  Serial.println(String(2 + 3));
  Serial.printf("pi=%.3f answer=%d\n", 3.14159, 42);
}

void loop() {
  Serial.printf("uptime %d ms\n", millis());
  delay(1000);
}
