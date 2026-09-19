/**
 * Ticker: `Ticker t; t.attach(0.5, fn);` schedules fn on the cooperative ISR
 * lane every period, like the ESP8266 core's software timer. attach() takes
 * seconds (double), attach_ms() milliseconds; detach() stops the timer.
 */
import { describe, it, expect } from 'vitest';
import { Esp8266Machine } from '../core/machine';

const src = (globals: string, setupBody: string): string => `
  ${globals}
  int ticks = 0;
  void beat() { ticks = ticks + 1; }
  void setup() { Serial.begin(115200); ${setupBody} }
  void loop() { Serial.println(ticks); delay(50); }
`;

function booted(globals: string, setupBody: string): Esp8266Machine {
  const m = new Esp8266Machine({ board: 'wemos-d1-mini' });
  m.netlist.addComponent('mcu', 'mcu', { board: 'wemos-d1-mini', pins: ['D4', '3V3', 'GND'] });
  m.load(src(globals, setupBody));
  m.run();
  return m;
}

const lastTicks = (m: Esp8266Machine): number =>
  Number(m.serial[m.serial.length - 1].text);

describe('Ticker', () => {
  it('attach(seconds, fn) fires repeatedly on the ISR lane', () => {
    const m = booted('Ticker t;', `t.attach(0.1, beat);`);
    m.advance(260); // beats at 100 and 200; the loop prints every 50
    expect(lastTicks(m)).toBeGreaterThanOrEqual(2);
  });

  it('attach_ms(ms, fn) works and detach() stops the ticks', () => {
    const m = booted('Ticker t;', `t.attach_ms(100, beat);`);
    m.advance(260);
    expect(lastTicks(m)).toBeGreaterThanOrEqual(2);
    m.load(src('Ticker t;', `t.attach_ms(100, beat); delay(120); t.detach();`));
    m.run();
    m.advance(500);
    expect(lastTicks(m)).toBe(1);
  });

  it('a detached Ticker stays silent and detach() is idempotent', () => {
    const m = booted('Ticker t;', `t.attach(0.1, beat); delay(120); t.detach(); t.detach();`);
    m.advance(1000);
    expect(lastTicks(m)).toBe(1);
  });

  it('the roleta v19.7.6 sketch parses and boots fault-free', async () => {
    const code = (await import('../examples/roleta_LoLin_WeMos_v19.7.6_k1_sm.ino?raw')).default;
    const m = new Esp8266Machine({ board: 'wemos-d1-mini' });
    m.netlist.addComponent('mcu', 'mcu', { board: 'wemos-d1-mini', pins: ['D4', 'A0', 'D6', 'D5', 'D7', 'D8', 'D3', 'D2', 'D1', 'D0', '3V3', '5V', 'GND'] });
    m.load(code);
    m.run();
    m.advance(4000);
    // a runtime fault halts into phase 'faulted'; load() throws on parse errors
    expect(m.phase(), `fault: ${(m as unknown as { faultReason?: string }).faultReason ?? '?'}`).toBe('running');
  });
});
