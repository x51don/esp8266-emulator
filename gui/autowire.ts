/**
 * Generate a schematic from a sketch: scan the code for the APIs that imply
 * hardware (digitalWrite -> an LED, digitalRead -> a button, dhtRead* -> a
 * DHT, ...) and lay out the matching wired parts around a fresh board.
 *
 * The parser is deliberately regex-level, not the interpreter's AST: it only
 * has to survive real sketches (comments, #defines, const aliases, bare GPIO
 * numbers). Anything it cannot resolve is dropped - a generated board with
 * two of the ten implied parts still beats an empty canvas.
 */

import { D_PIN_TO_GPIO } from '../core/boards';
import { Schematic } from './canvas/schematic';
import {
  addDht, addLedChain, addOled, addPot, addButton, sideModule, wire, pinWorld,
} from './examples';

export type PlannedPart =
  | { kind: 'led' | 'button' | 'pot' | 'dht' | 'servo' | 'neopixel'; pin: string }
  | { kind: 'hcsr'; trig: string; echo: string }
  | { kind: 'oled'; sda: string; scl: string };

const GPIO_TO_SILK: Record<number, string> = {};
for (const [name, gpio] of Object.entries(D_PIN_TO_GPIO)) GPIO_TO_SILK[gpio] = name;

/** Line and block comments carry no circuit. */
function stripComments(src: string): string {
  return src.replace(/\/\/[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/** `#define LED D4`, `const int KEY = D3;`, `int led = 2;` - aliases sketches live by. */
function collectAliases(src: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of src.matchAll(/#\s*define\s+([A-Za-z_]\w*)\s+([A-Za-z0-9_]+)/g)) out.set(m[1]!, m[2]!);
  for (const m of src.matchAll(/\b(?:int|long|short|byte|word|unsigned|const)\s*(?:int\s+|long\s+)?([A-Za-z_]\w*)\s*=\s*([A-Za-z0-9_]+)\s*;/g)) {
    if (!out.has(m[1]!)) out.set(m[1]!, m[2]!);
  }
  return out;
}

/** Resolve a call's pin argument to a silkscreen name (D0..D8/A0) or null. */
function resolvePin(token: string | undefined, aliases: Map<string, string>): string | null {
  let tok = token;
  for (let depth = 0; depth < 4; depth++) {
    if (!tok) return null;
    if (/^D[0-8]$/.test(tok)) return tok;
    if (tok === 'A0') return 'A0';
    if (/^\d+$/.test(tok)) return GPIO_TO_SILK[Number(tok)] ?? null;
    tok = aliases.get(tok);
  }
  return null;
}

function pinsOf(src: string, fn: string): string[] {
  const out: string[] = [];
  const re = new RegExp(String.raw`\b${fn}\s*\(\s*([^,()]*)\s*(?:,|\))`, 'g');
  for (const m of src.matchAll(re)) out.push(m[1]!.trim());
  return out;
}

export function planFromSketch(text: string): PlannedPart[] {
  const src = stripComments(text ?? '');
  const aliases = collectAliases(src);
  const pin = (t?: string) => resolvePin(t, aliases);

  const plan: PlannedPart[] = [];
  const claimed = new Set<string>();

  // module APIs first: their pins are then spoken for
  for (const t of pinsOf(src, 'dhtRead(?:Temperature|Humidity)')) {
    const p = pin(t);
    if (p && !claimed.has(p)) { plan.push({ kind: 'dht', pin: p }); claimed.add(p); }
  }
  for (const fn of ['servoAttach', 'servoWrite', 'servoRead']) {
    for (const t of pinsOf(src, fn)) {
      const p = pin(t);
      if (p && !claimed.has(p)) { plan.push({ kind: 'servo', pin: p }); claimed.add(p); }
    }
  }
  const npPins = [
    ...pinsOf(src, 'npSetup'),
    ...[...src.matchAll(/Adafruit_NeoPixel\s*\([^,)]+,\s*([A-Za-z0-9_]+)/g)].map((m) => m[1]!),
  ];
  for (const t of npPins) {
    const p = pin(t);
    if (p && !claimed.has(p)) { plan.push({ kind: 'neopixel', pin: p }); claimed.add(p); }
  }
  for (const m of src.matchAll(/hcsrSetup\s*\(\s*([A-Za-z0-9_]+)\s*,\s*([A-Za-z0-9_]+)/g)) {
    const trig = pin(m[1]);
    const echo = pin(m[2]);
    if (trig && echo && !claimed.has(trig) && !claimed.has(echo)) {
      plan.push({ kind: 'hcsr', trig, echo });
      claimed.add(trig);
      claimed.add(echo);
    }
  }
  if (/\boled(?:Begin|Clear|Print|Show)\b/.test(src)) {
    plan.push({ kind: 'oled', sda: 'D1', scl: 'D2' }); // the emulated I2C bus
    claimed.add('D1');
    claimed.add('D2');
  }

  // single-pin parts: writes are outputs, reads are buttons
  const outputs = new Set<string>();
  const inputs = new Set<string>();
  for (const fn of ['digitalWrite', 'analogWrite', 'tone']) {
    for (const t of pinsOf(src, fn)) {
      const p = pin(t);
      if (p && p !== 'A0') outputs.add(p);
    }
  }
  for (const t of pinsOf(src, 'digitalRead')) {
    const p = pin(t);
    if (p && p !== 'A0') inputs.add(p);
  }
  if (/\banalogRead\s*\(/.test(src)) plan.push({ kind: 'pot', pin: 'A0' });

  for (const p of outputs) if (!claimed.has(p)) plan.push({ kind: 'led', pin: p });
  for (const p of inputs) if (!claimed.has(p) && !outputs.has(p)) plan.push({ kind: 'button', pin: p });
  return plan;
}

/** Materialise a plan: fresh board, helpers wire everything (same code the example presets use). */
export function buildFromPlan(plan: PlannedPart[], boardId: string): Schematic {
  const sc = new Schematic();
  sc.addBoard(boardId, 160, 60);
  const board = sc.boardComponent()!;
  for (const part of plan) {
    switch (part.kind) {
      case 'led': addLedChain(sc, part.pin); break;
      case 'button': addButton(sc, part.pin); break;
      case 'pot': addPot(sc, part.pin); break;
      case 'dht': addDht(sc, part.pin); break;
      case 'neopixel': {
        const m = sideModule(sc, 'neopixel', part.pin, 220, { count: 8 });
        wire(sc, { comp: m.comp.id, pin: 'din' }, { comp: board.id, pin: part.pin });
        wire(sc, { comp: m.comp.id, pin: 'vcc' }, { comp: board.id, pin: '3V3' });
        wire(sc, { comp: m.comp.id, pin: 'gnd' }, { comp: board.id, pin: 'GND' });
        break;
      }
      case 'servo': {
        const m = sideModule(sc, 'servo', part.pin, 220, {});
        wire(sc, { comp: m.comp.id, pin: 'sig' }, { comp: board.id, pin: part.pin });
        wire(sc, { comp: m.comp.id, pin: 'vcc' }, { comp: board.id, pin: '3V3' });
        wire(sc, { comp: m.comp.id, pin: 'gnd' }, { comp: board.id, pin: 'GND' });
        break;
      }
      case 'hcsr': {
        const p = pinWorld(sc, part.echo);
        const h = sc.add('hcsr', p.x + p.dir * 240, p.y - 40, { cm: 20 });
        wire(sc, { comp: h.id, pin: 'echo' }, { comp: board.id, pin: part.echo });
        wire(sc, { comp: h.id, pin: 'trig' }, { comp: board.id, pin: part.trig });
        wire(sc, { comp: h.id, pin: 'vcc' }, { comp: board.id, pin: '3V3' });
        wire(sc, { comp: h.id, pin: 'gnd' }, { comp: board.id, pin: 'GND' });
        break;
      }
      case 'oled': addOled(sc, part.sda, part.scl); break;
    }
  }
  return sc;
}
