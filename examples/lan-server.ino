// LAN demo (1 of 2): press "+" in the device bar to add a second chip,
// load lan-client.ino there and Run both.
// This chip takes the static lease 192.168.1.150 and the name serwer.local.

IPAddress wemos_ip(192, 168, 1, 150);
ESP8266WebServer server(80);
bool ledOn = false;

void setup() {
  Serial.begin(115200);
  pinMode(D4, OUTPUT);
  WiFi.config(wemos_ip, IPAddress(192, 168, 1, 1), IPAddress(255, 255, 255, 0));
  MDNS.begin("serwer");
  server.on("/led", []() {
    ledOn = server.arg("on").toInt() == 1;
    digitalWrite(D4, ledOn ? HIGH : LOW);
    server.send(200, "text/plain", ledOn ? "led on" : "led off");
  });
  server.on("/ID", []() {
    server.send(200, "text/plain", WiFi.localIP());
  });
  server.begin();
  Serial.print("server up at http://");
  Serial.print(WiFi.localIP());
  Serial.println("  (serwer.local)");
}

void loop() {
  server.handleClient();
  delay(20);
}
