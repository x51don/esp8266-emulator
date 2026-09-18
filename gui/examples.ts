/**
 * Example registry: every example carries its sketch AND a ready-wired
 * circuit preset, so loading one gives a runnable schematic, not a bare
 * board. Presets place parts on the pin's outer side and chain
 * pin -> resistor -> LED -> GND (or pin -> button -> GND).
 */

import { Schematic, type PlacedComponent } from './canvas/schematic';
import type { Pt } from './canvas/viewport';

import blink from '../examples/blink.ino?raw';
import pwmFade from '../examples/pwm-fade.ino?raw';
import button from '../examples/button.ino?raw';
import serialHello from '../examples/serial-hello.ino?raw';

export const EXAMPLE_SKETCHES: Record<string, string> = {
  'blink.ino': blink,
  'pwm-fade.ino': pwmFade,
  'button.ino': button,
  'serial-hello.ino': serialHello,
};

export const EXAMPLE_NAMES = Object.keys(EXAMPLE_SKETCHES);

function pinWorld(sc: Schematic, pin: string): Pt & { dir: number } {
  const board = sc.boardComponent();
  if (!board) throw new Error('preset needs a board');
  const p = sc.pinWorld({ comp: board.id, pin });
  // board footprint: left column sits at local x=0, right column at 160
  const dir = p.x - board.x <= 80 ? -1 : 1;
  return { ...p, dir };
}

/** pin -> resistor -> LED -> GND, parts laid out outside the board edge. */
function addLedChain(sc: Schematic, pin: string): void {
  const board = sc.boardComponent()!;
  const p = pinWorld(sc, pin);
  const r = sc.add('resistor', p.x + p.dir * 160, p.y, { resistance: 220 });
  const led = sc.add('led', p.x + p.dir * 280, p.y, { forwardV: 2 });
  wire(sc, { comp: board.id, pin }, { comp: r.id, pin: 'p1' });
  wire(sc, { comp: r.id, pin: 'p2' }, { comp: led.id, pin: 'a' });
  wire(sc, { comp: led.id, pin: 'k' }, { comp: board.id, pin: 'GND' });
}

function addButton(sc: Schematic, pin: string): void {
  const board = sc.boardComponent()!;
  const p = pinWorld(sc, pin);
  const b = sc.add('button', p.x + p.dir * 160, p.y, {});
  wire(sc, { comp: board.id, pin }, { comp: b.id, pin: 'p1' });
  wire(sc, { comp: b.id, pin: 'p2' }, { comp: board.id, pin: 'GND' });
}

function wire(sc: Schematic, a: { comp: string; pin: string }, b: { comp: string; pin: string }): void {
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
    default:
      throw new Error(`unknown example '${name}'`);
  }
  return sc;
}
