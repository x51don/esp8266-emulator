/**
 * attachInterrupt()/detachInterrupt(): edges on a tracked GPIO queue the
 * named ISR on the cooperative ISR lane (same lane as timer0ISR). The button
 * between the pin and GND is the edge source, exactly like on a breadboard.
 */
import { describe, it, expect } from 'vitest';
import { Esp8266Machine } from '../core/machine';

function pressableSketch(body: string): string {
  return `
    int hits = 0;
    void onHit() { hits = hits + 1; }
    void setup() {
      Serial.begin(115200);
      pinMode(D4, INPUT_PULLUP);
      ${body}
    }
    void loop() { Serial.println(hits); delay(20); }
  `;
}

// D4 with a button to GND and the sketch's INPUT_PULLUP: press = falling,
// release = rising.
function wired(): Esp8266Machine {
  const m = new Esp8266Machine({ board: 'wemos-d1-mini' });
  m.netlist.addComponent('mcu', 'mcu', { board: 'wemos-d1-mini', pins: ['D4', '3V3', 'GND'] });
  m.netlist.addComponent('btn', 'button');
  m.netlist.addWire('btn.p1', 'mcu.D4');
  m.netlist.addWire('btn.p2', 'mcu.GND');
  return m;
}

const lastHit = (m: Esp8266Machine): number =>
  Number(m.serial[m.serial.length - 1].text);

describe('attachInterrupt (P3.2)', () => {
  it('FALLING: a button press runs the ISR', () => {
    const m = wired();
    m.load(pressableSketch(`attachInterrupt(D4, onHit, FALLING);`));
    m.run();
    m.advance(30);
    expect(lastHit(m)).toBe(0);
    m.press('btn', true);
    m.advance(30);
    m.advance(30); // the next println after the ISR ran
    expect(lastHit(m)).toBe(1);
  });

  it('FALLING ignores the release edge', () => {
    const m = wired();
    m.load(pressableSketch(`attachInterrupt(D4, onHit, FALLING);`));
    m.run();
    m.advance(30);
    m.press('btn', true);
    m.advance(60);
    m.press('btn', false);
    m.advance(120);
    expect(lastHit(m)).toBe(1);
  });

  it('RISING counts only the release', () => {
    const m = wired();
    m.load(pressableSketch(`attachInterrupt(D4, onHit, RISING);`));
    m.run();
    m.advance(30);
    m.press('btn', true);
    m.advance(60);
    expect(lastHit(m)).toBe(0);
    m.press('btn', false);
    m.advance(120);
    expect(lastHit(m)).toBe(1);
  });

  it('CHANGE counts both edges', () => {
    const m = wired();
    m.load(pressableSketch(`attachInterrupt(D4, onHit, CHANGE);`));
    m.run();
    m.advance(30);
    m.press('btn', true);
    m.advance(60);
    m.press('btn', false);
    m.advance(120);
    expect(lastHit(m)).toBe(2);
  });

  it('detachInterrupt stops the counting', () => {
    const m = wired();
    m.load(`
      int hits = 0;
      void onHit() { hits = hits + 1; }
      void setup() {
        Serial.begin(115200);
        pinMode(D4, INPUT_PULLUP);
        attachInterrupt(D4, onHit, CHANGE);
        detachInterrupt(D4);
      }
      void loop() { Serial.println(hits); delay(20); }
    `);
    m.run();
    m.advance(30);
    m.press('btn', true);
    m.advance(60);
    expect(lastHit(m)).toBe(0);
  });

  it('an unknown ISR name is a compile-time style error at setup', () => {
    const m = wired();
    m.load(pressableSketch(`attachInterrupt(D4, ghost, FALLING);`));
    expect(() => m.run()).toThrow(/ghost/);
  });

  it('reset() reruns setup once: no stale state, no double counting', () => {
    const m = wired();
    m.load(pressableSketch(`attachInterrupt(D4, onHit, FALLING);`));
    m.run();
    m.advance(30);
    m.reset();
    m.run(); // setup() attaches again - exactly like a hardware reset
    m.advance(30);
    m.press('btn', true);
    m.advance(120);
    expect(lastHit(m)).toBe(1); // one attachment, one edge, one hit
  });
});
