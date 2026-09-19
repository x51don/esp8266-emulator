/**
 * F1.3 external-part physics: LED forward voltage depends on the die colour
 * (red ~1.8 V, blue/white ~3.0 V), and a real tactile button chatters for a
 * few milliseconds - one press is a burst of edges, not one clean edge.
 */
import { describe, it, expect } from 'vitest';
import { Esp8266Machine } from '../core/machine';

function ledOnPin(color: string, r: number, extra: Record<string, unknown> = {}) {
  const m = new Esp8266Machine({ board: 'wemos-d1-mini' });
  m.netlist.addComponent('mcu', 'mcu', { board: 'wemos-d1-mini', pins: ['D5', 'GND'] });
  m.netlist.addComponent('led1', 'led', { color, ...extra });
  m.netlist.addComponent('r1', 'resistor', { resistance: r });
  m.netlist.addWire('mcu.D5', 'led1.a');
  m.netlist.addWire('led1.k', 'r1.p1');
  m.netlist.addWire('r1.p2', 'mcu.GND');
  m.load('void setup(){ pinMode(D5, OUTPUT); digitalWrite(D5, HIGH); } void loop(){ delay(10); }');
  m.run();
  m.advance(1);
  return m;
}

const ledMa = (m: Esp8266Machine): number => m.circuit().leds.get('led1')?.currentMa ?? 0;

describe('LED forward voltage by colour (F1.3)', () => {
  it('red at 220 ohms passes ~6.8 mA (Vf 1.8)', () => {
    expect(ledMa(ledOnPin('red', 220))).toBeCloseTo((3.3 - 1.8) / 220 * 1000, 1);
  });

  it('blue passes far less current than red on the same resistor (Vf 3.0)', () => {
    const blue = ledMa(ledOnPin('blue', 220));
    expect(blue).toBeCloseTo((3.3 - 3.0) / 220 * 1000, 1);
    expect(blue).toBeLessThan(2);
  });

  it('explicit forwardV beats the colour table', () => {
    expect(ledMa(ledOnPin('blue', 220, { forwardV: 1.5 }))).toBeCloseTo((3.3 - 1.5) / 220 * 1000, 1);
  });

  it('unknown colour still gets the generic 2.0 V default', () => {
    expect(ledMa(ledOnPin('chartreuse', 220))).toBeCloseTo((3.3 - 2.0) / 220 * 1000, 1);
  });
});

describe('button contact bounce (F1.3)', () => {
  const BTN_SKETCH =
    'void setup(){ pinMode(D2, INPUT_PULLUP); } void loop(){ delay(1); }';

  /** D2 (GPIO4) with a button to GND, `bounce` ms of chatter. */
  function bouncing(bounce: number): Esp8266Machine {
    const m = new Esp8266Machine({ board: 'wemos-d1-mini' });
    m.netlist.addComponent('mcu', 'mcu', { board: 'wemos-d1-mini', pins: ['D2', 'GND'] });
    m.netlist.addComponent('btn1', 'button', { bounce });
    m.netlist.addWire('mcu.D2', 'btn1.p1');
    m.netlist.addWire('btn1.p2', 'mcu.GND');
    m.load(BTN_SKETCH);
    m.run();
    return m;
  }

  it('one press is a burst: closed-open-closed-open-closed over the bounce window', () => {
    const m = bouncing(4); // 4 ms chatter window
    m.press('btn1', true);
    expect(m.pinLevel(4)).toBe(0); // first make
    m.advance(1.2);
    expect(m.pinLevel(4)).toBe(1); // bounced open
    m.advance(1.2);
    expect(m.pinLevel(4)).toBe(0); // made again
    m.advance(1.0);
    expect(m.pinLevel(4)).toBe(1); // open once more
    m.advance(1.0);
    expect(m.pinLevel(4)).toBe(0); // settled closed for good
    m.advance(20);
    expect(m.pinLevel(4)).toBe(0);
  });

  it('a CHANGE interrupt counts the chatter, then goes quiet', () => {
    const m = bouncing(4);
    m.load(
      'volatile int n = 0;' +
      'void isr(){ n++; Serial.print("edge "); Serial.println(n); }' +
      'void setup(){ pinMode(D2, INPUT_PULLUP); attachInterrupt(digitalPinToInterrupt(D2), isr, CHANGE); }' +
      'void loop(){ delay(1); }',
    );
    m.run();
    m.press('btn1', true);
    // 0.5 ms steps: edges landing inside ONE advance() merge into a single
    // ISR entry, exactly like a busy MCU missing back-to-back pulses.
    for (let t = 0; t < 30; t += 0.5) m.advance(0.5);
    const edges = (m.serial.map((l) => l.text).join("\n").match(/edge /g) ?? []).length;
    expect(edges).toBeGreaterThanOrEqual(3); // not one clean edge: the burst is real
    const after = m.serial.map((l) => l.text).join("\n");
    m.advance(50); // settled contact: no more edges
    expect(m.serial.map((l) => l.text).join("\n")).toBe(after);
  });

  it('bounce:0 buttons stay clean - one press, one edge', () => {
    const m = bouncing(0);
    m.press('btn1', true);
    expect(m.pinLevel(4)).toBe(0);
    m.advance(10);
    expect(m.pinLevel(4)).toBe(0);
  });

  it('chip reset settles a pending bounce instead of resurrecting it', () => {
    const m = bouncing(4);
    m.press('btn1', true);
    m.advance(1.2); // mid-chatter
    m.reset();
    m.advance(0.2);
    // the logical press still holds (buttons live outside the chip), but the
    // old chatter schedule must not produce further flips
    const before = m.pinLevel(4);
    m.advance(10);
    expect(m.pinLevel(4)).toBe(before);
  });
});
