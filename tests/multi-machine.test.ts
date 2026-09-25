/**
 * F6 (repair 6/6): the reference scenario. Every other test file checks one
 * mechanism at a time; a real ESP8266 project does not work like that - a
 * controller talks to a hub and to two neighbours, one of which is slow today
 * and one of which is simply gone, and it keeps running while that happens.
 * This file runs four machines as a bench and checks that their counters and
 * their clocks stay consistent and that nothing wedges.
 *
 * The bench is driven by the CLIENT's clock: `step()` advances the client and
 * nothing else. Peers then gain virtual time only from the traffic they take
 * part in, which is what makes "no machine may run ahead of the one that
 * waited for it" a checkable statement.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Esp8266Machine } from '../core/machine';
import { lan } from '../core/lan';

const HUB = '192.168.1.61';
const CLIENT = '192.168.1.62';
const SLOW = '192.168.1.63';
const GONE = '192.168.1.64';

const SLOW_MS = 400;
const TIMEOUT_MS = 1500;
const LOOP_MS = 20;
/** What one round costs the client on the wire: slow peer + burned timeout. */
const ROUND_MS = SLOW_MS + TIMEOUT_MS + LOOP_MS;

const machine = (ip: string) => new Esp8266Machine({ board: 'wemos-d1-mini', ip });

/** Every bench peer answers /H and counts its hits. */
const SERVER_SKETCH = `
  ESP8266WebServer server(80);
  int hits = 0;
  void setup() {
    Serial.begin(9600);
    server.on("/H", HTTP_GET, []() { hits++; Serial.println("hit"); server.send(200, "text/plain", String(hits)); });
    server.begin();
  }
  void loop() { server.handleClient(); delay(10); }
`;

/**
 * One round per loop(): the healthy hub, the slow neighbour, the dead one.
 * Prints "<code>,<code>,<code>,<millis>" so a test can read the outcome and
 * the exact instant the round finished.
 */
const CLIENT_SKETCH = `
  HTTPClient http;
  void setup() { Serial.begin(9600); }
  void loop() {
    http.begin("http://${HUB}/H");
    http.setTimeout(1500);
    int a = http.GET();
    http.end();
    http.begin("http://${SLOW}/H");
    http.setTimeout(1500);
    int b = http.GET();
    http.end();
    http.begin("http://${GONE}/H");
    http.setTimeout(1500);
    int c = http.GET();
    http.end();
    Serial.print(a); Serial.print(",");
    Serial.print(b); Serial.print(",");
    Serial.print(c); Serial.print(",");
    Serial.println(millis());
    delay(20);
  }
`;

interface Bench {
  hub: Esp8266Machine;
  slow: Esp8266Machine;
  gone: Esp8266Machine;
  client: Esp8266Machine;
  all: Esp8266Machine[];
  faults: string[];
}

function bench(): Bench {
  const hub = machine(HUB);
  const slow = machine(SLOW);
  const gone = machine(GONE);
  for (const s of [hub, slow, gone]) {
    s.load(SERVER_SKETCH);
    s.run();
  }
  const client = machine(CLIENT);
  client.load(CLIENT_SKETCH);
  lan.setPeerLatency(SLOW, SLOW_MS);
  lan.setPeerUnreachable(GONE);

  const faults: string[] = [];
  const all = [client, hub, slow, gone];
  for (const m of all) m.onFault((why) => faults.push(`${m.ip}: ${why}`));
  client.run();
  return { hub, slow, gone, client, all, faults };
}

/** Run the bench for `ms` of the client's own virtual time. */
function step(b: Bench, ms: number): void {
  b.client.advance(ms);
}

function dispose(b: Bench): void {
  for (const m of b.all) m.dispose();
}

/** Parsed client log: one round = [codeHub, codeSlow, codeGone, millis]. */
function rounds(b: Bench): number[][] {
  return b.client.serial
    .map((l) => l.text)
    .filter((t) => t.includes(','))
    .map((t) => t.split(',').map(Number));
}

const hits = (m: Esp8266Machine) => m.serial.filter((l) => l.text === 'hit').length;
const ms = (m: Esp8266Machine) => m.clock.now() / 1000;

describe('multi-machine bench: hub + client + two impaired peers (F6)', () => {
  afterEach(() => {
    for (const ip of [HUB, CLIENT, SLOW, GONE]) lan.clearImpairments(ip);
  });

  it('a round costs exactly the wire: 400 ms of latency plus the burned timeout', () => {
    const b = bench();
    step(b, 5 * ROUND_MS + 500);
    const r = rounds(b);
    expect(r.length).toBe(5);
    const gaps: number[] = [];
    for (let i = 1; i < r.length; i++) gaps.push(r[i][3] - r[i - 1][3]);
    expect(gaps).toEqual([ROUND_MS, ROUND_MS, ROUND_MS, ROUND_MS]);
    dispose(b);
  });

  it('the hub and the slow peer both serve, the dead one is never involved', () => {
    const b = bench();
    step(b, 3 * ROUND_MS + 500);
    const r = rounds(b);
    expect(r.length).toBe(3);
    for (const row of r) expect(row.slice(0, 3)).toEqual([200, 200, -1]);
    // A round may be cut in half by the end of the slice, so a server can be
    // one request ahead of the line the client has printed - never further.
    for (const m of [b.hub, b.slow]) {
      expect(hits(m)).toBeGreaterThanOrEqual(r.length);
      expect(hits(m)).toBeLessThanOrEqual(r.length + 1);
    }
    expect(hits(b.gone)).toBe(0);
    dispose(b);
  });

  it('no machine runs ahead of the one that waited for it', () => {
    const b = bench();
    step(b, 3 * ROUND_MS + 500);
    const client = ms(b.client);
    expect(client).toBeGreaterThan(3 * ROUND_MS);
    for (const m of [b.hub, b.slow, b.gone]) {
      expect(ms(m)).toBeLessThanOrEqual(client);
      expect(ms(m)).toBeGreaterThanOrEqual(0);
    }
    dispose(b);
  });

  it('the wire time is charged to both ends, and a dead peer still ages', () => {
    const b = bench();
    step(b, 3 * ROUND_MS + 500);
    // The slow peer sits behind the same 400 ms of wire for every round, so it
    // ages by the wire it took part in: at least three rounds, and at most one
    // more if the slice ended inside a fourth.
    expect(ms(b.slow)).toBeGreaterThanOrEqual(3 * SLOW_MS);
    expect(ms(b.slow)).toBeLessThanOrEqual(4 * SLOW_MS + LOOP_MS);
    // Unreachable means deaf, not off: it is never served, but it is alive.
    expect(ms(b.gone)).toBeGreaterThan(0);
    expect(hits(b.gone)).toBe(0);
    // The hub only ever runs while it is answering, so it lags furthest.
    expect(ms(b.hub)).toBeLessThan(ms(b.slow));
    dispose(b);
  });

  it('nothing faults, nothing hangs, and the loop keeps making progress', () => {
    const b = bench();
    step(b, 3 * ROUND_MS + 500);
    expect(b.faults).toEqual([]);
    for (const m of b.all) expect(m.phase()).toBe('running');
    const before = rounds(b).length;
    // Another slice of virtual time must produce another round: a wedged
    // scheduler shows up as a log that stands still while the clock moves.
    step(b, ROUND_MS + 500);
    expect(rounds(b).length).toBeGreaterThan(before);
    expect(b.faults).toEqual([]);
    dispose(b);
  });

  it('the whole bench is deterministic - same scenario, identical log and clocks', () => {
    const first = bench();
    step(first, 6 * ROUND_MS + 500);
    const logA = rounds(first).map((r) => r.join(','));
    const clocksA = first.all.map(ms);
    dispose(first);

    const second = bench();
    step(second, 6 * ROUND_MS + 500);
    const logB = rounds(second).map((r) => r.join(','));
    const clocksB = second.all.map(ms);
    dispose(second);

    expect(logB.length).toBe(6);
    expect(logB).toEqual(logA);
    expect(clocksB).toEqual(clocksA);
  });

  it('the client keeps its pins in a legal state while the network misbehaves', () => {
    const b = bench();
    // Driving both motor inputs at once while a peer is slow is exactly the
    // bug the bench is supposed to make visible - here it must stay clean.
    b.client.addPinInvariant({
      never: [
        ['D5', 1],
        ['D6', 1],
      ],
      label: 'motor both on',
    });
    step(b, 3 * ROUND_MS + 500);
    expect(b.client.invariantViolations).toEqual([]);
    expect(rounds(b).length).toBe(3);
    dispose(b);
  });

  it('a peer that comes back mid-scenario is served again without a reboot', () => {
    const b = bench();
    step(b, 2 * ROUND_MS + 500); // two rounds with the neighbour dead
    lan.clearImpairments(GONE);
    step(b, 2 * ROUND_MS); // and now it answers
    const r = rounds(b);
    expect(r.length).toBeGreaterThan(3);
    expect(r[0][2]).toBe(-1);
    expect(r[r.length - 1][2]).toBe(200);
    expect(hits(b.gone)).toBe(r.filter((x) => x[2] === 200).length);
    dispose(b);
  });

  it('every machine ticking at once still converges - no re-entrant stall', () => {
    const b = bench();
    // The GUI advances every device each frame, so a peer can be pumped while
    // it is already mid-advance. Nobody may end up waiting on itself.
    const frames = Math.ceil((6 * ROUND_MS) / 20) + 20;
    for (let frame = 0; frame < frames; frame++) {
      for (const m of b.all) m.advance(20);
    }
    expect(b.faults).toEqual([]);
    for (const m of b.all) expect(m.phase()).toBe('running');
    const r = rounds(b);
    expect(r.length).toBeGreaterThanOrEqual(5);
    expect(hits(b.hub)).toBeGreaterThanOrEqual(r.length);
    expect(hits(b.hub)).toBeLessThanOrEqual(r.length + 1);
    // Every machine kept its own clock and none of them ran away with it.
    for (const m of b.all) expect(m.clock.now()).toBeGreaterThan(0);
    dispose(b);
  });
});
