import { describe, it, expect } from 'vitest';
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
    expect(m.pinLevel(2)).toBe(0);
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
});
