/**
 * Left palette: components to drag onto the canvas (HTML5 DnD), grouped by
 * function, plus a short help card explaining the mouse model.
 */

import { COMPONENT_MIME, dragState } from '../dnd';

interface Item {
  type: string;
  label: string;
  hint: string;
  glyph: string;
  params?: Record<string, unknown>;
}

const GROUPS: Array<{ title: string; items: Item[] }> = [
  {
    title: 'Board',
    items: [
      { type: 'board', label: 'Board', hint: 'ESP8266 board (current model from the toolbar)', glyph: '▭' },
    ],
  },
  {
    title: 'Power',
    items: [
      { type: 'battery', label: 'Battery', hint: 'independent source; dbl-click to set voltage', glyph: '⎓' },
    ],
  },
  {
    title: 'Semiconductors',
    items: [
      { type: 'diode', label: 'Diode 1N4148', hint: 'lets current one way; blocks reverse', glyph: '\u25B6|' },
      { type: 'zener', label: 'Zener diode', hint: 'clamps reverse voltage; dbl-click sets Vz', glyph: '\u25B6Z' },
      { type: 'transistor', label: 'Transistor NPN', hint: 'BC547; base drives the collector-emitter switch', glyph: '\u22A2' },
      { type: 'transistor', label: 'Transistor PNP', hint: 'BC557; high-side switch, active-LOW base', glyph: '\u22A3', params: { polarity: 'pnp' } },
      { type: 'mosfet', label: 'MOSFET IRL540N', hint: 'logic-level gate; drives big loads from a pin', glyph: '\u22A2|' },
    ],
  },
  {
    title: 'Passive',
    items: [
      { type: 'resistor', label: 'Resistor', hint: '220R default; dbl-click to set ohms', glyph: '≡' },
      { type: 'cap', label: 'Capacitor', hint: '100uF default; stores charge (ideal at logic level)', glyph: '⊣⊢' },
    ],
  },
  {
    title: 'Outputs',
    items: [
      { type: 'led', label: 'LED', hint: 'symbol + 220R, wire p1 to a pin', glyph: '◉' },
      { type: 'buzzer', label: 'Buzzer', hint: 'active buzzer', glyph: '♪' },
      { type: 'servo', label: 'Servo SG90', hint: 'servoAttach/servoWrite; arm animates', glyph: '↻' },
      { type: 'relay', label: 'Relay', hint: 'coil on a pin; NO/NC contacts switch circuits', glyph: '⚡' },
      { type: 'motor', label: 'DC motor', hint: 'spins on polarity, swap leads to reverse; drive through a MOSFET, PWM scales speed', glyph: 'Ⓜ' },
      { type: 'neopixel', label: 'NeoPixel', hint: 'WS2812 strip; npSetup/npPixel/npShow', glyph: '◍' },
    ],
  },
  {
    title: 'Inputs',
    items: [
      { type: 'button', label: 'Button', hint: 'momentary (click while running)', glyph: '⊓' },
      { type: 'pot', label: 'Potentiometer', hint: '3-pin; drag the knob while running; analogRead(A0)', glyph: '⊶' },
      { type: 'ldr', label: 'LDR', hint: 'light sensor; drag to change lux; pair with a resistor', glyph: '☀' },
      { type: 'dht', label: 'DHT11/22', hint: 'temp + humidity; drag to change values', glyph: '☂' },
      { type: 'hcsr', label: 'HC-SR04', hint: 'ultrasonic ranger; drag to move the target', glyph: '◎' },
    ],
  },
  {
    title: 'Displays',
    items: [
      { type: 'oled', label: 'OLED 0.96"', hint: 'SSD1306 I2C 0x3C; oledBegin, oledSetPixel/Line/Rect, oledShow', glyph: '▬' },
    ],
  },
];

export function Palette() {
  return (
    <div className="palette">
      <div className="panel-title">Components</div>
      {GROUPS.map((g) => (
        <div key={g.title} className="palette-group">
          <div className="palette-group-title">{g.title}</div>
          {g.items.map((it) => (
            <div
              key={it.type}
              className="palette-item"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(COMPONENT_MIME, it.type);
                e.dataTransfer.effectAllowed = 'copy';
                dragState.type = it.type;
                dragState.params = it.params;
              }}
              onDragEnd={() => {
                dragState.type = null;
              }}
              title={it.hint}
            >
              <span className="palette-glyph">{it.glyph}</span>
              <span>{it.label}</span>
            </div>
          ))}
        </div>
      ))}
      <div className="palette-help">
        <p>
          drag pins to wire · drag empty space to pan · wheel to zoom
        </p>
        <p>
          <b>R</b> rotate · <b>H</b> mirror · <b>P</b> properties · <b>Del</b> remove · <b>dbl-click</b> part = properties
        </p>
        <p>
          drag a wire segment to shape it · <b>Alt+click</b> a wire = auto-route again · <b>dbl-click</b> a wire removes it
        </p>
        <p>while running: click a button to press it; drag pot / LDR / DHT / HC-SR04 bodies to change their values</p>
      </div>
    </div>
  );
}
