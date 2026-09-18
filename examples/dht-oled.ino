// DHT22 on D4 + SSD1306 OLED (I2C 0x3C) on D1/D2.
// Drag the DHT body sideways for temperature, up/down for humidity.

void setup() {
  Serial.begin(115200);
  dhtSetup(D4);
  if (!oledBegin()) {
    Serial.println("no OLED on i2c 0x3C");
  }
}

void loop() {
  float t = dhtReadTemperature(D4);
  float h = dhtReadHumidity(D4);
  oledClear();
  oledPrint(0, 0, "ESP8266 lab");
  oledPrint(0, 2, "Temp C:");
  oledPrint(9, 2, String(t));
  oledPrint(0, 3, "Hum %:");
  oledPrint(9, 3, String(h));
  oledShow();
  Serial.print("T=");
  Serial.print(t);
  Serial.print(" H=");
  Serial.println(h);
  delay(1000);
}
