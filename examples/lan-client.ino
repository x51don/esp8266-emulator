// LAN demo (2 of 2): run this on the SECOND chip ("+" in the device bar)
// while lan-server.ino runs on the first. HTTPClient reaches the peer
// by its mDNS name; the peer's clock runs while the request is served.

HTTPClient http;
unsigned long n = 0;

void setup() {
  Serial.begin(115200);
  delay(2000); // give the server chip a head start
}

void loop() {
  http.begin("http://serwer.local/ID");
  if (http.GET() == 200) {
    Serial.print("server #");
    Serial.print(n);
    Serial.print(" answered: ");
    Serial.println(http.getString());
  } else {
    Serial.println("server not up yet");
  }
  http.end();
  http.begin("http://192.168.1.150/led?on=1");
  if (http.GET() == 200) {
    Serial.print("its LED says: ");
    Serial.println(http.getString());
  }
  http.end();
  n = n + 1;
  delay(2000);
}
