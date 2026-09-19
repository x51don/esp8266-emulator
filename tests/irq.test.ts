/**
 * F2.1 external interrupts: the ISR preempts the main program at any
 * interpreter yield (not only inside delay()), arrives ~2 us after the edge,
 * and noInterrupts()/interrupts() really gate the entry point.
 */
import { describe, it, expect } from 'vitest';
import { Esp8266Machine } from '../core/machine';

function withButton(sketch: string, bounce = 0): Esp8266Machine {
  const m = new Esp8266Machine({ board: 'wemos-d1-mini' });
  m.netlist.addComponent('mcu', 'mcu', { board: 'wemos-d1-mini', pins: ['D2', 'GND'] });
  m.netlist.addComponent('btn1', 'button', { bounce });
  m.netlist.addWire('mcu.D2', 'btn1.p1');
  m.netlist.addWire('btn1.p2', 'mcu.GND');
  m.load(sketch);
  m.run();
  return m;
}

const ISR_DEF = 'volatile int hits = 0; void isr(){ hits++; Serial.println("i"); }';
const ATTACH = 'pinMode(D2, INPUT_PULLUP); attachInterrupt(digitalPinToInterrupt(D2), isr, FALLING);';
const text = (m: Esp8266Machine): string => m.serial.map((l) => l.text).join('\n');

describe('asynchronous preemption (F2.1)', () => {
  it('an ISR fires while loop() hogs the CPU with no delay() at all', () => {
    const m = withButton(`${ISR_DEF} void setup(){ ${ATTACH} } void loop(){ }`);
    m.advance(1); // let setup finish the attach
    expect(text(m)).toBe('');
    m.press('btn1', true);
    m.advance(5);
    expect(text(m)).toContain('i'); // impossible in the old cooperative model
  });

  it('ISR entry is delayed ~2 us after the edge, not instant', () => {
    const m = withButton(`${ISR_DEF} void setup(){ ${ATTACH} } void loop(){ delay(1000); }`);
    m.advance(1);
    m.press('btn1', true);
    m.advance(0.001); // 1 us after the edge: still too early for the ISR
    expect(text(m)).toBe('');
    m.advance(0.002); // latency window elapsed
    expect(text(m)).toContain('i');
  });

  it('preemption works inside a tight for(;;) that never yields to delay', () => {
    const m = withButton(`${ISR_DEF} int x = 0; void setup(){ ${ATTACH} } void loop(){ for(;;){ x++; } }`);
    m.advance(1);
    m.press('btn1', true);
    m.advance(5);
    expect(text(m)).toContain('i'); // the ISR cut into the endless loop
  });
});

describe('noInterrupts / interrupts (F2.1)', () => {
  it('edges while masked stay pending and run at interrupts()', () => {
    const m = withButton(
      ISR_DEF +
      ` void setup(){ ${ATTACH} noInterrupts(); }` +
      ' void loop(){ if(millis() > 50) interrupts(); delay(1); }',
    );
    m.advance(10);
    m.press('btn1', true);
    m.advance(20); // 30 ms in: still masked
    expect(text(m)).toBe('');
    m.advance(30); // past the 50 ms unmask
    expect(text(m)).toContain('i');
  });

  it('masked burst on one pin collapses to one ISR - the pending bit, not a FIFO', () => {
    const m = withButton(
      ISR_DEF +
      ` void setup(){ ${ATTACH} noInterrupts(); }` +
      ' void loop(){ if(millis() > 40) interrupts(); delay(1); }',
      4, // 4 ms chatter: several edges while masked
    );
    m.advance(10);
    m.press('btn1', true);
    m.advance(80); // bounce done, unmasked at 40 ms, everything settles
    const hits = (text(m).match(/i/g) ?? []).length;
    expect(hits).toBe(1);
  });

  it('detachInterrupt stops the edge source entirely', () => {
    const m = withButton(
      `${ISR_DEF} void setup(){ ${ATTACH} }` +
      ' void loop(){ if(millis() > 10) detachInterrupt(digitalPinToInterrupt(D2)); delay(1); }',
    );
    m.advance(20); // detached by now
    m.press('btn1', true);
    m.advance(20);
    expect(text(m)).toBe('');
  });
});
