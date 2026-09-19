//------------------------------------------------------------------------------------------------------------------
// LoLin/WeMos roller shutter controller v20.0
//
// Rewrite of roleta_LoLin_WeMos_v19.7.6_k1_sm.ino. Same room variants, same IPs, same pins,
// same HTTP endpoints and same Home Assistant contract. Uncomment exactly one room define.
// Requires esp8266 Arduino core (tested compiling on 2.7.4; uses HTTPClient::begin(client,url)
// which also compiles on 3.x cores).
//
// Changes vs v19 (numbered, so each can be reverted individually - see README section on v20):
//  1 SAFETY: both relays are switched OFF at the very beginning of setup(), before anything
//    else. v19 left the relay outputs latched LOW (relays ON in active LOW wiring) from
//    pinMode() until the WiFi wait loop in setup() finished - with no network the motor was
//    driven up AND down forever. This is the primary motor-destroying bug.
//  2 SAFETY: relays are driven by a single non-blocking state machine (relay_apply()).
//    A direction change always: turns the running relay OFF, waits _RELAY_GAP_MS with both
//    OFF, re-reads the requested direction, then energizes (at most) one relay.
//    v19 blocked in delay(250) inside the switch; the 0.5 s interrupt could change "moveing"
//    mid-sequence and v19 then latched moveing_last from the new value - leaving the motor
//    running in a direction the logic did not track (wrong-direction runaway).
//  3 SAFETY: no Ticker/interrupt handlers modify control state. Button ISRs only set flags;
//    all logic runs in loop(). Removes the whole class of loop-vs-ISR races (v19 ran
//    EVERY_HALFSECOND as an ISR touching the same variables the relay switch block used).
//  4 /OTA no longer calls noInterrupts(). v19 left interrupts disabled for the whole OTA
//    session: position frozen, buttons dead, relays frozen in their last state. In v20 the
//    roller is commanded STOP on entering OTA and everything keeps working during upload.
//  5 Fan-out commands (/WAKE_UP, /RESTART_ALL, /TARGET_ALL) use correct skip logic
//    (skip self, skip _WU == -1 rooms, skip 158). v19 used (cond1 || cond2) where "&&" was
//    meant, so nothing was skipped: it sent TARGET?value=-1 to empty slots and messaged
//    itself - a self-HTTP call inside its own handler can only time out (5 s per call).
//  6 /WAKE_UP now sends a response immediately (v19 never sent one; HA timed out).
//  7 /TARGET, /FOTO, /STRIP with a missing or invalid "value" answer 400 and change nothing.
//    v19 treated a missing argument as -1 which clamped to 0 = close the roller.
//  8 Peer HTTP calls: 1.5 s timeout per peer (v19: default 5 s per unreachable peer),
//    inter-peer gap is _PEER_GAP_MS (default 1000 ms, v19: 3000 ms).
//  9 WiFi wait in setup() is capped at 30 s; the loop() keeps reconnecting afterwards.
//    v19 blocked in setup() forever when the AP was down (see bug 1).
// 10 SALON_M / KUCHNIA2_M "open side rollers" now fires once when reaching full up (edge).
//    v19 re-fired both HTTP calls every loop iteration while sitting at the top position.
// 11 LED light-cycle at bottom position applies on change instead of every loop iteration
//    (v19 re-sent the whole NeoPixel frame every ~10 ms while idle at 0).
// 12 Dead code removed: radar/motion sensor (never attached), isItNight / NIGHT_CLOSE
//    (never called), moveing_correction, /STRIP_HEX keeps its v19 side effects but stays
//    a stub.
//------------------------------------------------------------------------------------------------------------------

#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClient.h>
#include <ESP8266WebServer.h>
#include <ESP8266mDNS.h>
#include <WiFiUdp.h>
#include <ArduinoOTA.h>
#include <Adafruit_NeoPixel.h>

//----------------------------------------------------------------------------------------------------------------------------------------------------------------

#define _VERSION "LoLin/WeMos Roller controller: (v20.0)"            // this will be visible on front page of webserver

#define _ROLLERS 10                                                   // no of ip adreeses from 150
int _WU[_ROLLERS + 1] = {20, 60, 70, 60, -1, -1, -1, 30, -1, 30, 20}; // table of wake up positions counted from 150, value -1 is to skip this position also for RESTART_ALL and RESTART_NIGHT

#define GABINET_PARTER                                      //(192.168.1.150) remember to chose proper port if programming OTA
//#define LAZIENKA_PARTER                                     //(192.168.1.151) chose only one location
//#define PRZEDPOKOJ_PARTER                                   //(192.168.1.152)
//#define KUCHNIA1_PARTER                                     //(192.168.1.153)
//#define KUCHNIA2_P_PARTER                                   //(192.168.1.154) not done jet
//#define KUCHNIA2_M_PARTER                                   //(192.168.1.155) not done jet
//#define KUCHNIA2_L_PARTER                                   //(192.168.1.156) not done jet
//#define SALON_P_PARTER                                      //(192.168.1.157)
//#define SALON_L_PARTER                                      //(192.168.1.159)
//#define SALON_M_PARTER                                      //(192.168.1.160) for some reason 158 is blocked on my computer

//----------------------------------------------------------------------------------------------------------------------------------------------------------------
// NOTE for D6 = GPIO12: on ESP-12 modules GPIO12 is a boot strapping pin (flash voltage).
// It works with the relay shields in this house, but if a board ever stops booting after
// connecting the relay module, check GPIO12/D6 first (see README wiring section).
//----------------------------------------------------------------------------------------------------------------------------------------------------------------

#ifdef GABINET_PARTER
  #define _BLUE_LEDS_NO 60                                  // no of leds in strip
  #define _BLUE_LEDS_MIN 0                                  // if first leds are broken we can adjust range on begining of the strip
  #define _MAX_COUNTER 48                                   // max time (0.5 s) to OPEN schader
  #define _LOCAL_AP "Roleta_gp"                             // name for local access point
  #define _MY_IP 150                                        // static IP

  #define _MY_OFF HIGH                                      // relays trigered by LOW
  #define _MY_ON LOW

  #define _UP_SWITCH_PIN D7                                 // monostabile switchs to press, with hardware debouncers
  #define _DOWN_SWITCH_PIN D2                               // D8 stoped to work as PULL_UP, as this is spetial buton for reset purposes, do not use it again as pull_up
  #define _UP_RELAY_PIN D6                                  // relays to schader
  #define _DOWN_RELAY_PIN D5                                // NEVER driven together with _UP_RELAY_PIN (guaranteed by relay_apply())
                                                            // for hardware protection, second relay should be feeded from NC pin of first relay
  volatile bool auto_mode_night = true;                     // should it be closed automaticaly at night?
#endif

#ifdef LAZIENKA_PARTER
  #define _BLUE_LEDS_NO 60
  #define _BLUE_LEDS_MIN 0
  #define _MAX_COUNTER 48
  #define _LOCAL_AP "Roleta_lp"
  #define _MY_IP 151

  #define _MY_OFF LOW                                       // relays trigered by HIGH
  #define _MY_ON HIGH

  #define _UP_SWITCH_PIN D7
  #define _DOWN_SWITCH_PIN D2
  #define _UP_RELAY_PIN D5                                  // relays to schader
  #define _DOWN_RELAY_PIN D6
  volatile bool auto_mode_night = true;
#endif

#ifdef PRZEDPOKOJ_PARTER
  #define _BLUE_LEDS_NO 30
  #define _BLUE_LEDS_MIN 0
  #define _MAX_COUNTER 54
  #define _LOCAL_AP "Roleta_pp"
  #define _MY_IP 152

  #define _MY_OFF HIGH                                      // relays trigered by LOW
  #define _MY_ON LOW

  #define _UP_SWITCH_PIN D7
  #define _DOWN_SWITCH_PIN D2
  #define _UP_RELAY_PIN D5                                  // relays to schader
  #define _DOWN_RELAY_PIN D6
  volatile bool auto_mode_night = true;

  #define _NIGHT_CLOSE                                      // close roller deep at night (v19 code existed but was never called; enabled in v20 for this room, see tick_foto())
#endif

#ifdef KUCHNIA1_PARTER
  #define _BLUE_LEDS_NO 43                                  // should be 60 but last 17 are broken - temporary fix
  #define _BLUE_LEDS_MIN 0
  #define _MAX_COUNTER 48
  #define _LOCAL_AP "Kuchnia1_k1p"
  #define _MY_IP 153

  #define _MY_OFF HIGH                                      // relays trigered by LOW
  #define _MY_ON LOW

  #define _UP_SWITCH_PIN D3
  #define _DOWN_SWITCH_PIN D2
  #define _UP_RELAY_PIN D5                                  // relays to schader
  #define _DOWN_RELAY_PIN D6
  volatile bool auto_mode_night = true;
#endif

#ifdef KUCHNIA2_P_PARTER
  #define _BLUE_LEDS_NO 30
  #define _BLUE_LEDS_MIN 0
  #define _MAX_COUNTER 48
  #define _LOCAL_AP "Kuchnia2_k2Rp"
  #define _MY_IP 154

  #define _MY_OFF HIGH                                      // relays trigered by LOW
  #define _MY_ON LOW

  #define _UP_SWITCH_PIN D3
  #define _DOWN_SWITCH_PIN D2
  #define _UP_RELAY_PIN D5                                  // relays to schader
  #define _DOWN_RELAY_PIN D6
  volatile bool auto_mode_night = true;
#endif

#ifdef KUCHNIA2_M_PARTER
  #define _BLUE_LEDS_NO 30
  #define _BLUE_LEDS_MIN 0
  #define _MAX_COUNTER 48
  #define _LOCAL_AP "Kuchnia2_k2Mp"
  #define _MY_IP 155

  #define _MY_OFF HIGH                                      // relays trigered by LOW
  #define _MY_ON LOW

  #define _UP_SWITCH_PIN D3
  #define _DOWN_SWITCH_PIN D2
  #define _UP_RELAY_PIN D5                                  // relays to schader
  #define _DOWN_RELAY_PIN D6
  volatile bool auto_mode_night = true;
#endif

#ifdef KUCHNIA2_L_PARTER
  #define _BLUE_LEDS_NO 30
  #define _BLUE_LEDS_MIN 0
  #define _MAX_COUNTER 48
  #define _LOCAL_AP "Kuchnia2_k2Lp"
  #define _MY_IP 156

  #define _MY_OFF HIGH                                      // relays trigered by LOW
  #define _MY_ON LOW

  #define _UP_SWITCH_PIN D3
  #define _DOWN_SWITCH_PIN D2
  #define _UP_RELAY_PIN D5                                  // relays to schader
  #define _DOWN_RELAY_PIN D6
  volatile bool auto_mode_night = true;
#endif

#ifdef SALON_P_PARTER
  #define _BLUE_LEDS_NO 0
  #define _BLUE_LEDS_MIN 0
  #define _MAX_COUNTER 64
  #define _LOCAL_AP "Roleta_sRp"
  #define _MY_IP 157

  #define _MY_OFF LOW                                       // relays trigered by HIGH
  #define _MY_ON HIGH

  #define _UP_SWITCH_PIN D3
  #define _DOWN_SWITCH_PIN D2
  #define _UP_RELAY_PIN D5                                  // relays to schader
  #define _DOWN_RELAY_PIN D6
  volatile bool auto_mode_night = true;
#endif

#ifdef SALON_M_PARTER
  #define _BLUE_LEDS_NO 148
  #define _BLUE_LEDS_MIN 20
  #define _MAX_COUNTER 64
  #define _LOCAL_AP "Roleta_sMp"
  #define _MY_IP 160

  #define _MY_OFF LOW                                       // relays trigered by HIGH
  #define _MY_ON HIGH

  #define _UP_SWITCH_PIN D3
  #define _DOWN_SWITCH_PIN D2
  #define _UP_RELAY_PIN D5                                  // relays to schader
  #define _DOWN_RELAY_PIN D6
  volatile bool auto_mode_night = true;

  #define _SOUND_LIGHT_RELAY_PIN D7                         // additional light (240v) activated by sound
  #define _BULBS_LIGHT__RELAY_PIN D8                        // additional light (240V)
#endif

#ifdef SALON_L_PARTER
  #define _BLUE_LEDS_NO 0
  #define _BLUE_LEDS_MIN 0
  #define _MAX_COUNTER 64
  #define _LOCAL_AP "Roleta_sLp"
  #define _MY_IP 159

  #define _MY_OFF LOW                                       // relays trigered by HIGH
  #define _MY_ON HIGH

  #define _UP_SWITCH_PIN D3
  #define _DOWN_SWITCH_PIN D2
  #define _UP_RELAY_PIN D6                                  // relays to schader (swapped in this room)
  #define _DOWN_RELAY_PIN D5
  volatile bool auto_mode_night = true;
#endif

//----------------------------------------------------------------------------------------------------------------------------------------------------------------

const char* ssid = "HomeAP";
//const char* ssid = "Orange-6E42";
//const char* ssid = "AndroidAP";                         // remember to comment FIXEDIP
const char* password = "digestorium";
const char* mySsid = _LOCAL_AP;                           // name of local AP

#define FIXEDIP                                           // comment this out if you don't want to assign a fixed IP to the ESP

//----------------------------------------------------------------------------------------------------------------------------------------------------------------

#define _FOTO_OFFSET 14                                   // to make foto automation less sensitive  +- foto_target% (best value observed 14)
#define _FOTO_SEC 900                                     // how long to calculate mediana before move (ignores rapid light changes)
#define _MAX_CHANGE_COUNTER _MAX_COUNTER                  // usualy _MAX_COUNTER
#define _LIGHT_SENSOR_PIN A0                              // photoresistor pin, remember to connect to 3.3 V
#define _BLUE_LED_PIN D4                                  // Color led strip control pin (NeoPixel)

#define _RELAY_GAP_MS 250                                 // both relays stay OFF this long between direction changes
#define _PEER_TIMEOUT_MS 1500                             // HTTP timeout for peer controllers (WAKE_UP / RESTART_ALL / TARGET_ALL)
#define _PEER_GAP_MS 1000                                 // pause between peer commands
#define _HALFSECOND_MS 500                                // position tick
#define _WIFI_BOOT_WAIT_MS 30000                          // max time setup() waits for WiFi before continuing (relays are already OFF)

//----------------------------------------------------------------------------------------------------------------------------------------------------------------

volatile bool auto_mode = false;                          // if the roller work in automatic mode
bool auto_mode_backup = false;                            // status backup in case of glitch
bool OTA_mode = false;                                    // if true, Over The Air programming is possible

String hex;                                               // debuging
int glitch_count = 0;

int moveing = -1;                                         // -1 down, 0 stop, 1 up (initial -1 with initial curent_pos = full down-command => close roller after restart)
int foto_target = 0;                                      // foto value to follow (only in automatic mode)
int target_pos = 0;                                       // point to follow (initial 0 = close roller after restart)
int curent_pos = _MAX_COUNTER;                            // for automation, will work only after full close of rolers
int fotoValue = 0;                                        // fotoresistor value in %
int fotoValueMed = 0;                                     // fotoValue mediana
int after_change_counter = 0;

bool upflag = true;                                       // checking if this is real press of the button or only glitch
bool downflag = true;

int up_counter = 0;                                       // counting pressed butons
int down_counter = 0;                                     // changing colors of led strip on lowest roler positon
int _BUTTONS_DELAY = 2;                                   // delay 1 seconds to avoid buttons bouncing
int buttons_count = _MAX_COUNTER;                         // buttons are ignored this many ticks after boot (roller is closing, position unknown)

volatile bool up_irq = false;                             // set by button interrupt, consumed in loop()
volatile bool down_irq = false;

//----------------------------------------------------------------------------------------------------------------------------------------------------------------

Adafruit_NeoPixel strip = Adafruit_NeoPixel(_BLUE_LEDS_NO, _BLUE_LED_PIN, NEO_GRB + NEO_KHZ800);

//----------------------------------------------------------------------------------------------------------------------------------------------------------------

#ifdef FIXEDIP
IPAddress wemos_ip( 192,  168,   1,  _MY_IP);
IPAddress my_ip( 192, 168, 10, _MY_IP);
IPAddress gateway_ip( 192,  168,   1,   1);
IPAddress my_gateway_ip( 192,  168,   10,   1);
IPAddress subnet_mask(255, 255, 255,   0);
IPAddress dns_ip(  8,   8,   8,   8);
#endif

//----------------------------------------------------------------------------------------------------------------------------------------------------------------

ESP8266WebServer server(80);

//------------------------------------------------------------------------------------------------------------------
// Relay safety state machine. THE ONLY place that writes the relay pins.
// States: IDLE (one direction energized, or none) / GAP (both OFF, waiting _RELAY_GAP_MS).
// Guarantees:
//   - at most one relay is energized at any instant (every energize is preceded by all-OFF),
//   - a direction change always passes through both-OFF for >= _RELAY_GAP_MS,
//   - after the gap the requested direction is RE-READ, so a command that arrived during the
//     gap is honored instead of latching a stale direction.

int8_t relay_applied = 0;                                 // currently energized: -1 down, 0 none, 1 up
bool   relay_gap = false;                                 // true while both relays are OFF waiting for the gap
uint32_t relay_gap_start = 0;

int dir_from_pos() {                                      // single source of truth for the wanted direction (same formula as the 0.5 s tick in v19)
  if ((curent_pos > 0) && (curent_pos > target_pos)) return -1;
  if ((curent_pos < _MAX_COUNTER) && (curent_pos < target_pos)) return 1;
  return 0;
}

void relay_off_all() {
  digitalWrite(_UP_RELAY_PIN   , _MY_OFF);
  digitalWrite(_DOWN_RELAY_PIN , _MY_OFF);
  relay_applied = 0;
  relay_gap = false;
}

void relay_apply() {
  int want = dir_from_pos();                              // fresh, derived from target - not the tick-lagged "moveing"
  if (!relay_gap) {
    if (want == relay_applied) return;
    if (relay_applied ==  1) digitalWrite(_UP_RELAY_PIN   , _MY_OFF);
    if (relay_applied == -1) digitalWrite(_DOWN_RELAY_PIN , _MY_OFF);
    relay_applied = 0;
    relay_gap = true;
    relay_gap_start = millis();
    return;
  }
  // in GAP: both relays are guaranteed OFF here
  if ((uint32_t)(millis() - relay_gap_start) < (uint32_t)_RELAY_GAP_MS) return;
  want = dir_from_pos();                                  // re-read the freshest direction after the gap
  relay_gap = false;
  if (want == 0) return;                                  // stay both-OFF
  if (want > 0) {
    digitalWrite(_UP_RELAY_PIN   , _MY_ON);
    digitalWrite(_DOWN_RELAY_PIN , _MY_OFF);              // defensive: pin is already OFF, never rely on it alone
    relay_applied = 1;
  } else {
    digitalWrite(_DOWN_RELAY_PIN , _MY_ON);
    digitalWrite(_UP_RELAY_PIN   , _MY_OFF);
    relay_applied = -1;
  }
}

//------------------------------------------------------------------------------------------------------------------
// Web helpers

void handleRoot() {
  String message = "<html><head></head><body style='font-family: sans-serif; font-size: 12px'>";
  message += _VERSION;
  message += "<br><br><b>Following functions are available:</b><br><br>";
  message += "<a href='/STATUS'>/STATUS</a> - what is going on<br><br>";
  message += "<a href='/UP'>/UP</a> - roller go UP or STOP<br>";
  message += "<a href='/DOWN'>/DOWN</a> - roller go DOWN or STOP<br>";
  message += "<a href='/STOP'>/STOP</a> roller<br><br>";
  message += "<a href='/AUTO'>/AUTO</a> switch automatic mode,<br>";
  message += "      UP, DOWN, STOP and TARGET will switch auto mode OFF<br><br>";
  message += "<a href='/AUTO_NIGHT'>/AUTO_NIGHT</a> switch automatic close when night detected,<br>";
  message += "<a href='/OTA'>/OTA</a> programming mode (roller is stopped on entering this mode)<br><br>";
  message += "<a href='/RESTART'>/RESTART</a> microcontroler<br><br>";
  message += "<a href='/RESTART_ALL'>/RESTART all</a> microcontrolers<br><br>";
  message += "<a href='/WAKE_UP'>/WAKE UP</a> procedure<br><br>";
  message += "/TARGET?value=X where X is [0-100]<br><br>";
  message += "/FOTO?value=X where X is [0-100] (will start Automatic mode)<br>";
  message += "/STRIP?RED=X&GREEN=Y&BLUE=Z where X,Y,Z are [0-255]<br><br>";
  message += "<a href='/FOTO?value=25'>Foto 25%</a>'      '"; message += "<a href='/UP'>UP</a>'        '"; message += "<a href='/TARGET?value=30'>Target 30%</a><br>";
  message += "<a href='/FOTO?value=50'>Foto 50%</a>'     '"; message += "<a href='/STOP'>STOP</a>'     '"; message += "<a href='/TARGET?value=60'>Target 60%</a><br>";
  message += "<a href='/FOTO?value=75'>Foto 75%</a>'     '"; message += "<a href='/DOWN'>DOWN</a>'     '"; message += "<a href='/TARGET?value=80'>Target 80%</a><br><br>";
  message += "<a href='/STRIP?RED=255&GREEN=255&BLUE=255'>White 100%</a>'     '";
  message += "<a href='/STRIP?RED=127&GREEN=127&BLUE=127'>White 50%</a>'     '";
  message += "<a href='/STRIP?RED=0&GREEN=0&BLUE=0'>Strip Off</a><br>";
  message += "<a href='/STRIP?RED=255&GREEN=0&BLUE=0'>Red 100%</a>'     '";
  message += "<a href='/STRIP?RED=0&GREEN=255&BLUE=0'>Green 100%</a>'     '";
  message += "<a href='/STRIP?RED=0&GREEN=0&BLUE=255'>Blue 100%</a><br>";
  message += "<a href='/STRIP?RED=255&GREEN=255&BLUE=0'>Yellow 100%</a>'     '";
  message += "<a href='/STRIP?RED=0&GREEN=0&BLUE=10'>Blue Night</a><br>";
  message += "</body></html>";
  server.send(200, "text/html", message);
}

void handleNotFound() {
  String message = "File Not Found\n\n";
  message += "URI: ";
  message += server.uri();
  message += "\nMethod: ";
  message += (server.method() == HTTP_GET) ? "GET" : "POST";
  message += "\nArguments: ";
  message += server.args();
  message += "\n";
  for (uint8_t i = 0; i < server.args(); i++) {
    message += " " + server.argName(i) + ": " + server.arg(i) + "\n";
  }
  server.send(404, "text/plain", message);
}

bool getArgValue(String name, int &out) {                 // strict: returns false when argument is missing or not a plain integer
  for (uint8_t i = 0; i < server.args(); i++) {
    if (server.argName(i) == name) {
      String v = server.arg(i);
      if (v.length() == 0) return false;
      uint16_t s = 0;
      if (v[0] == '-') s = 1;
      if (s >= v.length()) return false;
      for (uint16_t j = s; j < v.length(); j++)
        if (v[j] < '0' || v[j] > '9') return false;
      out = v.toInt();
      return true;
    }
  }
  return false;
}

int clamp_pct_to_counter(int value) {                     // percent [0-100] -> counter steps, clamped
  int pos = (int)(((float)value * (float)_MAX_COUNTER) / (float)100);
  if (pos < 0) pos = 0;
  if (pos > _MAX_COUNTER) pos = _MAX_COUNTER;
  return pos;
}

bool peer_cmd(int octet, String path) {                   // fire one HTTP GET at a peer controller; false = skipped or failed
  if (octet == _MY_IP || octet == 158 || octet < 150 || octet > 160) return false;
  WiFiClient client;
  HTTPClient h;
  h.setTimeout(_PEER_TIMEOUT_MS);
  h.begin(client, "http://192.168.1." + String(octet) + path);
  int code = h.GET();
  h.end();
  return code > 0;
}

//------------------------------------------------------------------------------------------------------------------
// Button press logic (runs in loop context; interrupt handlers only set up_irq/down_irq).
// Semantics identical to v19 handlers, including the "buttons_count == 0" busy gate.

void press_up() {
  if (buttons_count != 0) return;
  up_counter += 1;
  auto_mode_backup = auto_mode;
  auto_mode = false;
  if ((moveing == 0) && (curent_pos < _MAX_COUNTER)) {
    target_pos = _MAX_COUNTER;
  } else {
    if ((moveing == 0) && (curent_pos == _MAX_COUNTER)) {  // force position correction if it is all way up
      curent_pos -= 10;
    } else {
      target_pos = curent_pos;
    }
  }
  upflag = false;
}

void press_down() {
  if (buttons_count != 0) return;
  if (down_counter < 6) down_counter += 1;                 // cycle lights when pressing down button on lower roler position
  else down_counter = 0;
  auto_mode_backup = auto_mode;
  auto_mode = false;
  if ((moveing == 0) && (curent_pos > 0)) {
    target_pos = 0;
  } else {
    target_pos = curent_pos;
  }
  buttons_count = 1;                                       // need to be 1 to cycle lights
  downflag = false;
}

void ICACHE_RAM_ATTR UP_switch_irq()   { up_irq = true; }   // FALLING edge on monostabile with hardware debouncer
void ICACHE_RAM_ATTR DOWN_switch_irq() { down_irq = true; }

//------------------------------------------------------------------------------------------------------------------
// 0.5 s tick - same computations as v19 EVERY_HALFSECOND, but executed in loop(), not in ISR.

void tick_halfsecond() {
  if ((digitalRead(_UP_SWITCH_PIN) == HIGH) && (upflag == false)) {     // button already released within the last tick -> was a glitch, undo
    target_pos = curent_pos;
    auto_mode = auto_mode_backup;
    glitch_count ++;
  }
  if ((digitalRead(_DOWN_SWITCH_PIN) == HIGH) && (downflag == false)) {
    target_pos = curent_pos;
    auto_mode = auto_mode_backup;
    glitch_count ++;
  }

  moveing = dir_from_pos();
  curent_pos += moveing;

  fotoValue = (int)((float)analogRead(_LIGHT_SENSOR_PIN) * (100.0 / 1023.0));
  fotoValueMed = (int)((float)(fotoValueMed + fotoValue) / 2.0);

  if ((auto_mode == true) && (after_change_counter > 0)) {
    if ((fotoValue <= (foto_target + _FOTO_OFFSET)) && (curent_pos < _MAX_COUNTER)) target_pos += 1;
    if ((fotoValue >= (foto_target - _FOTO_OFFSET)) && (curent_pos > 0)) target_pos -= 1;
    after_change_counter -= 1;
  }
  if (buttons_count > 0) buttons_count -= 1;
  else buttons_count = 0;

  upflag = true;
  downflag = true;
}

//------------------------------------------------------------------------------------------------------------------
// _FOTO_SEC automation - same as v19 FOTO_AUTO (minus dead night-close code; PRZEDPOKOJ keeps it under _NIGHT_CLOSE).

void tick_foto() {
  int x = foto_target - fotoValue;
  if (((fotoValueMed >= (foto_target + _FOTO_OFFSET))) || ((fotoValueMed <= (foto_target - _FOTO_OFFSET)))) after_change_counter = (abs(x) / 2);

#ifdef _NIGHT_CLOSE
  if ((auto_mode_night == true) && (curent_pos > ((int)(((float)35 * (float)_MAX_COUNTER) / (float)100))) && (fotoValueMed <= 3)) {  // night detected and roller more than 35% open
    target_pos = 0;
    auto_mode = false;
  }
#endif

  fotoValueMed = fotoValue;
}

//------------------------------------------------------------------------------------------------------------------
// LED strip helpers

void STRIP_COLOR(uint32_t c) {
  for (uint16_t i = _BLUE_LEDS_MIN; i < strip.numPixels(); i++) {
    strip.setPixelColor(i, c);
  }
  strip.show();
}

//------------------------------------------------------------------------------------------------------------------

void setup(void) {
  // SAFETY FIRST: define relay pins as outputs and switch both relays OFF before anything
  // else happens (before WiFi, before interrupts, before Serial).
  pinMode(_UP_RELAY_PIN , OUTPUT);
  pinMode(_DOWN_RELAY_PIN , OUTPUT);
  relay_off_all();

  pinMode(_UP_SWITCH_PIN , INPUT_PULLUP);
  pinMode(_DOWN_SWITCH_PIN , INPUT_PULLUP);
  attachInterrupt(_UP_SWITCH_PIN, UP_switch_irq, FALLING);              // do not change to RISING, it causes buttons to stop working
  attachInterrupt(_DOWN_SWITCH_PIN, DOWN_switch_irq, FALLING);

  Serial.begin(9600);
#ifdef FIXEDIP
  WiFi.config(wemos_ip, gateway_ip, subnet_mask, dns_ip);
  delay(100);
  WiFi.softAPConfig(my_ip, my_gateway_ip, subnet_mask);
  delay(100);
#endif
  WiFi.mode(WIFI_AP_STA);
  WiFi.begin(ssid, password);
  WiFi.softAP(mySsid, password);
  Serial.println("");

  uint32_t wifi_t0 = millis();
  while (WiFi.status() != WL_CONNECTED && (uint32_t)(millis() - wifi_t0) < (uint32_t)_WIFI_BOOT_WAIT_MS) {
    delay(100);
    Serial.print(".");
  }
  if (WiFi.status() != WL_CONNECTED) Serial.println("\nWiFi not connected yet - continuing, loop() will retry");

  Serial.println("");
  Serial.print("Connected to ");
  Serial.println(ssid);
  Serial.print("IP address: ");
  Serial.println(WiFi.localIP());

  if (MDNS.begin("esp8266")) {
    Serial.println("MDNS responder started");
  }

  server.on("/", handleRoot);

  // roler UP or STOP
  server.on("/UP", []() {
    press_up();
    upflag = true;                                         // HTTP command must not be undone by the glitch check
    if (target_pos > curent_pos) server.send(200, "text/plain", "Going UP");
    else server.send(200, "text/plain", "Full Stop!");
  });

  //roler DOWN or STOP
  server.on("/DOWN", []() {
    press_down();
    downflag = true;
    if (target_pos < curent_pos) server.send(200, "text/plain", "Going DOWN");
    else server.send(200, "text/plain", "Full Stop!");
  });

  //roler STOP and reset counter
  server.on("/STOP", []() {
    server.send(200, "text/plain", "Full Stop!");
    target_pos = curent_pos;
    auto_mode = false;
  });

  //roler Automatic Mode ON/OFF
  server.on("/AUTO", []() {
    auto_mode = !auto_mode ;
    STRIP_COLOR(strip.Color(0, 0, 0));
    strip.clear();
    if (auto_mode) server.send(200, "text/plain", "AUTO mode ON");
    else server.send(200, "text/plain", "AUTO mode OFF");
  });

  //roler Automatic Night close Mode ON/OFF
  server.on("/AUTO_NIGHT", []() {
    auto_mode_night = !auto_mode_night ;
    if (auto_mode_night) server.send(200, "text/plain", "AUTO night close mode ON");
    else server.send(200, "text/plain", "AUTO night close mode OFF");
  });

  //roler OTA Mode ON/OFF - roller is stopped for the upload, everything else keeps working (v19 froze relays and buttons here)
  server.on("/OTA", []() {
    OTA_mode = !OTA_mode ;
    if (OTA_mode) {
      target_pos = curent_pos;                             // stop moving before flash writes
      auto_mode = false;
      server.send(200, "text/plain", "OTA mode ON, roller stopped (it is always better to RESTART before OTA)");
    } else {
      server.send(200, "text/plain", "OTA mode OFF");
    }
  });

  //roler status page
  server.on("/STATUS", []() {
    String message =  _VERSION;
    message += "\nStatus:\n";
    if (auto_mode) message += "AUTO mode ON\n";
    else message += "AUTO mode OFF\n";
    if (auto_mode_night) message += "AUTO_NIGHT mode ON\n";
    else message += "AUTO_NIGHT mode OFF\n";
    if (OTA_mode) message += "OTA programming mode ON\n";
    else message += "OTA programming mode OFF\n";
    if (moveing < 0) message += "Going DOWN\n";
    else if (moveing > 0) message += "Going UP\n";
    else message += "Full Stop!\n";
    if (relay_applied > 0) message += "Relay: UP\n";
    else if (relay_applied < 0) message += "Relay: DOWN\n";
    else message += "Relay: OFF\n";
    message += "Roller position: ";
    message += curent_pos;
    message += "\ntarget_pos: ";
    message += target_pos;
    message += "\nafter change counter: : ";
    message += after_change_counter;
    message += "\nPhoto target : ";
    message += foto_target;
    message += "\nPhotoresistor : ";
    message += fotoValue;
    message += "\nMediana : ";
    message += fotoValueMed;
    message += "\nDOWN COUNTER : ";
    message += down_counter;
    message += "\nbuttons_count : ";
    message += buttons_count;
    message += "\nhex : ";
    message += hex;
    message += "\nglitch_count : ";
    message += glitch_count;
    server.send(200, "text/plain", message);
  });

  // restart microcontroller
  server.on("/RESTART", []() {
    String message =  "Restarting ...\n";
    server.send(200, "text/plain", message);               // final message first, then restart (v20: relays were switched OFF in setup already; during restart both pins are inputs again)
    delay(250);
    relay_off_all();                                       // best effort: both OFF just before reset
    ESP.restart();
  });

  server.on("/RESTART_NIGHT", []() {                       // hidden function to be restartet by remote controller
    if (auto_mode_night) {
      String message =  "Restarting ...\n";
      server.send(200, "text/plain", message);
      delay(250);
      relay_off_all();
      ESP.restart();
    } else {
      String message =  "Will not restart ...\n";
      server.send(200, "text/plain", message);
    }
  });

  // restart all microcontrollers: answer first, then command the peers (skipping self, empty slots and 158), then restart itself directly.
  // v19 messaged itself over HTTP - inside its own handler - which can only time out on a single core device.
  server.on("/RESTART_ALL", []() {
    server.send(200, "text/plain", "Restarting ALL...\n");
    for (int i = _ROLLERS ; i >= 0 ; i--) {
      if (_WU[i] == -1) continue;                          // empty / not-flashed slot (also skips 158)
      peer_cmd(150 + i, "/RESTART");
      delay(_PEER_GAP_MS);
    }
    relay_off_all();
    ESP.restart();
  });

  // Wake UP procedure: PRZEDPOKOJ (152) opens first, then the rest descending, self last and directly (no self-HTTP).
  server.on("/WAKE_UP", []() {
    server.send(200, "text/plain", "Wake up procedure started\n");
    if (_WU[2] != -1) {
      peer_cmd(152, "/TARGET?value=" + String(_WU[2]));
      delay(_PEER_GAP_MS);
    }
    for (int i = _ROLLERS ; i >= 0 ; i--) {
      if (_WU[i] == -1) continue;
      if (i == 2) continue;                                  // 152 already sent first, do not send twice
      peer_cmd(150 + i, "/TARGET?value=" + String(_WU[i]));
      delay(_PEER_GAP_MS);
    }
    if (_WU[_MY_IP - 150] != -1) {                         // to open itself as a last one
      target_pos = clamp_pct_to_counter(_WU[_MY_IP - 150]);
    }
  });

  // to set roler  position [0-100]
  server.on("/TARGET", []() {
    int value;
    if (!getArgValue("value", value)) {                    // v19: missing argument was treated as -1 -> clamped to 0 -> roller closed. Never again.
      server.send(400, "text/plain", "missing or invalid value=X\n");
      return;
    }
    server.send(200, "text/plain", "TARGET set");
    target_pos = clamp_pct_to_counter(value);
    auto_mode = false;
  });

  // to set all rollers to one value
  server.on("/TARGET_ALL", []() {
    int value;
    if (!getArgValue("value", value)) {
      server.send(400, "text/plain", "missing or invalid value=X\n");
      return;
    }
    server.send(200, "text/plain", "TARGET set");
    for (int i = _ROLLERS ; i >= 0 ; i--) {
      if (_WU[i] == -1) continue;
      peer_cmd(150 + i, "/TARGET?value=" + String(value));
      delay(_PEER_GAP_MS);
    }
    target_pos = clamp_pct_to_counter(value);
    auto_mode = false;
  });

  // to set photoresistor value to be follow [0-100]
  server.on("/FOTO", []() {
    int value;
    if (!getArgValue("value", value)) {
      server.send(400, "text/plain", "missing or invalid value=X\n");
      return;
    }
    server.send(200, "text/plain", "FOTO set");
    foto_target = value;
    if (foto_target < 0) foto_target = 0;
    if (foto_target > 100) foto_target = 100;
    auto_mode = true;
    auto_mode_night = true;
    if (curent_pos == _MAX_COUNTER) curent_pos += -1;      // trick to avoid side rollers to go up when we have 3 rollers and photo is set in max upper position
    after_change_counter = _MAX_CHANGE_COUNTER;
    STRIP_COLOR(strip.Color(0, 0, 0));
    strip.clear();
  });

  // set the Led Strip color
  server.on("/STRIP", []() {
    int red, green, blue;
    if (!getArgValue("RED", red) || !getArgValue("GREEN", green) || !getArgValue("BLUE", blue)) {
      server.send(400, "text/plain", "missing RED/GREEN/BLUE\n");
      return;
    }
    server.send(200, "text/plain", "STRIP set");
    if (red < 0) red = 0; if (red > 255) red = 255;
    if (green < 0) green = 0; if (green > 255) green = 255;
    if (blue < 0) blue = 0; if (blue > 255) blue = 255;
    STRIP_COLOR(strip.Color(red, green, blue));
    auto_mode = false;
    auto_mode_night = false;
  });

  // set the Led Strip color in hex (still a stub, kept for endpoint compatibility)
  server.on("/STRIP_HEX", []() {
    server.send(200, "text/plain", "STRIP_HEX set");
    int hval;
    hex = "0x";
    if (getArgValue("HEX", hval)) hex += hval;
    auto_mode = false;
  });

  server.onNotFound(handleNotFound);

  server.begin();

  //OTA programming
  ArduinoOTA.onStart([]() {
    Serial.println("Start");
  });
  ArduinoOTA.onEnd([]() {
    Serial.println("\nEnd");
  });
  ArduinoOTA.onProgress([](unsigned int progress, unsigned int total) {
    Serial.printf("Progress: %u%%\r", (progress / (total / 100)));
  });
  ArduinoOTA.onError([](ota_error_t error) {
    Serial.printf("Error[%u]: ", error);
    if (error == OTA_AUTH_ERROR) Serial.println("Auth Failed");
    else if (error == OTA_BEGIN_ERROR) Serial.println("Begin Failed");
    else if (error == OTA_CONNECT_ERROR) Serial.println("Connect Failed");
    else if (error == OTA_RECEIVE_ERROR) Serial.println("Receive Failed");
    else if (error == OTA_END_ERROR) Serial.println("End Failed");
  });
  ArduinoOTA.begin();

  Serial.println("HTTP server started");

  strip.begin();
  strip.show();                                            // Initialize all pixels to 'off'

  STRIP_COLOR(strip.Color(0, 0, 10));                      // Blue Night
}

//------------------------------------------------------------------------------------------------------------------

uint32_t t_halfsecond = 0;
uint32_t t_foto = 0;

void loop(void) {

  if (!WiFi.isConnected()) {                               // reconnecting wifi
    Serial.println( "Disconnected!" );
    WiFi.reconnect();
    WiFi.waitForConnectResult();
  }

  //handle webserver (also during OTA - v19 froze the world there)
  server.handleClient();
  delay(10);                                               // Don't Delete or it will stop working

  if (OTA_mode) {
    ArduinoOTA.handle();
    delay(10);                                             // Don't Delete or it will stop working
  }

  // consume button interrupts
  if (up_irq)   { up_irq = false;   press_up();   }
  if (down_irq) { down_irq = false; press_down(); }

  // 0.5 s position tick (was a Ticker ISR in v19)
  if ((uint32_t)(millis() - t_halfsecond) >= (uint32_t)_HALFSECOND_MS) {
    t_halfsecond = millis();
    tick_halfsecond();
  }

  // photo automation tick (was a Ticker ISR in v19)
  if ((uint32_t)(millis() - t_foto) >= ((uint32_t)_FOTO_SEC * 1000u)) {
    t_foto = millis();
    tick_foto();
  }

  // SAFETY: relay state machine - the only relay writer
  relay_apply();

  // LED strip behaviour (same rules as v19)
  if ((curent_pos == 1) && (moveing == 1)) { STRIP_COLOR(strip.Color(0, 0, 0)); strip.clear(); }   // Switch light off when going up
  if ((curent_pos == 1) && (moveing == -1)) down_counter = 0;                                       // reset the light cycle when pressing down button

  static int light_shown = -999;
  if ((curent_pos == 0) && (moveing == 0)) {
    if (down_counter != light_shown) {                                                                // apply the cycle color once on change (v19 re-sent every ~10 ms)
      light_shown = down_counter;
      switch (down_counter) {
        case 0: STRIP_COLOR(strip.Color(10, 0, 0)); break;        // Red Night
        case 1: STRIP_COLOR(strip.Color(255, 150, 0)); break;     // Orange
        case 2: STRIP_COLOR(strip.Color(255, 255, 255)); break;   // White
        case 3: STRIP_COLOR(strip.Color(0, 0, 0)); strip.clear(); break; // Off
        case 4: STRIP_COLOR(strip.Color(255, 0, 0)); break;       // Red
        case 5: STRIP_COLOR(strip.Color(0, 255, 0)); break;       // Green
        case 6: STRIP_COLOR(strip.Color(0, 0, 255)); break;       // Blue
      }
    }
  } else {
    light_shown = -999;
  }

  if ((curent_pos <= 4) && (moveing == -1)) buttons_count = _BUTTONS_DELAY + 4;                      // don't react on button when "end stop" click - for going down
  if ((curent_pos >= (_MAX_COUNTER - 4)) && (moveing == 1)) buttons_count = _BUTTONS_DELAY + 4;      // don't react on button when "end stop" click - for going up

#ifdef SALON_M_PARTER                                                                                   // open side rollers once when this one is fully up in auto mode (v19 fired every loop iteration)
  static bool peers_opened = false;
  if ((auto_mode) && (curent_pos == _MAX_COUNTER) && (moveing == 0)) {
    if (!peers_opened) {
      peers_opened = true;
      peer_cmd(157, "/TARGET?value=100");                                                              // open salon P
      peer_cmd(159, "/TARGET?value=100");                                                              // open salon L
    }
  } else peers_opened = false;
#endif

#ifdef KUCHNIA2_M_PARTER                                                                                // open side rollers once when this one is fully up in auto mode
  static bool k2_peers_opened = false;
  if ((auto_mode) && (curent_pos == _MAX_COUNTER) && (moveing == 0)) {
    if (!k2_peers_opened) {
      k2_peers_opened = true;
      peer_cmd(154, "/TARGET?value=100");                                                              // open kitchen2 P
      peer_cmd(156, "/TARGET?value=100");                                                              // open kitchen2 L
    }
  } else k2_peers_opened = false;
#endif

  ESP.wdtFeed();
}
