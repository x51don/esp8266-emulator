import { describe, expect, it } from 'vitest';
import { buildFromPlan, planFromSketch, type PlannedPart } from '../gui/autowire';

const at = (p: PlannedPart): string =>
  p.kind === 'hcsr' ? p.trig : p.kind === 'oled' ? p.sda : p.pin;
import { Netlist } from '../peripherals/netlist';
import { GpioBus } from '../peripherals/gpio';

describe('planFromSketch', () => {
  it('a blink sketch asks for one LED chain on D4', () => {
    const plan = planFromSketch(`
      void setup() { pinMode(D4, OUTPUT); }
      void loop() { digitalWrite(D4, HIGH); delay(500); digitalWrite(D4, LOW); delay(500); }
    `);
    expect(plan).toEqual([{ kind: 'led', pin: 'D4' }]);
  });

  it('reads make buttons, writes make LEDs, mixed pins split', () => {
    const plan = planFromSketch(`
      void loop() {
        if (digitalRead(D3) == LOW) digitalWrite(D4, HIGH); else digitalWrite(D4, LOW);
        analogWrite(D1, 128);
      }
    `);
    const kinds = plan.map((p) => `${p.kind}@${at(p)}`).sort();
    expect(kinds).toEqual(['button@D3', 'led@D1', 'led@D4']);
  });

  it('a pin both read and written wins as output', () => {
    const plan = planFromSketch(`void loop(){ digitalRead(D2); digitalWrite(D2, 1); }`);
    expect(plan).toEqual([{ kind: 'led', pin: 'D2' }]);
  });

  it('resolves #define and const int aliases, also through chained defines', () => {
    const plan = planFromSketch(`
      #define LED_PIN BOARD_LED
      #define BOARD_LED D4
      const int KEY = D3;
      void loop() { digitalWrite(LED_PIN, HIGH); digitalRead(KEY); }
    `);
    const kinds = plan.map((p) => `${p.kind}@${at(p)}`).sort();
    expect(kinds).toEqual(['button@D3', 'led@D4']);
  });

  it('bare GPIO numbers map back to the silkscreen names', () => {
    const plan = planFromSketch(`void loop(){ digitalWrite(2, HIGH); digitalRead(0); }`);
    const kinds = plan.map((p) => `${p.kind}@${at(p)}`).sort();
    expect(kinds).toEqual(['button@D3', 'led@D4']);
  });

  it('analogRead puts a pot on A0, never an LED on A0', () => {
    const plan = planFromSketch(`void loop(){ analogRead(A0); digitalWrite(A0, 1); }`);
    expect(plan).toEqual([{ kind: 'pot', pin: 'A0' }]);
  });

  it('peripheral APIs plan their modules', () => {
    const plan = planFromSketch(`
      void setup() {
        oledBegin();
        hcsrSetup(D5, D6);
        servoAttach(D3);
        npSetup(D7, 8);
      }
      void loop() {
        float t = dhtReadTemperature(D4);
        servoWrite(D3, 90);
      }
    `);
    const kinds = plan.map((p) => `${p.kind}@${at(p)}`).sort();
    expect(kinds).toEqual(['dht@D4', 'hcsr@D5', 'neopixel@D7', 'oled@D1', 'servo@D3']);
  });

  it('Adafruit_NeoPixel constructor form plans the strip too', () => {
    const plan = planFromSketch(`
      #define STRIP_PIN D7
      Adafruit_NeoPixel strip = Adafruit_NeoPixel(12, STRIP_PIN, NEO_GRB + NEO_KHZ800);
      void loop() { strip.setPixelColor(0, 255, 0, 0); }
    `);
    expect(plan.some((p) => p.kind === 'neopixel' && at(p) === 'D7')).toBe(true);
  });

  it('module APIs own their pin: no extra LED or button on it', () => {
    const plan = planFromSketch(`
      void setup() { servoAttach(D3); }
      void loop() { if (digitalRead(D3)) digitalWrite(D3, HIGH); npSetup(D7, 8); digitalRead(D7); }
    `);
    const kinds = plan.map((p) => `${p.kind}@${at(p)}`).sort();
    expect(kinds).toEqual(['neopixel@D7', 'servo@D3']);
  });

  it('comments never wire anything', () => {
    const plan = planFromSketch(`
      // digitalWrite(D4, HIGH);
      /* digitalRead(D3); */
      void loop() { Serial.println("hi"); }
    `);
    expect(plan).toEqual([]);
  });

  it('unknown or out-of-board pins are dropped silently', () => {
    const plan = planFromSketch(`void loop(){ digitalWrite(D99, HIGH); digitalWrite(NOT_A_PIN, 1); }`);
    expect(plan).toEqual([]);
  });
});

describe('buildFromPlan', () => {
  it('wires every planned part and resolves fault-free', () => {
    const plan = planFromSketch(`
      void setup() { oledBegin(); servoAttach(D3); npSetup(D7, 8); }
      void loop() {
        if (digitalRead(D0)) digitalWrite(D4, HIGH);
        analogRead(A0);
        dhtReadTemperature(12); // GPIO12 = D6
      }
    `);
    const sc = buildFromPlan(plan, 'wemos-d1-mini');
    const types = [...sc.components.values()].map((c) => c.type);
    expect(types.filter((t) => t === 'board')).toEqual(['board']);
    for (const want of ['led', 'button', 'pot', 'dht', 'servo', 'neopixel', 'oled']) {
      expect(types, want).toContain(want);
    }
    const nl = new Netlist(new GpioBus());
    sc.syncNetlist(nl);
    expect(nl.resolve().faults).toEqual([]);
  });

  it('an empty plan yields a bare board', () => {
    const sc = buildFromPlan([], 'wemos-d1-mini');
    const comps = [...sc.components.values()];
    expect(comps).toHaveLength(1);
    expect(comps[0]!.type).toBe('board');
  });
});
