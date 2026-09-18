/**
 * OLED (128x64 text frame) and NeoPixel strip state as seen by the GUI.
 */
import { describe, it, expect } from 'vitest';
import { Esp8266Machine } from '../core/machine';

function machine(sketch: string, build: (m: Esp8266Machine) => void): Esp8266Machine {
  const m = new Esp8266Machine({ board: 'wemos-d1-mini' });
  m.netlist.addComponent('mcu', 'mcu', { board: 'wemos-d1-mini' });
  build(m);
  m.load(sketch);
  m.run();
  m.advance(5);
  return m;
}

describe('OLED SSD1306', () => {
  it('oledPrint places text at the character cell', () => {
    const m = machine(
      `void setup(){ Serial.begin(115200);
         Serial.println(oledBegin());
         oledClear(); oledPrint(0, 0, "Temp 23.5C"); oledShow(); }
       void loop(){ delay(10); }`,
      (m) => m.netlist.addComponent('oled1', 'oled', { addr: 0x3c }),
    );
    expect(m.serial[0].text).toBe('1');
    const frames = [...m.oledFrames().values()];
    expect(frames.length).toBe(1);
    expect(frames[0].cells[0].trimEnd()).toBe('Temp 23.5C');
  });

  it('text clips at the 21x8 cell grid and survives clipping', () => {
    const m = machine(
      `void setup(){ oledBegin();
         oledPrint(20, 7, "ABCD"); }
       void loop(){ delay(10); }`,
      (m) => m.netlist.addComponent('oled1', 'oled', {}),
    );
    expect(m.oledFrames().get('oled1')!.cells[7].trim()).toBe('A');
  });

  it('oledClear blanks the panel', () => {
    const m = machine(
      `void setup(){ oledBegin(); oledPrint(0,0,"X"); oledClear(); }
       void loop(){ delay(10); }`,
      (m) => m.netlist.addComponent('oled1', 'oled', {}),
    );
    expect(m.oledFrames().get('oled1')!.cells.join('').trim()).toBe('');
  });

  it('no panel => oledBegin returns 0 and prints are ignored', () => {
    const m = machine(
      `void setup(){ Serial.begin(115200); Serial.println(oledBegin()); oledPrint(0,0,"x"); }
       void loop(){ delay(10); }`,
      () => {},
    );
    expect(m.serial[0].text).toBe('0');
    expect(m.oledFrames().size).toBe(0);
  });
});

describe('NeoPixel strip', () => {
  it('npSetup allocates, npPixel colors, npShow publishes', () => {
    const m = machine(
      `void setup(){ Serial.begin(115200);
         Serial.println(npSetup(D7, 8));
         npPixel(D7, 2, 255, 0, 0);
         npPixel(D7, 7, 0, 255, 0);
         npShow(D7); }
       void loop(){ delay(10); }`,
      (m) => {
        m.netlist.addComponent('np1', 'neopixel', {});
        m.netlist.addWire('mcu.D7', 'np1.din');
      },
    );
    void m;
    const s = m.strips().get(13); // D7 = GPIO13
    expect(s).toBeDefined();
    expect(s!.count).toBe(8);
    expect(s!.pixels[2]).toBe(0xff0000);
    expect(s!.pixels[7]).toBe(0x00ff00);
    expect(s!.pixels[0]).toBe(0);
  });

  it('npSetup fails without a wired strip, out-of-range pixels ignored', () => {
    const m = machine(
      `void setup(){ Serial.begin(115200);
         Serial.println(npSetup(D6, 4));  // nothing wired to D6
         npSetup(D7, 4); npPixel(D7, 99, 1, 1, 1); }
       void loop(){ delay(10); }`,
      (m) => {
        m.netlist.addComponent('np1', 'neopixel', {});
        m.netlist.addWire('mcu.D7', 'np1.din');
      },
    );
    expect(m.serial[0].text).toBe('0');
    expect(m.strips().get(13)!.pixels.length).toBe(8); // physical default, not sketch 4
  });

  it('physical strip length comes from the component, not the sketch', () => {
    const m = machine(
      `void setup(){ npSetup(D7, 8);
         npPixel(D7, 2, 0, 255, 0);
         npPixel(D7, 10, 255, 0, 0); }   // past what the sketch declares
       void loop(){ delay(10); }`,
      (m) => {
        m.netlist.addComponent('np1', 'neopixel', { count: 15 });
        m.netlist.addWire('mcu.D7', 'np1.din');
      },
    );
    const s = m.strips().get(13)!;
    expect(s.physical).toBe(15);          // hardware: the config wins
    expect(s.count).toBe(8);              // program drives 8 of them
    expect(s.pixels.length).toBe(15);     // 15 LEDs rendered
    expect(s.pixels[2]).toBe(0x00ff00);
    expect(s.pixels[10]).toBe(0);         // write past the program's count lost
  });

  it('a sketch longer than the strip loses the extra pixels', () => {
    const m = machine(
      `void setup(){ npSetup(D7, 20);
         npPixel(D7, 3, 1, 2, 3);
         npPixel(D7, 7, 255, 0, 0); }     // past the physical strip
       void loop(){ delay(10); }`,
      (m) => {
        m.netlist.addComponent('np1', 'neopixel', { count: 5 });
        m.netlist.addWire('mcu.D7', 'np1.din');
      },
    );
    const s = m.strips().get(13)!;
    expect(s.physical).toBe(5);
    expect(s.pixels.length).toBe(5);
    expect(s.pixels[3]).toBe(0x010203);
    expect(s.pixels.filter((v) => v !== 0).length).toBe(1); // lost writes, no growth
  });

  it('strip length caps at 64', () => {
    const m = machine(
      `void setup(){ npSetup(D7, 300); } void loop(){ delay(10); }`,
      (m) => {
        m.netlist.addComponent('np1', 'neopixel', {});
        m.netlist.addWire('mcu.D7', 'np1.din');
      },
    );
    expect(m.strips().get(13)!.count).toBe(64);
  });
});
