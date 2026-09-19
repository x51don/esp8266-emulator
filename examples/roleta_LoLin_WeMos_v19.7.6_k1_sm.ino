#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClient.h>
#include <ESP8266WebServer.h>
#include <ESP8266mDNS.h>
#include <WiFiUdp.h>
#include <ArduinoOTA.h>
#include <Ticker.h>
#include <Adafruit_NeoPixel.h>

//----------------------------------------------------------------------------------------------------------------------------------------------------------------

#define _VERSION "LoLin/WeMos Roller controller: (v19.7.6k1_sm)"         // this will be visible on front page of webserver

#define _ROLLERS 10                                                 // no of ip adreeses from 150
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

#ifdef GABINET_PARTER
  #define _BLUE_LEDS_NO 60                                  // no of leds in strip
  #define _BLUE_LEDS_MIN 0                                  // if ifrst leads are broken we can adjust range on begining of the strip
  #define _MAX_COUNTER 48                                   // max time (0.5 s) to OPEN schader
  #define _LOCAL_AP "Roleta_gp"                             // name for local access point
  #define _MY_IP 150                                        // static IP

  #define _MY_OFF HIGH                                      // relays trigered by LOW
  #define _MY_ON LOW

  #define _UP_SWITCH_PIN D7                                 // monostabile switchs to press, with hardware debouncers
  #define _DOWN_SWITCH_PIN D2                               // D8 stoped to work as PULL_UP, as this is spetial buton for reset purposes, do not use it again as pull_up
  #define _UP_RELAY_PIN D6                                  // relays to schader
  #define _DOWN_RELAY_PIN D5                                // never set them together to HIGH !
                                                            // for hardware protection, second relay should be feeded from NC pin of first relay
  volatile bool auto_mode_night = true;                     // should it be closed automaticaly at night?
#endif

#ifdef LAZIENKA_PARTER
  #define _BLUE_LEDS_NO 60                                  // no of leds in strip
  #define _BLUE_LEDS_MIN 0                                  // if ifrst leads are broken we can adjust range on begining of the strip
  #define _MAX_COUNTER 48                                   // max time to OPEN schader
  #define _LOCAL_AP "Roleta_lp"                             // name for local access point
  #define _MY_IP 151                                        // static IP

  #define _MY_OFF LOW                                       // relays trigered by HIGH
  #define _MY_ON HIGH

  #define _UP_SWITCH_PIN D7                                 // monostabile switchs to press, with hardware debouncers
  #define _DOWN_SWITCH_PIN D2                               // D8 stoped to work as PULL_UP, as this is spetial buton for reset purposes, do not use it again as pull_up
  #define _UP_RELAY_PIN D5                                  // relays to schader
  #define _DOWN_RELAY_PIN D6                                // never set them together to HIGH !
                                                            // for hardware protection, second relay should be feeded from NC pin of first relay
  volatile bool auto_mode_night = true;                     // should it be closed automaticaly at night?
#endif

#ifdef PRZEDPOKOJ_PARTER
  #define _BLUE_LEDS_NO 30                                  // no of leds in strip
  #define _BLUE_LEDS_MIN 0                                  // if ifrst leads are broken we can adjust range on begining of the strip
  #define _MAX_COUNTER 54                                   // max time to OPEN schader
  #define _LOCAL_AP "Roleta_pp"                             // name for local access point
  #define _MY_IP 152                                        // static IP

  #define _MY_OFF HIGH                                      // relays trigered by LOW
  #define _MY_ON LOW

  #define _UP_SWITCH_PIN D7                                 // monostabile switchs to press, with hardware debouncers
  #define _DOWN_SWITCH_PIN D2                               // D8 stoped to work as PULL_UP, as this is spetial buton for reset purposes, do not use it again as pull_up
  #define _UP_RELAY_PIN D5                                  // relays to schader
  #define _DOWN_RELAY_PIN D6                                // never set them together to HIGH !
                                                            // for hardware protection, second relay should be feeded from NC pin of first relay
  volatile bool auto_mode_night = true;                     // should it be closed automaticaly at night?
#endif

#ifdef KUCHNIA1_PARTER
  #define _BLUE_LEDS_NO 43                                  // no of leds in strip (szould be 60 but lat 17 are broken - temporary fix)
  #define _BLUE_LEDS_MIN 0                                  // if ifrst leads are broken we can adjust range on begining of the strip
  #define _MAX_COUNTER 48                                   // max time to OPEN schader
  #define _LOCAL_AP "Kuchnia1_k1p"                          // name for local access point
  #define _MY_IP 153                                        // static IP

  #define _MY_OFF HIGH                                      // relays trigered by LOW
  #define _MY_ON LOW

  #define _UP_SWITCH_PIN D3                                 // monostabile switchs to press, with hardware debouncers
  #define _DOWN_SWITCH_PIN D2                               // D8 stoped to work as PULL_UP, as this is spetial buton for reset purposes, do not use it again as pull_up
  #define _UP_RELAY_PIN D5                                  // relays to schader
  #define _DOWN_RELAY_PIN D6                                // never set them together to HIGH !
                                                            // for hardware protection, second relay should be feeded from NC pin of first relay
  volatile bool auto_mode_night = true;                     // should it be closed automaticaly at night?
#endif

#ifdef KUCHNIA2_P_PARTER
  #define _BLUE_LEDS_NO 30                                  // no of leds in strip
  #define _BLUE_LEDS_MIN 0                                  // if ifrst leads are broken we can adjust range on begining of the strip
  #define _MAX_COUNTER 48                                   // max time to OPEN schader
  #define _LOCAL_AP "Kuchnia2_k2Rp"                         // name for local access point
  #define _MY_IP 154                                        // static IP

  #define _MY_OFF HIGH                                      // relays trigered by LOW
  #define _MY_ON LOW

  #define _UP_SWITCH_PIN D3                                 // monostabile switchs to press, with hardware debouncers
  #define _DOWN_SWITCH_PIN D2                               // D8 stoped to work as PULL_UP, as this is spetial buton for reset purposes, do not use it again as pull_up
  #define _UP_RELAY_PIN D5                                  // relays to schader
  #define _DOWN_RELAY_PIN D6                                // never set them together to HIGH !
                                                            // for hardware protection, second relay should be feeded from NC pin of first relay
  volatile bool auto_mode_night = true;                     // should it be closed automaticaly at night?
#endif

#ifdef KUCHNIA2_M_PARTER
  #define _BLUE_LEDS_NO 30                                  // no of leds in strip
  #define _BLUE_LEDS_MIN 0                                  // if ifrst leads are broken we can adjust range on begining of the strip
  #define _MAX_COUNTER 48                                   // max time to OPEN schader
  #define _LOCAL_AP "Kuchnia2_k2Mp"                         // name for local access point
  #define _MY_IP 155                                        // static IP

  #define _MY_OFF HIGH                                      // relays trigered by LOW
  #define _MY_ON LOW

  #define _UP_SWITCH_PIN D3                                 // monostabile switchs to press, with hardware debouncers
  #define _DOWN_SWITCH_PIN D2                               // D8 stoped to work as PULL_UP, as this is spetial buton for reset purposes, do not use it again as pull_up
  #define _UP_RELAY_PIN D5                                  // relays to schader
  #define _DOWN_RELAY_PIN D6                                // never set them together to HIGH !
                                                            // for hardware protection, second relay should be feeded from NC pin of first relay
  volatile bool auto_mode_night = true;                     // should it be closed automaticaly at night?
#endif

#ifdef KUCHNIA2_L_PARTER
  #define _BLUE_LEDS_NO 30                                  // no of leds in strip
  #define _BLUE_LEDS_MIN 0                                  // if ifrst leads are broken we can adjust range on begining of the strip
  #define _MAX_COUNTER 48                                   // max time to OPEN schader
  #define _LOCAL_AP "Kuchnia2_k2Lp"                         // name for local access point
  #define _MY_IP 156                                        // static IP

  #define _MY_OFF HIGH                                      // relays trigered by LOW
  #define _MY_ON LOW

  #define _UP_SWITCH_PIN D3                                 // monostabile switchs to press, with hardware debouncers
  #define _DOWN_SWITCH_PIN D2                               // D8 stoped to work as PULL_UP, as this is spetial buton for reset purposes, do not use it again as pull_up
  #define _UP_RELAY_PIN D5                                  // relays to schader
  #define _DOWN_RELAY_PIN D6                                // never set them together to HIGH !
                                                            // for hardware protection, second relay should be feeded from NC pin of first relay
  volatile bool auto_mode_night = true;                     // should it be closed automaticaly at night?
#endif

#ifdef SALON_P_PARTER
  #define _BLUE_LEDS_NO 0                                   // no of leds in strip
  #define _BLUE_LEDS_MIN 0                                  // if ifrst leads are broken we can adjust range on begining of the strip
  #define _MAX_COUNTER 64                                   // max time to OPEN schader
  #define _LOCAL_AP "Roleta_sRp"                            // name for local access point
  #define _MY_IP 157                                        // static IP

  #define _MY_OFF LOW                                       // relays trigered by HIGH
  #define _MY_ON HIGH

  #define _UP_SWITCH_PIN D3                                 // monostabile switchs to press, with hardware debouncers
  #define _DOWN_SWITCH_PIN D2                               // D8 stoped to work as PULL_UP, as this is spetial buton for reset purposes, do not use it again as pull_up
  #define _UP_RELAY_PIN D5                                  // relays to schader
  #define _DOWN_RELAY_PIN D6                                // never set them together to HIGH !
                                                            // for hardware protection, second relay should be feeded from NC pin of first relay
  volatile bool auto_mode_night = true;                     // should it be closed automaticaly at night?
#endif

#ifdef SALON_M_PARTER
  #define _BLUE_LEDS_NO 148                                 // no of leds in strip
  #define _BLUE_LEDS_MIN 20                                  // if ifrst leads are broken we can adjust range on begining of the strip
  #define _MAX_COUNTER 64                                   // max time to OPEN schader
  #define _LOCAL_AP "Roleta_sMp"                            // name for local access point
  #define _MY_IP 160                                        // static IP

  #define _MY_OFF LOW                                       // relays trigered by HIGH
  #define _MY_ON HIGH

  #define _UP_SWITCH_PIN D3                                 // monostabile switchs to press, with hardware debouncers
  #define _DOWN_SWITCH_PIN D2                               // D8 stoped to work as PULL_UP, as this is spetial buton for reset purposes, do not use it again as pull_up
  #define _UP_RELAY_PIN D5                                  // relays to schader
  #define _DOWN_RELAY_PIN D6                                // never set them together to HIGH !
                                                            // for hardware protection, second relay should be feeded from NC pin of first relay
  volatile bool auto_mode_night = true;                     // should it be closed automaticaly at night?

  #define _SOUND_LIGHT_RELAY_PIN D7                         // additional light (240v) activated by sound
  #define _BULBS_LIGHT__RELAY_PIN D8                        // additional light (240V)
#endif

#ifdef SALON_L_PARTER
  #define _BLUE_LEDS_NO 0                                   // no of leds in strip
  #define _BLUE_LEDS_MIN 0                                  // if ifrst leads are broken we can adjust range on begining of the strip
  #define _MAX_COUNTER 64                                   // max time to OPEN schader
  #define _LOCAL_AP "Roleta_sLp"                            // name for local access point
  #define _MY_IP 159                                        // static IP

  #define _MY_OFF LOW                                       // relays trigered by HIGH
  #define _MY_ON HIGH

  #define _UP_SWITCH_PIN D3                                 // monostabile switchs to press, with hardware debouncers
  #define _DOWN_SWITCH_PIN D2                               // D8 stoped to work as PULL_UP, as this is spetial buton for reset purposes, do not use it again as pull_up
  #define _UP_RELAY_PIN D6                                  // relays to schader
  #define _DOWN_RELAY_PIN D5                                // never set them together to HIGH !
                                                            // for hardware protection, second relay should be feeded from NC pin of first relay
  volatile bool auto_mode_night = true;                     // should it be closed automaticaly at night?
#endif

//----------------------------------------------------------------------------------------------------------------------------------------------------------------

const char* ssid = "HomeAP";
//const char* ssid = "Orange-6E42";
//const char* ssid = "AndroidAP";                         // remember to comment FIXEDIP
const char* password = "digestorium";
const char* mySsid = _LOCAL_AP;                           // name of local AP

#define FIXEDIP                                           // comment this out if you don't want to assign a fixed IP to the ESP

//----------------------------------------------------------------------------------------------------------------------------------------------------------------

Ticker halfsecondTick;
Ticker fotoTick;

//----------------------------------------------------------------------------------------------------------------------------------------------------------------

#define _FOTO_OFFSET 14                                   // to make foto automation less sensitive  +- foto_target% (best value observed 14)
#define _FOTO_SEC 900                                     // how long to calculate mediana before move (ignores rapid light changes)

#define _MAX_CHANGE_COUNTER _MAX_COUNTER                  // usualy _MAX_COUNTER
#define _MAX_MOTION_TIME 30                               // how long light should be ON after motion detected 

#define _LIGHT_SENSOR_PIN A0                              // photoresistor pin, remember to connect to 3.3 V

#define _BLUE_LED_PIN D4                                  // Color led strip control pin (NeoPixel)

#define _MOTION_SENSOR_PIN D1                             // motion sensor pin (radar)

//----------------------------------------------------------------------------------------------------------------------------------------------------------------

volatile bool auto_mode = false;                          // if the roller work in automatic mode
volatile bool auto_mode_backup = false;                   // status backup in case of glitch
bool OTA_mode = false;                                    // if true, Over The Air programming is possible

HTTPClient http;

String hex;                                  //debuging
volatile int glitch_count = 0;

volatile int moveing = -1;                                // is roller moving ? -1 - down; 0 - not moving ; 1 - up (initial value -1 is set to close roler after restart)
volatile int moveing_last = 0;                            // what wasthe moveing valuei previous loop (initial value 0 is set to close roler after restart)
volatile int moveing_correction = 0;                      // every _MAX_COUNTER seconds up we have correct 1 second (roler up is slower then down by 1s econd)
volatile int foto_target = 0;                             // foto value to follow (only in automatic mode)
volatile int target_pos = 0;                              // point to follow (initial value 0 is set to close roler after restart)
volatile int curent_pos = _MAX_COUNTER;                   // for automation, will work only after full close of rolers
volatile int fotoValue = 0;                               // fotoresistor value in %
volatile int fotoValueMed = 0;                            // fotoValue mediana
volatile bool isItNight = false;                          // check if there is a night
volatile int after_change_counter = 0;                    // after foto automation set, roler will go to proper possition,
volatile int motion_time_counter = 0;                     // time light should be switch ON after motion detected (seconds)

volatile bool upflag = true;                              // checking if this is real press of the button or only glith
volatile bool downflag = true;

volatile int up_counter = 0;                              // counting pressed butons
volatile int down_counter = 0;                            // changing colors of led strip on lowest roler positon
volatile int _BUTTONS_DELAY = 2;                          // delay 1 seconds to avoid buttons bouncing
volatile int buttons_count = _MAX_COUNTER;

//----------------------------------------------------------------------------------------------------------------------------------------------------------------

Adafruit_NeoPixel strip = Adafruit_NeoPixel(_BLUE_LEDS_NO, _BLUE_LED_PIN, NEO_GRB + NEO_KHZ800);

//----------------------------------------------------------------------------------------------------------------------------------------------------------------

// but after _MAX_CHANGE_COUNTER seconds will lower the checking time to _FOTO_SEC seconds

#ifdef FIXEDIP
// Configure your own IP details in this section *********************
// Mac address should be different for each device in your LAN
//  byte arduino_mac[] = { 0xDE, 0xED, 0xBA, 0xFE, 0xFE, 0xED };
IPAddress wemos_ip( 192,  168,   1,  _MY_IP);                         // 254 is testing ip
IPAddress my_ip( 192, 168, 10, _MY_IP);                               // 254 is testing ip
IPAddress gateway_ip( 192,  168,   1,   1);
IPAddress my_gateway_ip( 192,  168,   10,   1);
IPAddress subnet_mask(255, 255, 255,   0);
IPAddress dns_ip(  8,   8,   8,   8);
// end of static IP configuration for ESP ***************************
#endif

//----------------------------------------------------------------------------------------------------------------------------------------------------------------

ESP8266WebServer server(80);

//----------------------------------------------------------------------------------------------------------------------------------------------------------------

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
  message += "<a href='/OTA'>/OTA</a> programming mode (remember to restart microcontroler before programming)<br><br>";
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

int getArgValue(String name)                                      // to extract value from webpage call eg. /TARGET?value=x
{
  for (uint8_t i = 0; i < server.args(); i++)
    if (server.argName(i) == name)
      return server.arg(i).toInt();
  return -1;
}

void setup(void) {
  pinMode(_UP_SWITCH_PIN , INPUT_PULLUP);                        // pins setup
  pinMode(_DOWN_SWITCH_PIN , INPUT_PULLUP);
  pinMode(_UP_RELAY_PIN , OUTPUT);
  pinMode(_DOWN_RELAY_PIN , OUTPUT);

  pinMode(_MOTION_SENSOR_PIN , INPUT);
  digitalWrite(_MOTION_SENSOR_PIN , LOW);

void ICACHE_RAM_ATTR UP_switch_pressed();                                              // heders of functions defined bellow, ICACHE_RAM_ATTR definies different part of ram and helps stabilise interrupts
void ICACHE_RAM_ATTR DOWN_switch_pressed();
void ICACHE_RAM_ATTR EVERY_HALFSECOND();
void ICACHE_RAM_ATTR FOTO_AUTO();

  attachInterrupt(_UP_SWITCH_PIN, UP_switch_pressed, FALLING);                         // buttons interrupts , do nod change to RISING, it causing butons to stop working
  attachInterrupt(_DOWN_SWITCH_PIN, DOWN_switch_pressed, FALLING);

  halfsecondTick.attach(0.5, EVERY_HALFSECOND);                                                 // 0.5 sec interupt
  fotoTick.attach(_FOTO_SEC, FOTO_AUTO);                                              // foto interupt

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

  // Wait for connection
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }

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
    UP_switch_pressed();
    upflag = true;
    if (target_pos > curent_pos) server.send(200, "text/plain", "Going UP");
    else server.send(200, "text/plain", "Full Stop!");
  });

  //roler DOWN or STOP
  server.on("/DOWN", []() {
    DOWN_switch_pressed();
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
;    STRIP_COLOR(strip.Color(0, 0, 0));
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

  //roler OTA Mode ON/OFF
  server.on("/OTA", []() {
    OTA_mode = !OTA_mode ;
    if (OTA_mode) {
      noInterrupts();
      server.send(200, "text/plain", "OTA mode ON, (it is always better to RESTART before OTA)");
    }
    else {
      interrupts();
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
    server.send(200, "text/plain", message);                                           // final message, this should speed up RESTART_ALL - no timeouts
    delay(250);
    ESP.restart();
  });

  server.on("/RESTART_NIGHT", []() {                                                   // hidden function to be restartet by remote controller
    if (auto_mode_night){
       String message =  "Restarting ...\n";
       server.send(200, "text/plain", message);                                           // final message
       delay(250);
       ESP.restart();
    } else {
       String message =  "Will not restart ...\n";
       server.send(200, "text/plain", message);
    };
  });

  // restart all microcontrollers
  server.on("/RESTART_ALL", []() {
    for ( int i = (_ROLLERS) ; i >= 0 ; i--) {
      String message = "http://192.168.1.";
      message += (150 + i);
      message += "/RESTART";
      if ((_WU[i] != -1) || ((i + 150) != _MY_IP)) {                      // skip _MY_IP, kitchen2 and 158
        http.begin(message);
        int httpCode = http.GET();
        http.end();
        delay(3000);
      };
    };
    //    if (httpCode > 0) { //Check the returning code
    //       String payload = http.getString();   //Get the request response payload
    //       Serial.println(payload);                     //Print the response payload
    //    };
    String message =  "Restarting ALL...\n";
    server.send(200, "text/plain", message);                                           // final message, this should speed up RESTART_ALL - no timeouts, and prevent infinite loop when browser is trying reload page
    delay(250);
    ESP.restart();
  });

  // Wake UP procedure
  server.on("/WAKE_UP", []() {
    int httpCode;

    String message = "http://192.168.1.152/TARGET?value=";                                             // to open PRZEDPOKÓJ as first (this will not work if PRZEDPOKÓJ will be initiator)
    message += _WU[2];
    http.begin(message);
    httpCode = http.GET();
    http.end();
    delay(3000);
    
    for ( int i = _ROLLERS ; i >=0 ; i--) {
      String message = "http://192.168.1.";
      message += (150 + i);
      message += "/TARGET?value=";
      message += _WU[i];
      if ((_WU[i] != -1) || ((i + 150) != _MY_IP) || ((i + 150) != 152)) {                                      // skip _MY_IP, kitchen2, przedpokoj and 158
        http.begin(message);
        httpCode = http.GET();
        http.end();
        delay(3000);
      };
    };
    target_pos = (int)(((float)_WU[_MY_IP-150] * (float)_MAX_COUNTER) / (float)100);                    // to open itself as a last one 
  });

  // to set roler  position [0-100]
  server.on("/TARGET", []() {
    server.send(200, "text/plain", "TARGET set");
    int value = getArgValue("value");
    target_pos = (int)(((float)value * (float)_MAX_COUNTER) / (float)100);
    if (target_pos < 0) target_pos = 0;
    if (target_pos > _MAX_COUNTER) target_pos = _MAX_COUNTER;
    auto_mode = false;
  });


  // set all rollers to one value
  server.on("/TARGET_ALL", []() {
    server.send(200, "text/plain", "TARGET set");
    int value = getArgValue("value");
    for ( int i = (_ROLLERS) ; i >= 0  ; i--) {
      String message = "http://192.168.1.";
      message += (i + 150);
      message += "/TARGET?value=";
      message += value;
      if ((_WU[i] != -1) || ((i + 150) != _MY_IP)) {                  // skip _MY_IP and kitchen and 158
        http.begin(message);
        int httpCode = http.GET();
        http.end();
        delay(3000);
      };
    };
    target_pos = (int)(((float)value * (float)_MAX_COUNTER) / (float)100);
    if (target_pos < 0) target_pos = 0;
    if (target_pos > _MAX_COUNTER) target_pos = _MAX_COUNTER;
    auto_mode = false;
  });

  // to set photoresistor value to be follow [0-100]
  server.on("/FOTO", []() {
    server.send(200, "text/plain", "FOTO set");
    foto_target =  getArgValue("value");
    if (foto_target < 0) foto_target = 0;
    if (foto_target > 100) foto_target = 100;
    auto_mode = true;
    auto_mode_night = true;
    if (curent_pos == _MAX_COUNTER) curent_pos += -1;                                   // trick to avoid side rollers to go up when we have 3 rollers and photo is set in max upper position
    after_change_counter = _MAX_CHANGE_COUNTER;
;    STRIP_COLOR(strip.Color(0, 0, 0));
    strip.clear();
  });

  // set the Led Strip color
  server.on("/STRIP", []() {
    server.send(200, "text/plain", "STRIP set");
    int red = getArgValue("RED");
    int green = getArgValue("GREEN");
    int blue = getArgValue("BLUE");

    STRIP_COLOR(strip.Color(red, green, blue));
    auto_mode = false;
    auto_mode_night = false;
  });

  // set the Led Strip color in hex (not working jet)
  server.on("/STRIP_HEX", []() {
    server.send(200, "text/plain", "STRIP_HEX set");
    //    uint32_t hex = getArgValue("HEX");
    hex = "0x";
    hex += getArgValue("HEX");

    //    STRIP_COLOR(hex);
    auto_mode = false;
  });

  //----------------------------------------------------------------------------------------------------------------------------------------------------------------

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
  strip.show();                                                                             // Initialize all pixels to 'off'

  STRIP_COLOR(strip.Color(0, 0, 10)); // Blue Night
}

//----------------------------------------------------------------------------------------------------------------------------------------------------------------

void loop(void) {

   if( !WiFi.isConnected() ) {                                                                      //reconnecting wifi
    Serial.println( "Disconnected!" );
    WiFi.reconnect();
    WiFi.waitForConnectResult();
   }
   
//   ESP.wdtFeed();                                                                                  //feed watchdog

  //handle OTA
  if (OTA_mode) {

    ArduinoOTA.handle();
    delay(10);  //Don't Delete or it will stop working

    //handle webserver
    server.handleClient();
    delay(10);  //Don't Delete or it will stop working

  } else {

  //handle webserver
  server.handleClient();
  delay(10);  //Don't Delete or it will stop working

  //handle movement

//  noInterrupts();
  if (moveing_last != moveing) {
    if (buttons_count <= _BUTTONS_DELAY) buttons_count = _BUTTONS_DELAY;                             // anty boucing when relay click  - "if" is needed when first calibration is done
    switch (moveing) {
      case -1:
        digitalWrite(_UP_RELAY_PIN , _MY_OFF);
        delay(250);                                           // to be sure that only one relay is on
        digitalWrite(_DOWN_RELAY_PIN , _MY_ON);
        break;
      case 0:
        digitalWrite(_DOWN_RELAY_PIN , _MY_OFF);
        digitalWrite(_UP_RELAY_PIN , _MY_OFF);
        break;
      case 1:
        digitalWrite(_DOWN_RELAY_PIN , _MY_OFF);                  //always set HIGH pin then LOW
        delay(250);                                           // to be sure that only one relay is on
        digitalWrite(_UP_RELAY_PIN , _MY_ON);
        break;
    };
    moveing_last = moveing;
  };
;  if ((motion_time_counter == 1) || ((curent_pos == 1) && (moveing == 1))) STRIP_COLOR(strip.Color(0, 0, 0));   // Switch light off when going up
   if ((motion_time_counter == 1) || ((curent_pos == 1) && (moveing == 1))) strip.clear();   // Switch light off when going up
   if ((motion_time_counter == 1) || ((curent_pos == 1) && (moveing == -1))) down_counter = 0;                   // reset  the light cycle when pressing down button
  if ((curent_pos == 0) && (moveing == 0) && (moveing_last == moveing) && (buttons_count == 1))
    switch (down_counter) {
      case 0:
        STRIP_COLOR(strip.Color(10, 0, 0)); // Red Night
        break;
      case 1:
        STRIP_COLOR(strip.Color(255, 150, 0)); // Orange
        break;
      case 2:
        STRIP_COLOR(strip.Color(255, 255, 255));  // White
        break;
      case 3:
;        STRIP_COLOR(strip.Color(0, 0, 0)); // Off
        strip.clear();
        break;
      case 4:
        STRIP_COLOR(strip.Color(255, 0, 0)); // Red
        break;
      case 5:
        STRIP_COLOR(strip.Color(0, 255, 0)); // Green
        break;
      case 6:
        STRIP_COLOR(strip.Color(0, 0, 255)); // Blue
        break;
    };
  if ((curent_pos <= 4) && (moveing == -1)) buttons_count = _BUTTONS_DELAY + 4 ;                                       // don't react on button when "end stop" click - for going down
  if ((curent_pos >= (_MAX_COUNTER - 4)) && (moveing == 1)) buttons_count = _BUTTONS_DELAY + 4;                        // don't react on button when "end stop" click - for going up

//#ifdef PRZEDPOKOJ_PARTER
//  if (isItNight) NIGHT_CLOSE();
//#endif

#ifdef SALON_M_PARTER                                                                                                  // open side rolers if in auto_mode and salon M is all way up
  if ((auto_mode) && (curent_pos == _MAX_COUNTER) && (moveing == 0)) {
//    ESP.wdtFeed();                                                                                  //feed watchdog 
    int httptCode;
    HTTPClient httpt;
    httpt.begin("http://192.168.1.157/TARGET?value=100");                                           // open salon P
    httptCode = httpt.GET();
    httpt.end();
//    ESP.wdtFeed();                                                                                  //feed watchdog
    httpt.begin("http://192.168.1.159/TARGET?value=100");                                           // open salon L
    httptCode = httpt.GET();
    httpt.end();
  };
#endif
#ifdef KUCHNIA2_M_PARTER                                                                                                // open side rolers if in auto_mode and KUCHNIA2 M is all way up
  if ((auto_mode) && (curent_pos == _MAX_COUNTER) && (moveing == 0)) {
    int httptCode;
    HTTPClient httpt;
    httpt.begin("http://192.168.1.154/TARGET?value=100");                                           // open kitchen2 P
    httptCode = httpt.GET();
    httpt.end();
    httpt.begin("http://192.168.1.156/TARGET?value=100");                                           // open kitchen2 L
    httptCode = httpt.GET();
    httpt.end();
  };
#endif

//  interrupts();
  };
  ESP.wdtFeed();                                                                                  //feed watchdog
}

//----------------------------------------------------------------------------------------------------------------------------------------------------------------

void ICACHE_RAM_ATTR UP_switch_pressed() {
  noInterrupts();
  if (buttons_count == 0) {
    up_counter += 1;
    auto_mode_backup = auto_mode;
    auto_mode = false;
    if ((moveing == 0) && (curent_pos < _MAX_COUNTER)) {
      target_pos = _MAX_COUNTER;
    } else {
      if ((moveing == 0) && (curent_pos == _MAX_COUNTER)) {                        // force position correction if it is all way up
        curent_pos -= 10;
      } else {
        target_pos = curent_pos;
      };
    };
    upflag = false;
  };
  interrupts();
}

void ICACHE_RAM_ATTR DOWN_switch_pressed() {
  noInterrupts();
  if (buttons_count == 0) {
    if (down_counter < 6) down_counter += 1;                                    //cycle lights when pressing down button on lower roler position
    else down_counter = 0;
    auto_mode_backup = auto_mode;
    auto_mode = false;
    if ((moveing == 0) && (curent_pos > 0)) {
      target_pos = 0;
    } else {
      target_pos = curent_pos;
    };
    buttons_count = 1;                                                         // need to be 1 to cycle lights
    downflag = false;
  };
  interrupts();
}

void MOTION_detected() {
  noInterrupts();
  if ((auto_mode == false) && (curent_pos < 1)) {
    STRIP_COLOR(strip.Color(255, 255, 200)); // warm white light
    motion_time_counter = _MAX_MOTION_TIME ;
  }
  interrupts();
}

void ICACHE_RAM_ATTR EVERY_HALFSECOND()
{
  noInterrupts();
//  ESP.wdtFeed();                                                                                  //feed watchdog
  
  if ((digitalRead(_UP_SWITCH_PIN)==HIGH) && (upflag == false)) {                                 // check if button is still pressed (every 0.5 sec)
     target_pos = curent_pos;                                                                     // if not, ignore
     auto_mode = auto_mode_backup;                                                                // recover auto_mode from backup
     glitch_count ++;
  };

  if ((digitalRead(_DOWN_SWITCH_PIN)==HIGH) && (downflag == false)) {                             // check if button is still pressed (every 0.5 sec)
     target_pos = curent_pos;                                                                     // if not, ignore
     auto_mode = auto_mode_backup;                                                                // recover auto_mode from backup
     glitch_count ++;
  };
  
  moveing = 0;
  if ((curent_pos > 0) && (curent_pos > target_pos)) {
    moveing = -1;
//    if (moveing_correction < int((float)_MAX_COUNTER / 14.0)) moveing_correction += 1;          //need to think about it                                     // corecting position by 1s every 1/14 of _MAX_COUNTER (difference in speed when going up and down)
//    else {
//      moveing_correction = 0;
//      curent_pos -= 2;
//    };
  };
  if ((curent_pos < target_pos) && (curent_pos < _MAX_COUNTER)) {
    moveing = 1;
//    if (moveing_correction < int((float)_MAX_COUNTER / 13.5)) moveing_correction += 1;                                               // corecting position by 1s every 1/14 of _MAX_COUNTER
//    else {
//      moveing_correction = 0;
//      curent_pos -= 2;
//    };
  };
  curent_pos += moveing;

  //read foto Value and normalise [0-100]
  fotoValue = (int)((float)analogRead(_LIGHT_SENSOR_PIN) * (100.0 / 1023.0));
  fotoValueMed = (int)((float)(fotoValueMed + fotoValue) / 2.0);

  if ((auto_mode == true) && (after_change_counter > 0)) {
    if ((fotoValue <= (foto_target + _FOTO_OFFSET)) && (curent_pos < _MAX_COUNTER)) target_pos += 1;
    if ((fotoValue >= (foto_target - _FOTO_OFFSET)) && (curent_pos > 0)) target_pos -= 1;
    after_change_counter -= 1;
  };
  if (motion_time_counter > 0) motion_time_counter -= 1;
  if (buttons_count > 0) buttons_count -= 1;
  else buttons_count = 0;                                                                                            // for case then it is equal -1 (used for light cycle)

  upflag = true;
  downflag = true;
  interrupts();
}

void ICACHE_RAM_ATTR FOTO_AUTO()
{
  noInterrupts();
  int x = foto_target - fotoValue;

  if (((fotoValueMed >= (foto_target + _FOTO_OFFSET))) || ((fotoValueMed <= (foto_target - _FOTO_OFFSET)))) after_change_counter = (abs(x) / 2) ;

#ifdef PRZEDPOKOJ_PARTER
  if ((auto_mode_night == true) && (curent_pos > ((int)(((float)35 * (float)_MAX_COUNTER) / (float)100))) && ( fotoValueMed <= 3 )) {              // when to close roller (shout be bigerthen 3 to not be influenced by red night light, and 35% from bottom)
    isItNight = true;
  };
#endif
  
  fotoValueMed = fotoValue;
  interrupts();
}

void NIGHT_CLOSE()
{
    for ( int i = (_ROLLERS) ; i >= 0 ; i--) {
      String message = "http://192.168.1.";
      message += (150 + i);
      message += "/RESTART_NIGHT";
      if ((_WU[i] != -1) || ((i + 150) != _MY_IP)) {                      // skip _MY_IP, kitchen2 and 158
        http.begin(message);
        int httpCode = http.GET();
        http.end();
        delay(3000);
      };
    };
    //    if (httpCode > 0) { //Check the returning code
    //       String payload = http.getString();   //Get the request response payload
    //       Serial.println(payload);                     //Print the response payload
    //    };
    delay(250);
    ESP.restart();
}

void STRIP_COLOR(uint32_t c) {
  for (uint16_t i = _BLUE_LEDS_MIN; i < strip.numPixels(); i++) {
    strip.setPixelColor(i, c);
  };
  strip.show();
  motion_time_counter = 0;
}
