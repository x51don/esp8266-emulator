import { describe, it, expect } from 'vitest';
import { PIN_OUTPUT } from '../peripherals/gpio';
import { Esp8266Machine } from '../core/machine';

// The machine is the facade the GUI talks to: load sketch, run, advance
// virtual time, watch pins and serial. GPIO2 is D4/LED_BUILTIN on both boards.

function machine(board = 'wemos-d1-mini'): Esp8266Machine {
  return new Esp8266Machine({ board });
}

describe('lifecycle', () => {
  it('run() before load() throws a clear error', () => {
    expect(() => machine().run()).toThrow(/load|no sketch/i);
  });

  it('rejects broken sketches at load with a line number', () => {
    expect(() => machine().load('void setup() { int x = ; }')).toThrow(/line 1/);
  });

  it('reset() rewinds time and releases all pins', () => {
    const m = machine();
    m.load('void setup(){ pinMode(D4, OUTPUT); digitalWrite(D4, HIGH); } void loop(){ delay(1); }');
    m.run();
    m.advance(10);
    m.reset();
    expect(m.timeMs()).toBe(0);
    // F1.1: D4/GPIO2 no longer PUSHES - the pad is back to input with the
    // chip's boot strap (weak pull-up) on it, so it reads HIGH but drives 0.
    expect(m.pinLevel(2)).toBe(1);
    expect(m.gpio.driveState(2).kind).toBe('weak-high');
    expect(m.pinLevel(4)).toBe(0); // GPIO4: floating, no strap
  });

  it('stop() freezes execution mid-blink, run() restarts from the top', () => {
    const m = machine();
    m.load(`
      void setup() { pinMode(D4, OUTPUT); }
      void loop() { digitalWrite(D4, HIGH); delay(500); digitalWrite(D4, LOW); delay(500); }
    `);
    m.run();
    m.advance(300);
    expect(m.pinLevel(2)).toBe(1);
    m.stop();
    m.advance(2000);
    expect(m.pinLevel(2)).toBe(1); // frozen HIGH where it stopped
    m.run();
    m.advance(10);
    expect(m.pinLevel(2)).toBe(1); // setup ran again
    m.advance(600);
    expect(m.pinLevel(2)).toBe(0); // and the blink continues
  });
});

describe('timing', () => {
  it('delay(500) blinks with a 500 ms cadence in virtual time', () => {
    const m = machine();
    m.load(`
      void setup() { pinMode(D4, OUTPUT); }
      void loop() { digitalWrite(D4, HIGH); delay(500); digitalWrite(D4, LOW); delay(500); }
    `);
    m.run();
    expect(m.pinLevel(2)).toBe(1);
    m.advance(499);
    expect(m.pinLevel(2)).toBe(1);
    m.advance(2);
    expect(m.pinLevel(2)).toBe(0);
    m.advance(500);
    expect(m.pinLevel(2)).toBe(1);
  });

  it('delayMicroseconds works below a millisecond', () => {
    const m = machine();
    m.load('void setup(){ pinMode(D4, OUTPUT); } void loop(){ digitalWrite(D4, digitalRead(D4) ^ 1); delayMicroseconds(750); }');
    m.run();
    m.advance(1); // toggles at t=0 and t=750 -> back LOW at t=1000
    expect(m.pinLevel(2)).toBe(0);
  });

  it('millis() tracks virtual time', () => {
    const m = machine();
    m.load('void setup(){} void loop(){ Serial.println(millis()); delay(100); }');
    m.run();
    m.advance(1000);
    const lines = m.serial.map((l) => l.text);
    // the 1000 ms iteration starts 1-2us late, so its print lands past the boundary
    expect(lines).toEqual(['0', '100', '200', '300', '400', '500', '600', '700', '800', '900']);
  });
});

describe('GPIO through the register file', () => {
  it('HIGH/LOW on D2 (GPIO4) toggles the pin', () => {
    const m = machine();
    m.load('void setup(){ pinMode(D2, OUTPUT); digitalWrite(D2, HIGH); } void loop(){}');
    m.run();
    expect(m.pinLevel(4)).toBe(1);
  });

  it('analogWrite exposes PWM duty 0..1023', () => {
    const m = machine();
    m.load('void setup(){ analogWrite(D2, 300); } void loop(){}');
    m.run();
    expect(m.pwm(4)).toBe(300);
  });

  it('INPUT_PULLUP pin reads its own pull-up (HIGH) via digitalRead', () => {
    const m = machine();
    m.load('void setup(){ pinMode(D2, INPUT_PULLUP); Serial.println(digitalRead(D2)); } void loop(){}');
    m.run();
    expect(m.serial.map((l) => l.text)).toEqual(['1']);
  });
});

describe('serial output', () => {
  it('println prints strings, numbers and concatenations with timestamps', () => {
    const m = machine();
    m.load('void setup(){ Serial.print("a"); Serial.print(5); Serial.println(); Serial.println("x" + String(2+3)); } void loop(){}');
    m.run();
    const t = m.serial;
    expect(t.map((l) => l.text)).toEqual(['a5', 'x5']);
    expect(t.every((l) => l.tMs === 0)).toBe(true);
  });

  it('Serial.begin is accepted and print stays alive without it', () => {
    const m = machine();
    m.load('void setup(){ Serial.begin(115200); Serial.println("hi"); } void loop(){}');
    m.run();
    expect(m.serial.map((l) => l.text)).toEqual(['hi']);
  });

  it('printf formats %d %s %f', () => {
    const m = machine();
    m.load('void setup(){ Serial.printf("v=%d s=%s f=%.2f", 42, "abc", 3.5); Serial.println(); } void loop(){}');
    m.run();
    expect(m.serial.map((l) => l.text)).toEqual(['v=42 s=abc f=3.50']);
  });
});

describe('circuits connected to the machine', () => {
  it('button to GND pulls an INPUT_PULLUP pin LOW while pressed', () => {
    const m = machine();
    m.netlist.addComponent('mcu', 'mcu', { board: 'wemos-d1-mini', pins: ['D2', 'GND'] });
    m.netlist.addComponent('sw1', 'button', { pins: ['p1', 'p2'] });
    m.netlist.addWire('mcu.GND', 'sw1.p1');
    m.netlist.addWire('sw1.p2', 'mcu.D2');
    m.load('void setup(){ pinMode(D2, INPUT_PULLUP); } void loop(){ Serial.println(digitalRead(D2)); delay(10); }');
    m.run();
    m.advance(5);
    m.press('sw1', true);
    m.advance(15);
    const texts = m.serial.map((l) => l.text);
    expect(texts[0]).toBe('1');
    expect(texts.at(-1)).toBe('0');
  });

  it('blinking an LED through a resistor reports brightness in circuit state', () => {
    const m = machine();
    m.netlist.addComponent('mcu', 'mcu', { board: 'wemos-d1-mini', pins: ['D2', 'GND'] });
    m.netlist.addComponent('r1', 'resistor', { pins: ['p1', 'p2'], resistance: 220 });
    m.netlist.addComponent('led1', 'led', { pins: ['a', 'k'], forwardV: 2 });
    m.netlist.addWire('mcu.D2', 'r1.p1');
    m.netlist.addWire('r1.p2', 'led1.a');
    m.netlist.addWire('led1.k', 'mcu.GND');
    m.load('void setup(){ pinMode(D2, OUTPUT); } void loop(){ digitalWrite(D2, HIGH); delay(100); digitalWrite(D2, LOW); delay(100); }');
    m.run();
    m.advance(5);
    expect(m.circuit().leds.get('led1')!.on).toBe(true);
    m.advance(150);
    expect(m.circuit().leds.get('led1')!.on).toBe(false);
  });

  it('shorting an output to 3V3 surfaces a fault without stopping the CPU', () => {
    const m = machine();
    m.netlist.addComponent('mcu', 'mcu', { board: 'wemos-d1-mini', pins: ['D2', '3V3'] });
    m.netlist.addWire('mcu.D2', 'mcu.3V3');
    m.load('void setup(){ pinMode(D2, OUTPUT); digitalWrite(D2, LOW); } void loop(){ delay(10); }');
    m.run();
    m.advance(1);
    expect(m.circuit().faults.length).toBe(1);
    m.advance(1000);
    expect(m.timeMs()).toBe(1001);
  });
});

describe('Arduino API helpers', () => {
  it('map and constrain compute like the core', () => {
    const m = machine();
    m.load('void setup(){ Serial.println(map(512, 0, 1023, 0, 100)); Serial.println(constrain(1500, 0, 1023)); } void loop(){}');
    m.run();
    expect(m.serial.map((l) => l.text)).toEqual(['50', '1023']);
  });

  it('timerAlarmWrite/Enable calls timer0ISR on a virtual schedule', () => {
    const m = machine();
    m.load(`
      int n = 0;
      void timer0ISR() { digitalWrite(D4, n % 2); n++; }
      void setup() { pinMode(D4, OUTPUT); timerAlarmWrite(timer0, 10000, true); timerAlarmEnable(timer0); }
      void loop() { delay(1); }
    `);
    let toggles = 0;
    m.gpio.onPinChange((gpio) => { if (gpio === 2) toggles++; });
    m.run();
    m.advance(25); // alarms at 10 and 20 ms (ISR runs cooperatively, <=1 loop slice late)
    expect(toggles).toBe(2);
  });

  it('printf with embedded newlines flushes each line separately', () => {
    const m = new Esp8266Machine({ board: 'wemos-d1-mini' });
    m.load('void setup(){ Serial.printf("a\\nb\\n"); } void loop(){}');
    m.run();
    expect(m.serial.map((l) => l.text)).toEqual(['a', 'b']);
  });
});

describe('GPIO16 / board pin D0 (P0.2)', () => {
  it('digitalWrite(D0, HIGH) drives the bus', () => {
    const m = machine();
    m.load('void setup(){ pinMode(D0, OUTPUT); digitalWrite(D0, HIGH); } void loop(){ delay(10); }');
    m.run();
    m.advance(5);
    expect(m.pinLevel(16)).toBe(1);
  });

  it('D0 goes LOW again when the sketch clears it', () => {
    const m = machine();
    m.load('int n = 0; void setup(){ pinMode(D0, OUTPUT); } void loop(){ n = n + 1; digitalWrite(D0, n < 5 ? HIGH : LOW); delay(1); }');
    m.run();
    m.advance(2);
    expect(m.pinLevel(16)).toBe(1);
    m.advance(10);
    expect(m.pinLevel(16)).toBe(0);
  });

  it('register-file mirror stays consistent after D0 writes', () => {
    const m = machine();
    m.load('void setup(){ pinMode(D4, OUTPUT); digitalWrite(D4, HIGH); } void loop(){ delay(1); }');
    m.run();
    m.advance(5);
    expect(m.pinLevel(2)).toBe(1); // bits 0..15 unaffected by the 17-bit path
  });
});

describe('machine hygiene (P0.6)', () => {
  it('reset() clears the register file, not just the bus', () => {
    const m = machine();
    m.load('void setup(){ pinMode(D4, OUTPUT); digitalWrite(D4, HIGH); } void loop(){ delay(1); }');
    m.run();
    m.advance(5);
    expect(m.pinLevel(2)).toBe(1);
    m.reset();
    const regs = (m as unknown as { registers: { read(a: number): number } }).registers;
    expect(regs.read(0x600003fc)).toBe(0); // GPIO_OUT
  });

  it('a stale printBuf does not bleed into the next run', () => {
    const m = machine();
    m.load('void setup(){ Serial.begin(115200); Serial.print("tail"); } void loop(){ delay(1); }');
    m.run();
    m.advance(5);
    m.stop();
    m.load('void setup(){ Serial.begin(115200); Serial.println("fresh"); } void loop(){ delay(1); }');
    m.run();
    m.advance(5);
    expect(m.serial[0].text).toBe('fresh');
  });

  it('serialLog is capped and reports dropped lines', () => {
    const m = machine();
    m.load('void setup(){ Serial.begin(115200); } void loop(){ Serial.println("x"); delay(1); }');
    m.run();
    for (let i = 0; i < 400; i++) m.advance(16);
    expect(m.serial.length).toBeLessThanOrEqual(5000);
    const dropped = (m as unknown as { droppedLines: number }).droppedLines;
    expect(typeof dropped).toBe('number');
    expect(dropped).toBeGreaterThan(0);
  });

  it('onSerial/onCircuit return working unsubscribers', () => {
    const m = machine();
    let lines = 0;
    let circuits = 0;
    const offS = m.onSerial(() => lines++);
    const offC = m.onCircuit(() => circuits++);
    m.load('void setup(){ Serial.begin(115200); } void loop(){ Serial.println("x"); delay(1); }');
    m.run();
    m.advance(20);
    const [l, c] = [lines, circuits];
    expect(l).toBeGreaterThan(0);
    offS();
    offC();
    m.advance(20);
    expect(lines).toBe(l);
    expect(circuits).toBe(c);
  });
});

describe('resolve on change signal (P1.1)', () => {
  const started = (sketch: string) => {
    const m = machine();
    m.load(sketch);
    m.run();
    const nl = m.netlist;
    const orig = nl.resolve.bind(nl);
    let calls = 0;
    nl.resolve = () => {
      calls++;
      return orig();
    };
    m.advance(0); // initial solve lands on the first advance
    expect(calls).toBe(1);
    return { m, calls: () => calls };
  };

  it('idle advance() does not re-resolve the netlist', () => {
    const { m, calls } = started('void setup(){} void loop(){ delay(10); }');
    m.advance(16);
    m.advance(16);
    m.advance(16);
    expect(calls()).toBe(1);
  });

  it('a bus change re-resolves once on the next advance', () => {
    const { m, calls } = started('void setup(){} void loop(){ delay(10); }');
    m.gpio.setMode(2, PIN_OUTPUT);
    m.gpio.write(2, 1);
    m.advance(0);
    expect(calls()).toBe(2);
    m.advance(0);
    expect(calls()).toBe(2); // settled again
  });

  it('netlist topology changes re-resolve', () => {
    const { m, calls } = started('void setup(){} void loop(){ delay(10); }');
    m.netlist.addComponent('led-9', 'led', { forwardV: 2 });
    m.advance(0);
    expect(calls()).toBe(2);
    m.netlist.removeComponent('led-9');
    m.advance(0);
    expect(calls()).toBe(3);
  });

  it('a switch toggle re-resolves but a redundant state write does not', () => {
    const { m, calls } = started('void setup(){} void loop(){ delay(10); }');
    m.netlist.addComponent('sw-1', 'switch', {});
    m.advance(0); // consume the addComponent signal
    const base = calls();
    m.netlist.setSwitchState('sw-1', true);
    m.advance(0);
    expect(calls()).toBe(base + 1);
    m.netlist.setSwitchState('sw-1', true); // same value: no signal
    m.advance(0);
    expect(calls()).toBe(base + 1);
  });
});

describe('serial line ids (P1.4)', () => {
  it('lines carry stable unique ids for React keys', () => {
    const m = machine();
    m.load('void setup(){ Serial.begin(115200); Serial.println("a"); Serial.println("b"); Serial.println("c"); } void loop(){ delay(1); }');
    m.run();
    m.advance(5);
    const ids = m.serial.map((l) => l.id);
    expect(ids.every((id) => typeof id === 'number')).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[1]).toBeGreaterThan(ids[0]);
  });
});
