/**
 * ESPHome-style part of the component library at machine level:
 * DHT temp/hum, HC-SR04 distance, servo angles, relay contacts.
 */
import { describe, it, expect } from 'vitest';
import { Esp8266Machine } from '../core/machine';
import { Netlist } from '../peripherals/netlist';
import { GpioBus, PIN_OUTPUT } from '../peripherals/gpio';

function machine(): Esp8266Machine {
  const m = new Esp8266Machine({ board: 'wemos-d1-mini' });
  m.netlist.addComponent('mcu', 'mcu', { board: 'wemos-d1-mini' });
  return m;
}

function serialNumbers(m: Esp8266Machine): number[] {
  return m.serial.map((l) => Number(l.text)).filter((n) => !Number.isNaN(n));
}

describe('DHT sensor', () => {
  it('setup finds a dht wired data-to-pin; reads report its params', () => {
    const m = machine();
    m.netlist.addComponent('dht1', 'dht', { model: 'DHT22', tempC: 23.5, humPct: 61 });
    m.netlist.addWire('mcu.D4', 'dht1.data');
    m.netlist.addWire('mcu.3V3', 'dht1.vcc');
    m.netlist.addWire('dht1.gnd', 'mcu.GND');
    m.load(`
      void setup() { Serial.begin(115200);
        Serial.println(dhtSetup(D4));
        Serial.println(dhtReadTemperature(D4));
        Serial.println(dhtReadHumidity(D4)); }
      void loop() { delay(10); }
    `);
    m.run();
    m.advance(5);
    expect(serialNumbers(m)).toEqual([1, 23.5, 61]);
  });

  it('missing sensor reads -999 and setup returns 0', () => {
    const m = machine();
    m.load(`
      void setup() { Serial.begin(115200);
        Serial.println(dhtSetup(D4));
        Serial.println(dhtReadTemperature(D4)); }
      void loop() { delay(10); }
    `);
    m.run();
    m.advance(5);
    expect(serialNumbers(m)).toEqual([0, -999]);
  });

  it('values follow live param changes', () => {
    const m = machine();
    m.netlist.addComponent('dht1', 'dht', { tempC: 10, humPct: 40 });
    m.netlist.addWire('mcu.D2', 'dht1.data');
    m.load(`
      void setup() { Serial.begin(115200); dhtSetup(D2); }
      void loop() { Serial.println(dhtReadTemperature(D2)); delay(20); }
    `);
    m.run();
    m.advance(10);
    expect(serialNumbers(m)[0]).toBe(10);
    m.netlist.addComponent('dht1', 'dht', { tempC: 31, humPct: 40 });
    m.advance(30);
    expect(serialNumbers(m).at(-1)).toBe(31);
  });
});

describe('HC-SR04', () => {
  it('distance and echo pulse time follow the cm param', () => {
    const m = machine();
    m.netlist.addComponent('us1', 'hcsr', { cm: 42 });
    m.netlist.addWire('mcu.D5', 'us1.trig');
    m.netlist.addWire('mcu.D6', 'us1.echo');
    m.load(`
      void setup() { Serial.begin(115200);
        Serial.println(hcsrSetup(D5, D6));
        Serial.println(hcsrDistanceCm(D6));
        Serial.println(hcsrPulseUs(D6)); }
      void loop() { delay(10); }
    `);
    m.run();
    m.advance(5);
    expect(serialNumbers(m)).toEqual([1, 42, 2436]);
  });
});

describe('servo', () => {
  it('attach + write moves the arm and servoRead reports the angle', () => {
    const m = machine();
    m.netlist.addComponent('srv1', 'servo', {});
    m.netlist.addWire('mcu.D3', 'srv1.sig');
    m.load(`
      void setup() { Serial.begin(115200);
        servoAttach(D3);
        servoWrite(D3, 120);
        Serial.println(servoRead(D3)); }
      void loop() { delay(10); }
    `);
    m.run();
    m.advance(5);
    expect(serialNumbers(m)).toEqual([120]);
    expect(m.servoAngles().get(0)).toBe(120); // D3 = GPIO0
  });

  it('writes clamp to 0..180', () => {
    const m = machine();
    m.netlist.addWire('mcu.D3', 'srvX.sig');
    m.netlist.addComponent('srvX', 'servo', {});
    m.load(`void setup(){ servoAttach(D3); servoWrite(D3, 275); }
            void loop(){ delay(10); }`);
    m.run();
    m.advance(5);
    expect(m.servoAngles().get(0)).toBe(180);
  });
});

describe('relay (electrical)', () => {
  function relayNetlist(): { nl: Netlist; bus: GpioBus } {
    const bus = new GpioBus();
    const nl = new Netlist(bus);
    nl.addComponent('mcu', 'mcu', { board: 'wemos-d1-mini' });
    nl.addComponent('rl1', 'relay', {});
    nl.addComponent('lamp', 'led', {});
    nl.addComponent('r1', 'resistor', { resistance: 220 });
    // coil driven from D2
    nl.addWire('mcu.D2', 'rl1.coilp');
    nl.addWire('rl1.coiln', 'mcu.GND');
    // switched mains-like load: 3V3 -> sw, no -> led -> r -> GND, nc unconnected
    nl.addWire('mcu.3V3', 'rl1.sw');
    nl.addWire('rl1.no', 'lamp.a');
    nl.addWire('lamp.k', 'r1.p1');
    nl.addWire('r1.p2', 'mcu.GND');
    return { nl, bus };
  }

  it('NO contact closes when the coil is driven', () => {
    const { nl, bus } = relayNetlist();
    bus.setMode(4, PIN_OUTPUT);
    bus.write(4, 1);
    const r = nl.resolve();
    expect(r.leds.get('lamp')?.on).toBe(true);
  });

  it('NO contact is open (and NC closed) without coil power', () => {
    const { nl } = relayNetlist();
    const r = nl.resolve();
    expect(r.leds.get('lamp')?.on).toBe(false);
  });
});
