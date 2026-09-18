// WS2812 strip on D7: red head chasing over dim blue leds.

int head = 0;

void setup() {
  Serial.begin(115200);
  if (!npSetup(D7, 8)) {
    Serial.println("no strip on D7");
  }
}

void loop() {
  for (int i = 0; i < 8; i = i + 1) {
    if (i == head) {
      npPixel(D7, i, 255, 40, 0);
    } else {
      npPixel(D7, i, 0, 0, 60);
    }
  }
  npShow(D7);
  head = (head + 1) % 8;
  delay(120);
}
