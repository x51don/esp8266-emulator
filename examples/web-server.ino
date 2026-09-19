// Web server demo: open the HTTP tab (right dock) and try
//   GET http://192.168.1.42/led?on=1   and   /led?on=0
// The sketch serves requests inside server.handleClient(), just like
// a real ESP8266WebServer; the LED is wired to D4 on the schematic.

ESP8266WebServer server(80);
bool ledOn = false;

void setup() {
  Serial.begin(115200);
  pinMode(D4, OUTPUT);
  server.on("/led", HTTP_GET, []() {
    ledOn = server.arg("on").toInt() == 1;
    digitalWrite(D4, ledOn ? HIGH : LOW);
    server.send(200, "text/plain", ledOn ? "led on" : "led off");
  });
  server.on("/status", HTTP_GET, []() {
    server.send(200, "text/plain", ledOn ? "on" : "off");
  });
  server.onNotFound([]() {
    server.send(404, "text/plain", "try /led?on=1");
  });
  server.begin();
  Serial.print("serving at http://");
  Serial.println(WiFi.localIP());
}

void loop() {
  server.handleClient();
  delay(20);
}
