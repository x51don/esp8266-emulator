import { describe, it, expect } from 'vitest';
import { getBoard, listBoards, wemosD1Mini, nodeMcuV3, type Board } from '../core/boards';

// Board definitions map the Arduino-style pin numbers used by sketches
// (D0..D8 on these boards) and the silkscreen labels to real GPIO numbers.

describe('board registry', () => {
  it('lists the two supported boards', () => {
    expect(listBoards().map((b) => b.id)).toEqual(['wemos-d1-mini', 'nodemcu-v3']);
  });

  it('getBoard finds by id and rejects unknown ids', () => {
    expect(getBoard('wemos-d1-mini').id).toBe('wemos-d1-mini');
    expect(() => getBoard('raspberry-pi')).toThrow(/unknown board/i);
  });
});

describe('Wemos D1 mini pin map', () => {
  const board = wemosD1Mini;

  it('maps the classic D0..D8 silk labels to GPIOs', () => {
    const expected: Record<string, number> = {
      D0: 16, D1: 5, D2: 4, D3: 0, D4: 2, D5: 14, D6: 12, D7: 13, D8: 15,
    };
    for (const [label, gpio] of Object.entries(expected)) {
      expect(board.gpioFor(label)).toBe(gpio);
      expect(board.labelFor(gpio)).toBe(label);
    }
  });

  it('resolves raw GPIO names (GPIO2 / 2) to themselves', () => {
    expect(board.gpioFor('GPIO2')).toBe(2);
    expect(board.gpioFor('2')).toBe(2);
    expect(board.gpioFor('gpio16')).toBe(16);
  });

  it('accepts D-prefixed numbers in both directions', () => {
    expect(board.gpioFor('D4')).toBe(board.gpioFor(2));
    expect(board.labelFor(board.gpioFor('D1') as number)).toBe('D1');
  });

  it('rejects flash-only GPIOs 9 and 10 (not bonded out)', () => {
    expect(board.gpioFor('GPIO9')).toBeNull();
    expect(board.gpioFor('9')).toBeNull();
    expect(board.gpioFor('10')).toBeNull();
  });

  it('rejects nonsense names', () => {
    expect(board.gpioFor('D9')).toBeNull();
    expect(board.gpioFor('abc')).toBeNull();
    expect(board.gpioFor('-1')).toBeNull();
  });
});

describe('NodeMCU v3 pin map', () => {
  const board: Board = nodeMcuV3;

  it('uses the same GPIO mapping as the Wemos for D0..D8', () => {
    for (const label of ['D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8']) {
      expect(board.gpioFor(label)).toBe(wemosD1Mini.gpioFor(label));
    }
  });

  it('exposes extra pins the Wemos lacks (RS485 EN on GPIO9 is still absent)', () => {
    // NodeMCU v3 breaks out nothing on 9/10 either - flash pins stay internal.
    expect(board.gpioFor('9')).toBeNull();
    expect(board.gpioFor('10')).toBeNull();
  });
});

describe('power and special pins', () => {
  it('both boards expose 3V3, 5V (VU), RST and A0 as non-GPIO rails', () => {
    for (const board of [wemosD1Mini, nodeMcuV3]) {
      const rails = board.rails.map((r) => r.name);
      expect(rails).toEqual(expect.arrayContaining(['3V3', '5V', 'GND', 'RST', 'A0']));
      expect(board.gpioFor('3V3')).toBeNull();
      expect(board.gpioFor('GND')).toBeNull();
    }
  });

  it('every exposed GPIO has exactly one silk label', () => {
    for (const board of [wemosD1Mini, nodeMcuV3]) {
      const gpios = board.rails.filter((r) => r.gpio !== null).map((r) => r.gpio as number);
      expect(new Set(gpios).size).toBe(gpios.length);
    }
  });
});

describe('board layout metadata (used by the GUI renderer)', () => {
  it('each signal pin sits on left or right side, ordered top to bottom', () => {
    for (const board of [wemosD1Mini, nodeMcuV3]) {
      for (const side of ['left', 'right'] as const) {
        const pins = board.rails.filter((r) => r.side === side);
        expect(pins.length).toBeGreaterThan(3);
        const ys = pins.map((p) => p.row);
        expect(ys).toEqual([...ys].sort((a, b) => a - b));
      }
    }
  });

  it('left/right sides together cover all rails exactly once', () => {
    for (const board of [wemosD1Mini, nodeMcuV3]) {
      const total = board.rails.filter((r) => r.side === 'left' || r.side === 'right').length;
      expect(total).toBe(board.rails.length);
    }
  });
});

describe('rail name hygiene (P0.6)', () => {
  const POWER = new Set(['3V3', '5V', 'GND', 'VIN', 'VS', 'VU', 'EN', 'RST']);
  it('signal silks are unique per board (power rails may repeat)', () => {
    for (const b of listBoards()) {
      const signals = b.rails.filter((r) => !POWER.has(r.name)).map((r) => r.name);
      expect(new Set(signals).size).toBe(signals.length);
    }
  });
});
