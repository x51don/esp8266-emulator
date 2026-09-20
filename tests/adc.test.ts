/**
 * F2.4: the ADC is the ESP8266EX 10-bit SAR with a 1.0 V native full scale,
 * a compressed band below ~0.25 V, and a board-level input divider that
 * scales the A0 silk pin to the documented 0..3.3 V range.
 */
import { describe, it, expect } from 'vitest';
import { getBoard } from '../core/boards';
import { Esp8266Machine } from '../core/machine';

function machineForcing(volts: number, board = 'wemos-d1-mini'): Esp8266Machine {
  const m = new Esp8266Machine({ board });
  m.netlist.addComponent('mcu', 'mcu', { board });
  m.netlist.pinForce('adc1', volts, 'mcu.A0');
  return m;
}

describe('board ADC attributes (F2.4)', () => {
  it('the chip itself saturates at 1.0 V on TOUT', () => {
    expect(getBoard('wemos-d1-mini').adc.chipFullScaleV).toBe(1.0);
  });

  it('the board divider maps 3.3 V on A0 to full-scale 1.0 V on TOUT', () => {
    const d = getBoard('wemos-d1-mini').adc.divider;
    expect(d).not.toBeNull();
    const vOut = 3.3 * (d!.shuntOhms / (d!.seriesOhms + d!.shuntOhms));
    expect(Math.abs(vOut - 1.0)).toBeLessThan(0.02);
  });
});

describe('ADC transfer curve (F2.4)', () => {
  it('mid-scale is linear on the documented 0..3.3 V A0 scale', () => {
    const code = machineForcing(1.65).analogRead(17);
    expect(Math.abs(code - 512)).toBeLessThanOrEqual(4);
  });

  it('full 3.3 V on A0 saturates at exactly 1023', () => {
    expect(machineForcing(3.3).analogRead(17)).toBe(1023);
  });

  it('below the 0.25 V knee the code is compressed, not linear', () => {
    // 0.66 V on A0 -> 0.2 V on TOUT: linear would say 205, the chip says ~164
    const code = machineForcing(0.66).analogRead(17);
    expect(Math.abs(code - 164)).toBeLessThanOrEqual(8);
  });

  it('deep in the dead band readings collapse quadratically', () => {
    // 0.33 V on A0 -> 0.1 V TOUT: linear 102, chip ~41
    const code = machineForcing(0.33).analogRead(17);
    expect(Math.abs(code - 41)).toBeLessThanOrEqual(8);
  });

  it('the curve is continuous across the knee (0.25 V TOUT)', () => {
    const code = machineForcing(0.825).analogRead(17);
    expect(Math.abs(code - 256)).toBeLessThanOrEqual(4);
  });
});

describe('ADC from the sketch (F2.4)', () => {
  it('analogRead(A0) reports the compressed low band, not the linear one', () => {
    const m = machineForcing(0.66);
    m.load(`
      void setup() { Serial.begin(115200); }
      void loop() { Serial.println(analogRead(A0)); delay(50); }
    `);
    m.run();
    m.advance(60);
    const code = Number(m.serial[m.serial.length - 1].text);
    expect(code).toBeLessThanOrEqual(172); // linear model would print 205
    expect(code).toBeGreaterThanOrEqual(156);
  });
});
