/**
 * F4: the Adafruit_NeoPixel object API on top of the existing np* strip
 * primitives - what the roller-shutter v20 status lamp compiles to.
 */
import { describe, it, expect } from 'vitest';
import { Esp8266Machine } from '../core/machine';

function machine(source: string, decorate?: (m: Esp8266Machine) => void): Esp8266Machine {
  const m = new Esp8266Machine({ board: 'wemos-d1-mini' });
  decorate?.(m);
  m.load(source);
  m.run();
  m.advance(5);
  return m;
}

const strip = (m: Esp8266Machine) => {
  const s = m.strips().get(13); // D7 = GPIO13
  expect(s).toBeDefined();
  return s!;
};

describe('Adafruit_NeoPixel object API (F4)', () => {
  it('constructor + begin/Color/setPixelColor/show drives the strip', () => {
    const m = machine(
      `
      Adafruit_NeoPixel pixels(8, D7, NEO_GRB + NEO_KHZ800);
      void setup() {
        Serial.begin(9600);
        pixels.begin();
        pixels.setPixelColor(2, pixels.Color(255, 0, 0));
        pixels.setPixelColor(5, pixels.Color(0, 255, 0));
        pixels.show();
        Serial.println(pixels.numPixels());
      }
      void loop() { delay(10); }
      `,
      (mm) => {
        mm.netlist.addComponent('np1', 'neopixel', { count: 15 });
        mm.netlist.addWire('mcu.D7', 'np1.din');
      },
    );
    expect(m.faultReason).toBe(null);
    expect(m.serial.map((l) => l.text)).toEqual(['8']);
    expect(strip(m).pixels[2]).toBe(0xff0000);
    expect(strip(m).pixels[5]).toBe(0x00ff00);
    expect(strip(m).pixels[0]).toBe(0);
    expect(strip(m).count).toBe(8); // sketch count, not the physical 15
  });

  it('clear() blanks the strip, setBrightness is accepted', () => {
    const m = machine(
      `
      Adafruit_NeoPixel px(4, D7, NEO_GRB + NEO_KHZ800);
      void setup() {
        px.begin();
        px.setPixelColor(1, px.Color(10, 20, 30));
        px.setBrightness(80);
        px.clear();
        px.show();
      }
      void loop() { delay(10); }
      `,
      (mm) => {
        mm.netlist.addComponent('np1', 'neopixel', {});
        mm.netlist.addWire('mcu.D7', 'np1.din');
      },
    );
    expect(strip(m).pixels.every((p) => p === 0)).toBe(true);
  });

  it('getPixelColor returns what was written', () => {
    const m = machine(
      `
      Adafruit_NeoPixel px(4, D7, NEO_GRB + NEO_KHZ800);
      void setup() {
        Serial.begin(9600);
        px.begin();
        unsigned long c = px.Color(1, 2, 3);
        px.setPixelColor(3, c);
        Serial.println(px.getPixelColor(3));
      }
      void loop() { delay(10); }
      `,
      (mm) => {
        mm.netlist.addComponent('np1', 'neopixel', {});
        mm.netlist.addWire('mcu.D7', 'np1.din');
      },
    );
    // Adafruit packs Color as G<<16 | R<<8 | B
    expect(m.serial.map((l) => l.text)).toEqual([String((2 << 16) | (1 << 8) | 3)]);
  });

  it('writes without a wired strip are ignored, not fatal', () => {
    const m = machine(`
      Adafruit_NeoPixel px(4, D6, NEO_GRB + NEO_KHZ800);
      void setup() {
        Serial.begin(9600);
        px.begin();
        px.setPixelColor(0, px.Color(255, 0, 0));
        px.show();
        Serial.println(px.numPixels());
      }
      void loop() { delay(10); }
    `);
    expect(m.faultReason).toBe(null);
    expect(m.serial.map((l) => l.text)).toEqual(['4']);
  });

  it('a loop-driven status pattern like the v20 lamp runs', () => {
    const m = machine(
      `
      Adafruit_NeoPixel pixels(16, D7, NEO_GRB + NEO_KHZ800);
      int pos = 0;
      void paint(uint8_t r, uint8_t g, uint8_t b) {
        pixels.clear();
        pixels.setPixelColor(pos, pixels.Color(r, g, b));
        pixels.show();
      }
      void setup() {
        Serial.begin(9600);
        pixels.begin();
        paint(0, 255, 0);
        pos = 4;
        paint(255, 0, 0);
        Serial.println(pixels.getPixelColor(pos));
      }
      void loop() { delay(10); }
      `,
      (mm) => {
        mm.netlist.addComponent('np1', 'neopixel', { count: 16 });
        mm.netlist.addWire('mcu.D7', 'np1.din');
      },
    );
    expect(strip(m).pixels[4]).toBe(0xff0000);
    expect(strip(m).pixels[0]).toBe(0);
  });
});
