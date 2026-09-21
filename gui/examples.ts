/**
 * Example registry: every example carries its sketch AND a ready-wired
 * circuit preset, so loading one gives a runnable schematic, not a bare
 * board. Presets place parts on the pin's outer side and chain
 * pin -> resistor -> LED -> GND (or pin -> button -> GND).
 */

import { BOARD_RIGHT_X, Schematic, type PlacedComponent } from './canvas/schematic';
import type { Pt } from './canvas/viewport';

import blink from '../examples/blink.ino?raw';
import pwmFade from '../examples/pwm-fade.ino?raw';
import button from '../examples/button.ino?raw';
import serialHello from '../examples/serial-hello.ino?raw';
import potSerial from '../examples/pot-serial.ino?raw';
import ldrLed from '../examples/ldr-led.ino?raw';
import dhtOled from '../examples/dht-oled.ino?raw';
import servoPot from '../examples/servo-pot.ino?raw';
import npChase from '../examples/neopixel-chase.ino?raw';
import hcsrSerial from '../examples/hcsr-serial.ino?raw';
import relayPump from '../examples/relay-pump.ino?raw';
import transistorSwitch from '../examples/transistor-switch.ino?raw';
import webServer from '../examples/web-server.ino?raw';
import lanServer from '../examples/lan-server.ino?raw';
import lanClient from '../examples/lan-client.ino?raw';

export const EXAMPLE_SKETCHES: Record<string, string> = {
  'blink.ino': blink,
  'pwm-fade.ino': pwmFade,
  'button.ino': button,
  'serial-hello.ino': serialHello,
  'pot-serial.ino': potSerial,
  'ldr-led.ino': ldrLed,
  'dht-oled.ino': dhtOled,
  'servo-pot.ino': servoPot,
  'neopixel-chase.ino': npChase,
  'hcsr-serial.ino': hcsrSerial,
  'relay-pump.ino': relayPump,
  'transistor-switch.ino': transistorSwitch,
  'web-server.ino': webServer,
  'lan-server.ino': lanServer,
  'lan-client.ino': lanClient,
};

export const EXAMPLE_NAMES = Object.keys(EXAMPLE_SKETCHES);

export function pinWorld(sc: Schematic, pin: string): Pt & { dir: number } {
  const board = sc.boardComponent();
  if (!board) throw new Error('preset needs a board');
  const p = sc.pinWorld({ comp: board.id, pin });
  // board footprint: left column sits at local x=0, right at BOARD_RIGHT_X
  const dir = p.x - board.x <= BOARD_RIGHT_X / 2 ? -1 : 1;
  return { ...p, dir };
}

/** pin -> resistor -> LED -> GND, parts laid out outside the board edge. */
export function addLedChain(sc: Schematic, pin: string, label?: string): void {
  const board = sc.boardComponent()!;
  const p = pinWorld(sc, pin);
  const r = sc.add('resistor', p.x + p.dir * 160, p.y, { resistance: 220 });
  const led = sc.add('led', p.x + p.dir * 280, p.y, { forwardV: 2 });
  if (label) led.label = label; // the caption names the LED, not its resistor
  wire(sc, { comp: board.id, pin }, { comp: r.id, pin: 'p1' });
  wire(sc, { comp: r.id, pin: 'p2' }, { comp: led.id, pin: 'a' });
  wire(sc, { comp: led.id, pin: 'k' }, { comp: board.id, pin: 'GND' });
}

export function addButton(sc: Schematic, pin: string, label?: string): void {
  const board = sc.boardComponent()!;
  const p = pinWorld(sc, pin);
  const b = sc.add('button', p.x + p.dir * 160, p.y, { bounce: 1 });
  if (label) b.label = label;
  wire(sc, { comp: board.id, pin }, { comp: b.id, pin: 'p1' });
  wire(sc, { comp: b.id, pin: 'p2' }, { comp: board.id, pin: 'GND' });
}

/** Module whose left-column pins sit at local y = 0, 20, 40 (vcc/data/gnd...). */
export function sideModule(
  sc: Schematic, type: string, pin: string, dist: number,
  params: Record<string, unknown> = {},
  label?: string,
): { comp: PlacedComponent; at: (localY: number) => Pt } {
  const p = pinWorld(sc, pin);
  const comp = sc.add(type, p.x + p.dir * dist, p.y - 20, params);
  if (label) comp.label = label;
  return { comp, at: (localY: number) => ({ x: comp.x, y: comp.y + localY }) };
}

export function addPot(sc: Schematic, pin: string, dist = 200, label?: string): void {
  const board = sc.boardComponent()!;
  const p = pinWorld(sc, pin);
  const pot = sc.add('pot', p.x + p.dir * dist, p.y + 40, { ratio: 0.5 });
  if (label) pot.label = label;
  wire(sc, { comp: pot.id, pin: 'w' }, { comp: board.id, pin });
  wire(sc, { comp: pot.id, pin: 'p1' }, { comp: board.id, pin: '3V3' });
  wire(sc, { comp: pot.id, pin: 'p2' }, { comp: board.id, pin: 'GND' });
}

export function addDht(sc: Schematic, pin: string, label?: string): void {
  const board = sc.boardComponent()!;
  const m = sideModule(sc, 'dht', pin, 200, { model: 'DHT22', tempC: 23.5, humPct: 61 }, label);
  wire(sc, { comp: m.comp.id, pin: 'data' }, { comp: board.id, pin });
  wire(sc, { comp: m.comp.id, pin: 'vcc' }, { comp: board.id, pin: '3V3' });
  wire(sc, { comp: m.comp.id, pin: 'gnd' }, { comp: board.id, pin: 'GND' });
}

export function addOled(sc: Schematic, sda: string, scl: string): void {
  const board = sc.boardComponent()!;
  const p = pinWorld(sc, '3V3');
  const oled = sc.add('oled', p.x + 240, p.y, { addr: 0x3c });
  wire(sc, { comp: oled.id, pin: 'vcc' }, { comp: board.id, pin: '3V3' });
  wire(sc, { comp: oled.id, pin: 'gnd' }, { comp: board.id, pin: 'GND' });
  wire(sc, { comp: oled.id, pin: 'sda' }, { comp: board.id, pin: sda });
  wire(sc, { comp: oled.id, pin: 'scl' }, { comp: board.id, pin: scl });
}

export function wire(sc: Schematic, a: { comp: string; pin: string }, b: { comp: string; pin: string }): void {
  const comp = (id: string): PlacedComponent => {
    const c = sc.component(id);
    if (!c) throw new Error(`preset: missing component '${id}'`);
    return c;
  };
  comp(a.comp);
  comp(b.comp);
  sc.wire(a, b);
}

/** Build the fresh schematic preset for an example on the given board. */
export function loadExample(name: string, boardId: string): Schematic {
  const sc = new Schematic();
  sc.addBoard(boardId, 160, 60);
  switch (name) {
    case 'blink.ino':
      addLedChain(sc, 'D4');
      break;
    case 'pwm-fade.ino':
      addLedChain(sc, 'D1');
      break;
    case 'button.ino':
      addButton(sc, 'D3');
      addLedChain(sc, 'D4');
      break;
    case 'serial-hello.ino':
      break;
    case 'web-server.ino':
      addLedChain(sc, 'D4'); // the /led endpoint flips it
      break;
    case 'lan-server.ino':
      addLedChain(sc, 'D4');
      break;
    case 'lan-client.ino':
      break;
    case 'pot-serial.ino':
      addPot(sc, 'A0');
      break;
    case 'ldr-led.ino': {
      const board = sc.boardComponent()!;
      const p = pinWorld(sc, 'A0');
      const ldr = sc.add('ldr', p.x - 200, p.y, { lux: 300 });
      const r = sc.add('resistor', p.x - 200, p.y - 60, { resistance: 10_000 });
      wire(sc, { comp: board.id, pin: '3V3' }, { comp: r.id, pin: 'p1' });
      wire(sc, { comp: r.id, pin: 'p2' }, { comp: ldr.id, pin: 'p1' });
      wire(sc, { comp: ldr.id, pin: 'p1' }, { comp: board.id, pin: 'A0' });
      wire(sc, { comp: ldr.id, pin: 'p2' }, { comp: board.id, pin: 'GND' });
      addLedChain(sc, 'D4');
      break;
    }
    case 'dht-oled.ino':
      addDht(sc, 'D4');
      addOled(sc, 'D1', 'D2');
      break;
    case 'servo-pot.ino': {
      const board = sc.boardComponent()!;
      addPot(sc, 'A0');
      const m = sideModule(sc, 'servo', 'D3', 220, {});
      wire(sc, { comp: m.comp.id, pin: 'sig' }, { comp: board.id, pin: 'D3' });
      wire(sc, { comp: m.comp.id, pin: 'vcc' }, { comp: board.id, pin: '3V3' });
      wire(sc, { comp: m.comp.id, pin: 'gnd' }, { comp: board.id, pin: 'GND' });
      break;
    }
    case 'neopixel-chase.ino': {
      const board = sc.boardComponent()!;
      const m = sideModule(sc, 'neopixel', 'D7', 220, { count: 8 });
      wire(sc, { comp: m.comp.id, pin: 'din' }, { comp: board.id, pin: 'D7' });
      wire(sc, { comp: m.comp.id, pin: 'vcc' }, { comp: board.id, pin: '3V3' });
      wire(sc, { comp: m.comp.id, pin: 'gnd' }, { comp: board.id, pin: 'GND' });
      break;
    }
    case 'hcsr-serial.ino': {
      const board = sc.boardComponent()!;
      const p = pinWorld(sc, 'D6'); // echo; trig sits one row up = D5
      const h = sc.add('hcsr', p.x + 240, p.y - 40, { cm: 20 });
      wire(sc, { comp: h.id, pin: 'echo' }, { comp: board.id, pin: 'D6' });
      wire(sc, { comp: h.id, pin: 'trig' }, { comp: board.id, pin: 'D5' });
      wire(sc, { comp: h.id, pin: 'vcc' }, { comp: board.id, pin: '3V3' });
      wire(sc, { comp: h.id, pin: 'gnd' }, { comp: board.id, pin: 'GND' });
      addLedChain(sc, 'D4');
      break;
    }
    case 'relay-pump.ino': {
      const board = sc.boardComponent()!;
      const p = pinWorld(sc, 'D5');
      const rl = sc.add('relay', p.x + 220, p.y, {});
      wire(sc, { comp: rl.id, pin: 'coilp' }, { comp: board.id, pin: 'D5' });
      wire(sc, { comp: rl.id, pin: 'coiln' }, { comp: board.id, pin: 'GND' });
      wire(sc, { comp: rl.id, pin: 'sw' }, { comp: board.id, pin: '3V3' });
      // flyback diode across the coil: anode on coil-, cathode on coil+
      const fd = sc.add('diode', rl.x + 20, rl.y + 90, {});
      wire(sc, { comp: fd.id, pin: 'a' }, { comp: rl.id, pin: 'coiln' });
      wire(sc, { comp: fd.id, pin: 'k' }, { comp: rl.id, pin: 'coilp' });
      // lamp on the switched side: no -> led -> resistor -> GND
      const led = sc.add('led', rl.x + 240, rl.y + 20, { forwardV: 2 });
      const rl_r = sc.add('resistor', rl.x + 360, rl.y + 20, { resistance: 220 });
      wire(sc, { comp: rl.id, pin: 'no' }, { comp: led.id, pin: 'a' });
      wire(sc, { comp: led.id, pin: 'k' }, { comp: rl_r.id, pin: 'p1' });
      wire(sc, { comp: rl_r.id, pin: 'p2' }, { comp: board.id, pin: 'GND' });
      break;
    }
    case 'transistor-switch.ino': {
      const board = sc.boardComponent()!;
      const p = pinWorld(sc, 'D2');
      // NPN low-side switch: D2 - 1k - base; 5V - 220R - LED - collector
      const rb = sc.add('resistor', p.x + 140, p.y, { resistance: 1000 });
      const q = sc.add('transistor', p.x + 260, p.y, { polarity: 'npn' });
      const rc = sc.add('resistor', p.x + 260, p.y - 140, { resistance: 220 });
      const led = sc.add('led', p.x + 400, p.y - 140, { forwardV: 2 });
      wire(sc, { comp: board.id, pin: 'D2' }, { comp: rb.id, pin: 'p1' });
      wire(sc, { comp: rb.id, pin: 'p2' }, { comp: q.id, pin: 'b' });
      wire(sc, { comp: q.id, pin: 'e' }, { comp: board.id, pin: 'GND' });
      wire(sc, { comp: board.id, pin: '5V' }, { comp: rc.id, pin: 'p1' });
      wire(sc, { comp: rc.id, pin: 'p2' }, { comp: led.id, pin: 'a' });
      wire(sc, { comp: led.id, pin: 'k' }, { comp: q.id, pin: 'c' });
      // 3.3V Zener clamping the 5V rail branch (reverse-biased, glows)
      const pz = pinWorld(sc, '3V3');
      const rz = sc.add('resistor', pz.x + 140, pz.y + 220, { resistance: 470 });
      const z = sc.add('zener', pz.x + 300, pz.y + 220, { vz: 3.3 });
      wire(sc, { comp: board.id, pin: '5V' }, { comp: rz.id, pin: 'p1' });
      wire(sc, { comp: rz.id, pin: 'p2' }, { comp: z.id, pin: 'k' });
      wire(sc, { comp: z.id, pin: 'a' }, { comp: board.id, pin: 'GND' });
      break;
    }
    default:
      throw new Error(`unknown example '${name}'`);
  }
  return sc;
}
