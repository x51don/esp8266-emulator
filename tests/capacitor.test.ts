/**
 * P3.4 capacitor: the model is the exact RC relaxation - between solves the
 * plate voltage exponentially tracks the Thevenin equivalent of the network
 * around it, tau = R_th * C. A cap behind a 10k resistor on the 3V3 rail
 * charges to 63% of the rail in one tau, and keeps its charge when the
 * network is removed (no leak path).
 */
import { describe, it, expect } from 'vitest';
import { Esp8266Machine } from '../core/machine';

// R_th = 10k, C = 100 uF  ->  tau = 1 s = 1000 ms
function capMachine(uf: number): Esp8266Machine {
  const m = new Esp8266Machine({ board: 'wemos-d1-mini' });
  m.netlist.addComponent('mcu', 'mcu', { board: 'wemos-d1-mini', pins: ['A0', '3V3', 'GND'] });
  m.netlist.addComponent('r1', 'resistor', { resistance: 10_000 });
  m.netlist.addComponent('c1', 'cap', { uf });
  m.netlist.addWire('mcu.3V3', 'r1.p1');
  m.netlist.addWire('r1.p2', 'c1.p1');
  m.netlist.addWire('c1.p1', 'mcu.A0');
  m.netlist.addWire('c1.p2', 'mcu.GND');
  return m;
}

const volts = (m: Esp8266Machine): number => m.netlist.analogVolts('c1.p1') ?? 0;

describe('RC charging curve (P3.4)', () => {
  it('one tau reaches 63% of the rail', () => {
    const m = capMachine(100);
    m.advance(1000); // exactly tau; advance relaxes caps even with no sketch
    expect(volts(m)).toBeCloseTo(3.3 * (1 - Math.E ** -1), 1);
  });

  it('six taus are fully charged', () => {
    const m = capMachine(100);
    m.advance(6000);
    expect(volts(m)).toBeGreaterThan(3.29);
    expect(volts(m)).toBeLessThanOrEqual(3.31);
  });

  it('ten times the capacitance charges ten times slower', () => {
    const m = capMachine(1000); // tau = 10 s
    m.advance(1000); // one tenth of a tau
    expect(volts(m)).toBeCloseTo(3.3 * (1 - Math.E ** -0.1), 1);
  });

  it('analogRead follows the curve', () => {
    const m = capMachine(100);
    m.load(`
      void setup() { Serial.begin(115200); }
      void loop() { Serial.println(analogRead(A0)); delay(250); }
    `);
    m.run();
    const texts = () => m.serial.map((l) => Number(l.text));
    m.advance(300);
    const early = Math.max(...texts());
    m.advance(6000);
    const late = texts().at(-1)!;
    expect(early).toBeLessThan(400); // 0.3 tau -> ADC ~270, still far from rail
    expect(late).toBeGreaterThan(1000); // rail = 1023
  });

  it('with no leak path the charge holds; through 10k it decays with tau', () => {
    const m = capMachine(100);
    m.advance(6000);
    expect(volts(m)).toBeGreaterThan(3.29);
    // lift the source resistor - a floating cap keeps its voltage
    m.netlist.addComponent('r1', 'resistor', { resistance: 1e12 });
    m.advance(1000);
    expect(volts(m)).toBeGreaterThan(3.2);
    // bridge it with a 10k to GND: tau = (10k || 10k) * 100uF = 500 ms
    m.netlist.addComponent('r2', 'resistor', { resistance: 10_000 });
    m.netlist.addWire('c1.p1', 'r2.p1');
    m.netlist.addWire('r2.p2', 'mcu.GND');
    m.advance(500);
    expect(volts(m)).toBeLessThan(3.2); // on its way down
    expect(volts(m)).toBeGreaterThan(0.2); // not instant
  });

  it('reset clears capacitor state', () => {
    const m = capMachine(100);
    m.advance(6000);
    m.reset();
    // discharged; the node reads ~0 (the 10k still charges it from t=0)
    expect(volts(m)).toBeLessThan(0.01);
  });
});
