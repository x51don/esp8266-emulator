/**
 * Left palette: components to drag onto the canvas (HTML5 DnD) plus a short
 * help card explaining the mouse model.
 */

const ITEMS: Array<{ type: string; label: string; hint: string; glyph: string }> = [
  { type: 'board', label: 'Board', hint: 'ESP8266 board (current model from the toolbar)', glyph: '▭' },
  { type: 'led', label: 'LED', hint: 'symbol + 220R, wire p1 to a pin', glyph: '◉' },
  { type: 'resistor', label: 'Resistor', hint: '220R default', glyph: '≡' },
  { type: 'button', label: 'Button', hint: 'momentary (click while running)', glyph: '⊓' },
  { type: 'buzzer', label: 'Buzzer', hint: 'active buzzer', glyph: '♪' },
  { type: 'battery', label: 'Battery', hint: '9V independent source', glyph: '⎓' },
  { type: 'pot', label: 'Potentiometer', hint: '3-pin; drag the knob while running; analogRead(A0)', glyph: '⊶' },
  { type: 'ldr', label: 'LDR', hint: 'light sensor; drag to change lux; pair with a resistor', glyph: '☀' },
  { type: 'dht', label: 'DHT11/22', hint: 'temp + humidity; drag to change values', glyph: '☂' },
  { type: 'servo', label: 'Servo SG90', hint: 'servoAttach/servoWrite; arm animates', glyph: '↻' },
  { type: 'relay', label: 'Relay', hint: 'coil on a pin; NO/NC contacts switch circuits', glyph: '⚡' },
  { type: 'oled', label: 'OLED 0.96"', hint: 'SSD1306 I2C 0x3C; oledBegin/oledPrint', glyph: '▬' },
  { type: 'neopixel', label: 'NeoPixel', hint: 'WS2812 strip; npSetup/npPixel/npShow', glyph: '◍' },
  { type: 'hcsr', label: 'HC-SR04', hint: 'ultrasonic ranger; drag to move the target', glyph: '◎' },
];

export function Palette() {
  return (
    <div className="palette">
      <div className="panel-title">Components</div>
      {ITEMS.map((it) => (
        <div
          key={it.type}
          className="palette-item"
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData('application/x-component', it.type);
            e.dataTransfer.effectAllowed = 'copy';
          }}
          title={it.hint}
        >
          <span className="palette-glyph">{it.glyph}</span>
          <span>{it.label}</span>
        </div>
      ))}
      <div className="palette-help">
        <p>
          drag pins to wire · drag empty space to pan · wheel to zoom
        </p>
        <p>
          <b>R</b> rotate · <b>Del</b> remove · <b>shift-click</b> multi-select
        </p>
        <p>while running: click a button to press it; drag pot / LDR / DHT / HC-SR04 bodies to change their values</p>
      </div>
    </div>
  );
}
