/**
 * F3 core API: String methods, ESP.restart/wdtFeed, WiFi completion
 * (isConnected/reconnect/waitForConnectResult/config), MDNS + ArduinoOTA
 * stubs - everything the roller-shutter v20 setup() calls.
 */
import { describe, it, expect } from 'vitest';
import { Esp8266Machine } from '../core/machine';

const machine = () => new Esp8266Machine({ board: 'wemos-d1-mini' });

describe('String methods (F3)', () => {
  it('length/toInt/charAt/toFloat on string values', () => {
    const m = machine();
    m.load(`
      void setup() {
        Serial.begin(9600);
        String v = "123abc";
        String t = "abc";
        Serial.println(v.length());
        Serial.println(v.toInt());
        String n = "-9";
        Serial.println(n.toInt());
        Serial.println(t.length());
        Serial.println(v.charAt(1));
      }
      void loop() { delay(1); }
    `);
    m.run();
    expect(m.serial.map((l) => l.text)).toEqual(['6', '123', '-9', '3', '50']);
  });

  it('String(int) round-trips through toInt', () => {
    const m = machine();
    m.load(`
      void setup() {
        Serial.begin(9600);
        String s = String(50);
        Serial.println(s.toInt() + 1);
      }
      void loop() { delay(1); }
    `);
    m.run();
    expect(m.serial.map((l) => l.text)).toContain('51');
  });

  it('methods work on parameters and globals too', () => {
    const m = machine();
    m.load(`
      String g = "hello";
      int len(String s) { return s.length(); }
      void setup() {
        Serial.begin(9600);
        Serial.println(len(g));
        Serial.println(g.toInt());
      }
      void loop() { delay(1); }
    `);
    m.run();
    expect(m.serial.map((l) => l.text)).toEqual(['5', '0']);
  });
});

describe('ESP helpers (F3)', () => {
  it('ESP.wdtFeed is a no-op', () => {
    const m = machine();
    m.load('void setup(){ Serial.begin(9600); } void loop(){ ESP.wdtFeed(); delay(1); }');
    m.run();
    m.advance(10);
    expect(m.phase()).toBe('running');
  });

  it('ESP.restart() re-runs setup with fresh sketch state', () => {
    const m = machine();
    m.load(`
      int ticks = 0;
      void setup() { Serial.begin(9600); Serial.println("boot"); }
      void loop() {
        ticks++;
        Serial.println(ticks);
        ESP.restart();
      }
    `);
    m.run();
    m.advance(50);
    // every loop iteration reboots: the log is wiped by the restart, so it
    // can never grow past one boot + one tick no matter how long we run
    expect(m.serial.map((l) => l.text)).toEqual(['boot', '1']);
    m.advance(50);
    expect(m.serial.map((l) => l.text)).toEqual(['boot', '1']);
  });
});

describe('WiFi completion (F3)', () => {
  it('waitForConnectResult parks until the join finishes and returns WL_CONNECTED', () => {
    const m = machine();
    m.load(`
      void setup() {
        Serial.begin(9600);
        WiFi.begin("net", "pw");
        int r = WiFi.waitForConnectResult();
        Serial.println(r);
        Serial.println(millis() >= 1500 ? 1 : 0);
      }
      void loop() { delay(1); }
    `);
    m.run(); // setup parks in waitForConnectResult (1.5 s virtual join)
    m.advance(3000);
    expect(m.serial.map((l) => l.text)).toEqual(['3', '1']);
  });

  it('isConnected follows the join; reconnect restarts it', () => {
    const m = machine();
    m.load(`
      void setup() {
        Serial.begin(9600);
        Serial.println(WiFi.isConnected());
        WiFi.begin("net", "pw");
        WiFi.waitForConnectResult();
        Serial.println(WiFi.isConnected());
        WiFi.reconnect();
        Serial.println(WiFi.isConnected());
      }
      void loop() { delay(1); }
    `);
    m.run();
    m.advance(3000); // let the first join finish; reconnect's join stays open
    expect(m.serial.map((l) => l.text)).toEqual(['0', '1', '0']);
  });

  it('config/softAPConfig accept IPAddress objects, mode() stays 1', () => {
    const m = machine();
    m.load(`
      IPAddress ip(192, 168, 1, 60);
      void setup() {
        Serial.begin(9600);
        Serial.println(WiFi.mode(WIFI_STA));
        Serial.println(WiFi.config(ip, IPAddress(192,168,1,1), IPAddress(255,255,255,0)));
        Serial.println(WiFi.softAPConfig(ip, ip, IPAddress(255,255,255,0)));
      }
      void loop() { delay(1); }
    `);
    m.run();
    expect(m.serial.map((l) => l.text)).toEqual(['1', '1', '1']);
  });
});

describe('MDNS + ArduinoOTA stubs (F3)', () => {
  it('the v20 discovery/OTA block runs as no-ops', () => {
    const m = machine();
    m.load(`
      void setup() {
        Serial.begin(9600);
        MDNS.begin("esp8266");
        ArduinoOTA.onStart([]() { Serial.println("start"); });
        ArduinoOTA.onEnd([]() { });
        ArduinoOTA.onProgress([](unsigned int progress, unsigned int total) { });
        ArduinoOTA.onError([](int error) { });
        ArduinoOTA.begin();
        Serial.println("ota ok");
      }
      void loop() { ArduinoOTA.handle(); delay(1); }
    `);
    m.run();
    m.advance(5);
    expect(m.serial.map((l) => l.text)).toContain('ota ok');
    expect(m.faultReason).toBe(null);
  });
});
