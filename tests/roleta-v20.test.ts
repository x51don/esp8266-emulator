/**
 * Regression: the real production sketch (examples/roleta_LoLin_v20.ino,
 * 946 lines, GABINET_PARTER variant, IP .150) must boot and serve its
 * Home Assistant contract through the emulator.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Esp8266Machine } from '../core/machine';
import SKETCH from '../examples/roleta_LoLin_v20.ino?raw';

let machine: Esp8266Machine | null = null;
afterEach(() => {
  machine?.dispose();
  machine = null;
});

/** boot the roller and let setup() finish (WiFi join is 1.5 s of vtime) */
function boot(): Esp8266Machine {
  const m = new Esp8266Machine({ board: 'wemos-d1-mini', ip: '192.168.1.150' });
  machine = m;
  m.load(SKETCH);
  m.run();
  m.advance(2500);
  return m;
}

const get = (m: Esp8266Machine, path: string) => {
  const r = m.fetchHttp('GET', `http://192.168.1.150${path}`);
  if (!r && m.faultReason) throw new Error(`fault at ${path}: ${m.faultReason}`);
  return r;
};

describe('roleta v20 on the emulator', () => {
  it('boots: relays off, WiFi joined, MDNS started, server serving', () => {
    const m = boot();
    const out = m.serial.map((l) => l.text).join('\n');
    expect(out).toContain('IP address: 192.168.1.150');
    expect(out).toContain('MDNS responder started');
    const r = get(m, '/STATUS');
    if (!r) throw new Error('machine fault: ' + m.faultReason);
    expect(r?.status).toBe(200);
    expect(r?.body).toContain('Status:');
    expect(r?.body).toContain('Going DOWN'); // v20 boots closing
  });

  it('/TARGET?value=50 sets target_pos to 50% of the counter range', () => {
    const m = boot();
    const r = get(m, '/TARGET?value=50');
    expect([r?.status, r?.body]).toEqual([200, 'TARGET set']);
    const s = get(m, '/STATUS');
    expect(s?.body).toContain('target_pos: 24'); // 50% of _MAX_COUNTER 48
  });

  it('/TARGET without or with a broken value answers 400 and changes nothing', () => {
    const m = boot();
    const r = get(m, '/TARGET');
    expect(r?.status).toBe(400);
    expect(r?.body).toContain('missing or invalid value');
    const s = get(m, '/STATUS');
    expect(s?.body).toContain('target_pos: 0'); // untouched boot value
  });

  it('/STOP stops the roller mid-move started by /DOWN', () => {
    const m = boot();
    expect(get(m, '/DOWN')?.status).toBe(200);
    m.advance(1200); // relay state machine energizes after the gap
    let s = get(m, '/STATUS');
    expect(s?.body).toMatch(/Going DOWN|Relay: DOWN/);
    expect(get(m, '/STOP')?.status).toBe(200);
    m.advance(600); // moveing is recomputed on the 0.5 s tick
    s = get(m, '/STATUS');
    expect(s?.body).toContain('Full Stop!');
  });

  it('/WAKE_UP answers right away even though every peer call fails', () => {
    const m = boot();
    const r = get(m, '/WAKE_UP');
    expect(r?.status).toBe(200);
  });

  it('unknown paths get the library default 404', () => {
    const m = boot();
    expect(get(m, '/nope')?.status).toBe(404);
  });
});
