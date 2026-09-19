/**
 * P3.5: the OLED is a real 128x64 SSD1306 framebuffer. Drawing commands
 * paint a back buffer; oledShow() commits it, so half-drawn frames never
 * reach the panel (and partial updates are visible in tests). The legacy
 * 8x21 text layer still works on top - print() keeps its cell semantics.
 */
import { describe, it, expect } from 'vitest';
import { Esp8266Machine } from '../core/machine';

function withOled(): Esp8266Machine {
  const m = new Esp8266Machine({ board: 'wemos-d1-mini' });
  m.netlist.addComponent('mcu', 'mcu', { board: 'wemos-d1-mini' });
  m.netlist.addComponent('oled1', 'oled', { addr: 0x3c });
  return m;
}

function run(m: Esp8266Machine, body: string): void {
  m.load(`void setup() { Serial.begin(115200); oledBegin(0x3c); ${body} } void loop() { delay(20); }`);
  m.run();
  m.advance(30);
}

const px = (m: Esp8266Machine, x: number, y: number): number =>
  m.oledFrames().get('oled1')!.fb[(y << 4) + (x >> 3)] & (1 << (x & 7)) ? 1 : 0;

const lit = (m: Esp8266Machine): number => {
  let n = 0;
  for (const b of m.oledFrames().get('oled1')!.fb) n += (b as number).toString(2).split('1').length - 1;
  return n;
};

describe('OLED framebuffer 128x64 (P3.5)', () => {
  it('pixels reach the panel only after show()', () => {
    const m = withOled();
    run(m, `oledSetPixel(5, 6, 1);`);
    expect(px(m, 5, 6)).toBe(0); // not committed yet
    run(m, `oledSetPixel(5, 6, 1); oledShow();`);
    expect(px(m, 5, 6)).toBe(1);
  });

  it('coordinates outside the panel are dropped', () => {
    const m = withOled();
    run(m, `oledSetPixel(128, 0, 1); oledSetPixel(-1, 0, 1); oledSetPixel(0, 64, 1); oledShow();`);
    expect(lit(m)).toBe(0);
  });

  it('a diagonal line draws every step (Bresenham)', () => {
    const m = withOled();
    run(m, `oledLine(0, 0, 10, 10, 1); oledShow();`);
    for (let i = 0; i <= 10; i++) expect(px(m, i, i)).toBe(1);
    expect(lit(m)).toBe(11);
  });

  it('rect is an outline, fillRect is filled', () => {
    const m = withOled();
    run(m, `oledRect(2, 2, 10, 8, 1); oledShow();`);
    expect(px(m, 2, 2)).toBe(1);
    expect(px(m, 6, 2)).toBe(1); // top edge
    expect(px(m, 6, 5)).toBe(0); // interior stays dark
    expect(px(m, 11, 9)).toBe(1); // far corner (x+ w - 1)
    run(m, `oledFillRect(2, 2, 10, 8, 1); oledShow();`);
    expect(px(m, 6, 5)).toBe(1);
    expect(px(m, 11, 9)).toBe(1);
    expect(px(m, 12, 10)).toBe(0);
  });

  it('clear wipes the panel on show', () => {
    const m = withOled();
    run(m, `oledFillRect(0, 0, 128, 64, 1); oledShow();`);
    expect(lit(m)).toBe(128 * 64);
    run(m, `oledFillRect(0, 0, 128, 64, 1); oledClear(); oledShow();`);
    expect(lit(m)).toBe(0);
  });

  it('legacy text layer still renders into cells on show', () => {
    const m = withOled();
    run(m, `oledPrint(0, 0, "HI"); oledShow();`);
    expect(m.oledFrames().get('oled1')!.cells[0].startsWith('HI')).toBe(true);
  });
});
