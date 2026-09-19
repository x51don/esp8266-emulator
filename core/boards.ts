/**
 * Board definitions: silk-screen labels <-> ESP8266 GPIO numbers.
 *
 * Both supported boards use the NodeMCU convention where the Arduino core maps
 * sketch pin numbers D0..D8 onto GPIOs. GPIO9/GPIO10 are connected to SPI flash
 * on every commercial module and are NOT bonded out, so they resolve to null.
 *
 * `rails` doubles as the physical layout for the GUI board drawing:
 * row = vertical slot index (top to bottom), side = header edge.
 */

export type PinSide = 'left' | 'right';

export interface Rail {
  name: string;       // silkscreen label, e.g. "D1", "3V3", "GND"
  gpio: number | null; // null for power/reset/adc rails
  row: number;
  side: PinSide;
}

export interface Board {
  id: string;
  name: string;
  mcu: string;
  rails: Rail[];
  /** Resolve a silk label ("D4"), raw name ("GPIO2", "2") -> GPIO, or null. */
  gpioFor(name: string | number): number | null;
  /** Reverse lookup GPIO -> primary silk label ("D4"), or null for rails. */
  labelFor(gpio: number): string | null;
}

// NodeMCU-compatible mapping shared by Wemos D1 mini and NodeMCU v3.
const D_PIN_TO_GPIO: Record<string, number> = {
  D0: 16, D1: 5, D2: 4, D3: 0, D4: 2, D5: 14, D6: 12, D7: 13, D8: 15,
};

// GPIO9/10 = flash interface, never exposed.
const INTERNAL_GPIOS = new Set([9, 10]);

function makeBoard(id: string, name: string, rails: Rail[]): Board {
  const gpioToLabel = new Map<number, string>();
  for (const r of rails) if (r.gpio !== null) gpioToLabel.set(r.gpio, r.name);

  const gpioFor = (raw: string | number): number | null => {
    const key = String(raw).trim().toUpperCase();
    if (key in D_PIN_TO_GPIO) return D_PIN_TO_GPIO[key];
    if (/^\d+$/.test(key)) {
      const n = Number(key);
      if (INTERNAL_GPIOS.has(n)) return null;
      // Bare numbers follow the esp8266 Arduino core: 0..16 map to GPIOs,
      // but only when the board actually bonds them out.
      if (n >= 0 && n <= 16) {
        for (const r of rails) if (r.gpio === n) return n;
      }
      return null;
    }
    const m = /^GPIO(\d+)$/.exec(key);
    if (m) return gpioFor(m[1]);
    return null;
  };

  return {
    id,
    name,
    mcu: 'ESP8266EX',
    rails,
    gpioFor,
    labelFor: (gpio) => gpioToLabel.get(gpio) ?? null,
  };
}

/** Wemos D1 mini: 8 signal pins + 3V3/5V/RST/A0 split 7/7 over two headers. */
const WEMOS_RAILS: Rail[] = [
  // left  (top -> bottom)
  { name: 'RST', gpio: null, row: 0, side: 'left' },
  { name: 'A0',  gpio: null, row: 1, side: 'left' },
  { name: 'D0',  gpio: 16,   row: 2, side: 'left' },
  { name: 'D1',  gpio: 5,    row: 3, side: 'left' },
  { name: 'D2',  gpio: 4,    row: 4, side: 'left' },
  { name: 'D3',  gpio: 0,    row: 5, side: 'left' },
  { name: 'D4',  gpio: 2,    row: 6, side: 'left' },
  // right (top -> bottom)
  { name: '3V3', gpio: null, row: 0, side: 'right' },
  { name: '5V',  gpio: null, row: 1, side: 'right' },
  { name: 'D8',  gpio: 15,   row: 2, side: 'right' },
  { name: 'D7',  gpio: 13,   row: 3, side: 'right' },
  { name: 'D6',  gpio: 12,   row: 4, side: 'right' },
  { name: 'D5',  gpio: 14,   row: 5, side: 'right' },
  { name: 'GND', gpio: null, row: 6, side: 'right' },
];

/** NodeMCU v3 (ESP-12E): the long Amica-style headers. */
const NODEMCU_RAILS: Rail[] = [
  // left
  { name: '3V3', gpio: null, row: 0,  side: 'left' },
  { name: 'EN',  gpio: null, row: 1,  side: 'left' },
  { name: 'VS',  gpio: null, row: 2,  side: 'left' },
  { name: 'RST', gpio: null, row: 3,  side: 'left' },
  { name: 'GND', gpio: null, row: 4,  side: 'left' },
  { name: 'D0',  gpio: 16,   row: 5,  side: 'left' },
  { name: 'D1',  gpio: 5,    row: 6,  side: 'left' },
  { name: 'D2',  gpio: 4,    row: 7,  side: 'left' },
  { name: 'D3',  gpio: 0,    row: 8,  side: 'left' },
  { name: 'D4',  gpio: 2,    row: 9,  side: 'left' },
  { name: '5V',  gpio: null, row: 10, side: 'left' },
  // right (silks match the real v3 header: A0, D9, D10, 3V3, GND, HSPI, NC, VU)
  { name: 'A0',  gpio: null, row: 0,  side: 'right' },
  { name: 'D9',  gpio: null, row: 1,  side: 'right' }, // flash-internal, not bonded out
  { name: 'D10', gpio: null, row: 2,  side: 'right' }, // flash-internal, not bonded out
  { name: '3V3', gpio: null, row: 3,  side: 'right' },
  { name: 'GND', gpio: null, row: 4,  side: 'right' },
  { name: 'D8',  gpio: 15,   row: 5,  side: 'right' },
  { name: 'D7',  gpio: 13,   row: 6,  side: 'right' },
  { name: 'D6',  gpio: 12,   row: 7,  side: 'right' },
  { name: 'D5',  gpio: 14,   row: 8,  side: 'right' },
  { name: 'NC',  gpio: null, row: 9,  side: 'right' },
  { name: 'VU',  gpio: null, row: 10, side: 'right' },
];

export const wemosD1Mini: Board = makeBoard('wemos-d1-mini', 'Wemos D1 mini', WEMOS_RAILS);
export const nodeMcuV3: Board = makeBoard('nodemcu-v3', 'NodeMCU v3 (ESP-12E)', NODEMCU_RAILS);

const REGISTRY: Record<string, Board> = {
  [wemosD1Mini.id]: wemosD1Mini,
  [nodeMcuV3.id]: nodeMcuV3,
};

export function listBoards(): Board[] {
  return Object.values(REGISTRY);
}

export function getBoard(id: string): Board {
  const b = REGISTRY[id];
  if (!b) throw new Error(`unknown board id: ${id}`);
  return b;
}
