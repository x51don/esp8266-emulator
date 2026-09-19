/**
 * Esp8266Machine - the facade the GUI talks to.
 *
 * Assembles: Clock (virtual time) + GpioRegisters (real register addresses)
 * + GpioBus (pin electricity) + Netlist (the drawn circuit) + Interpreter
 * (the sketch). The host is passive: advance(ms) runs virtual time, nothing
 * moves on its own, so tests are deterministic and the GUI can map
 * wall-clock to virtual time with a speed factor.
 *
 * CPU driving model (cooperative):
 * - setup()/loop() run as generators; delay() suspends into a clock task;
 * - loop() bodies re-enter through the scheduler so timers keep firing;
 * - loop bodies also yield 'tick' regularly, and the pump has a slice budget
 *   so even delay-free loops stay interruptible;
 * - timer0 ISRs run cooperatively between CPU slices (documented deviation
 *   from real hardware, which preempts).
 */

import { Clock, type TimerId } from './clock';
import { lan, parseForm, parseUrl } from './lan';
import type { HttpReq, HttpResp, LanHost } from './lan';
import {
  GpioRegisters, GPIO_OUT_W1TS, GPIO_OUT_W1TC, GPIO_ENABLE_W1TS, GPIO_ENABLE_W1TC,
} from './registers';
import { GpioBus, PIN_INPUT, PIN_OUTPUT, PIN_INPUT_PULLUP } from '../peripherals/gpio';
import { Netlist, type ResolveResult } from '../peripherals/netlist';
import { Interpreter, type SketchGen, type HostResult, type HostValue } from './sketch/interp';
import { parse } from './sketch/parser';
import { getBoard } from './boards';

export interface SerialLine {
  /** Stable monotonic id: React keys survive window shifts. */
  id: number;
  tMs: number;
  text: string;
}

export type MachinePhase = 'loaded' | 'running' | 'stopped' | 'faulted';

interface Alarm {
  periodUs: number;
  reload: boolean;
  task: TimerId | null;
  armed: boolean;
}

const PUMP_SLICE = 5000; // tick yields before the CPU hands the world a turn
/**
 * Interpreter yields allowed per advance() call. The interpreter is the chip
 * speed: when a sketch burns this budget the simulation slows down relative
 * to wall time, instead of freezing the browser (measured ~0.4 us per yield,
 * so 20 000 keeps one frame near 8 ms). World clock and peripherals keep
 * their exact pace; only the sketch CPU is throttled.
 */
const FRAME_YIELD_BUDGET = 20_000;
/** Budget for run()'s synchronous setup() window; generous so boot feels
 *  instant on sane sketches while `while(true)` still terminates. */
const SETUP_YIELD_BUDGET = 400_000;
/** Hard cap on the in-memory serial log: a runaway println loop must not eat
 *  the tab. The React view keeps its own smaller window; `droppedLines` counts
 *  what fell off (reset by run()). */
const MAX_SERIAL_LINES = 5000;

/** Shared shape for every registered library object (wifi.objs). */
interface LibObj {
  kind: string;
  port: number;
  peer: string | null;
  listening: boolean;
  args: number[];
  /** ESP8266WebServer routes: uri -> handler function name + method mask */
  routes?: Map<string, { fn: string; method: number }>;
  notFoundFn?: string;
  active?: HttpReq | null;
  /** HTTPClient request state */
  url?: { host: string; port: number; uri: string; args: [string, string][] } | null;
  timeoutMs?: number;
  outBody?: string;
  resp?: HttpResp | null;
  lastError?: number;
}

export class Esp8266Machine implements LanHost {
  readonly clock = new Clock();
  readonly registers: GpioRegisters;
  readonly gpio = new GpioBus();
  readonly netlist: Netlist;

  private source: string | null = null;
  private interp: Interpreter | null = null;
  private mainGen: SketchGen | null = null;
  private isrGen: SketchGen | null = null;
  private mainSuspended = false;
  private machinePhase: MachinePhase = 'loaded';
  private cpuTask: TimerId | null = null;
  private isrTask: TimerId | null = null;
  private alarms = new Map<number, Alarm>();
  private isrQueue: string[] = [];
  /** P3.3 WiFi mock: scripted radio + object registry. No sockets. */
  private wifi = {
    /** µs timestamp when the link comes up; null = not associated. */
    connectAt: null as number | null,
    objs: new Map<string, {
      kind: 'WiFiClient' | 'WiFiServer' | 'WiFiUDP' | 'ESP8266WebServer' | 'HTTPClient' | 'IPAddress' | 'Adafruit_NeoPixel';
      port: number;
      peer: string | null;
      listening: boolean;
      args: number[];
    }>(),
  };
  /** P3.2 attachInterrupt(): gpio -> {isr, mode}; CHANGE=0 FALLING=1 RISING=2. */
  private attachments = new Map<number, { fn: string; mode: number }>();
  private isrPrev = new Map<number, 0 | 1>();
  private lastCircuit: ResolveResult | null = null;
  /** Versions the last resolve() consumed (P1.1 re-solve signal). */
  private solvedGpio = -1;
  private solvedNet = -1;
  private servos = new Map<number, number>(); // gpio -> angle (degrees)
  // compId -> visible pixels (SSD1306 page layout), back buffer, text cells
  private oleds = new Map<string, { cells: string[]; fb: Uint8Array; draw: Uint8Array }>();
  private oledBound: string | null = null;
  private npStrips = new Map<number, { count: number; physical: number; pixels: number[] }>();

  private serialLog: SerialLine[] = [];
  /** Lines dropped from `serialLog` after MAX_SERIAL_LINES (since last run). */
  droppedLines = 0;
  private lineSeq = 0;
  private serialListeners: Array<(line: SerialLine) => void> = [];
  private printBuf = '';
  private circuitListeners: Array<(r: ResolveResult) => void> = [];
  private faultListeners: Array<(reason: string) => void> = [];
  faultReason: string | null = null;
  /** ESP.restart() latched; consumed by advance() to reboot from setup(). */
  private restartRequested = false;
  /** F7: names announced via MDNS.begin, released on dispose */
  private mdnsNames = new Set<string>();
  /** F8: NTP lock; epoch = wall clock at boot + virtual time since the lock */
  private ntp: { syncAt: number | null; gmtOff: number; dstOff: number } = {
    syncAt: null, gmtOff: 0, dstOff: 0,
  };
  /** F8: TimeLib setTime() base, or null when now() follows the NTP epoch */
  private timeLib: { base: number; setAt: number } | null = null;
  /** F6: the emulated flash sector; survives run()/restart, not the GC. */
  private eeprom = new Uint8Array(4096).fill(0xff);
  /** bumps on every commit() - the GUI uses it to mark a project dirty */
  eepromDirty = 0;
  /** -1 = unlimited; otherwise remaining interpreter yields for this advance. */
  private yieldBudget = -1;

  /** F5: LAN identity; two machines on one page need distinct ips. */
  readonly ip: string;
  private httpInbox: HttpReq[] = [];

  /** LanHost: queue a request for this machine's HTTP server(s). */
  deliver(req: HttpReq): void {
    this.httpInbox.push(req);
  }

  /** LanHost: run this world by `ms` virtual ms (safe from another machine). */
  pump(ms: number): void {
    this.advance(ms);
  }

  /** drop the machine from the LAN (GUI: unmount / close tab) */
  dispose(): void {
    this.halt();
    lan.unregister(this);
    for (const name of this.mdnsNames) lan.releaseName(name, this.ip);
    this.mdnsNames.clear();
  }

  constructor(opts: { board: string; ip?: string }) {
    this.ip = opts.ip ?? '192.168.1.42';
    this.boardId = opts.board;
    this.netlist = new Netlist(this.gpio);
    this.registers = new GpioRegisters((mask) => this.sampleIn(mask));
    // Sketch writes land in W1TS/W1TC; mirror them into the electrical bus.
    this.registers.onOutChange((mask) => this.syncOut(mask));
    // Register-level enable changes alone do not set the sketch's intended
    // mode (INPUT vs INPUT_PULLUP are indistinguishable there), so pinMode()
    // configures the bus directly; this direction keeps bus -> register true.
    void GPIO_ENABLE_W1TS;
    void GPIO_ENABLE_W1TC;
  }

  readonly boardId: string;

  // ---------- public API ----------

  get serial(): readonly SerialLine[] {
    return this.serialLog;
  }

  onSerial(cb: (line: SerialLine) => void): () => void {
    this.serialListeners.push(cb);
    return () => {
      const i = this.serialListeners.indexOf(cb);
      if (i >= 0) this.serialListeners.splice(i, 1);
    };
  }

  onCircuit(cb: (r: ResolveResult) => void): () => void {
    this.circuitListeners.push(cb);
    return () => {
      const i = this.circuitListeners.indexOf(cb);
      if (i >= 0) this.circuitListeners.splice(i, 1);
    };
  }

  /** Notified once when advance() faults the machine; returns an unsubscribe. */
  onFault(cb: (reason: string) => void): () => void {
    this.faultListeners.push(cb);
    return () => {
      const i = this.faultListeners.indexOf(cb);
      if (i >= 0) this.faultListeners.splice(i, 1);
    };
  }

  private fault(reason: string): void {
    if (this.machinePhase === 'faulted') return;
    this.halt();
    this.machinePhase = 'faulted';
    this.faultReason = reason;
    for (const cb of [...this.faultListeners]) cb(reason);
  }

  load(source: string): void {
    parse(source); // validate early; throws with line numbers
    this.source = source;
    this.interp = new Interpreter(parse(source), this.env());
    this.machinePhase = 'loaded';
  }

  /** Cold start: fresh globals, pins and time; runs setup() then loop(). */
  run(): void {
    if (this.source === null) {
      throw new Error('no sketch loaded - call load(source) first');
    }
    this.restartRequested = false;
    this.halt();
    this.clock.restart();
    this.registers.reset();
    this.gpio.reset();
    this.serialLog = [];
    this.alarms.clear();
    this.wifi.connectAt = null;
    this.ntp = { syncAt: null, gmtOff: 0, dstOff: 0 };
    this.timeLib = null;
    this.wifi.objs.clear();
    this.interp = new Interpreter(parse(this.source), this.env());
    this.machinePhase = 'running';
    this.faultReason = null;
    this.printBuf = '';
    this.droppedLines = 0;
    this.mainGen = this.interp.setup();
    this.mainSuspended = false;
    this.scheduleWake(0, false);
    try {
      this.yieldBudget = SETUP_YIELD_BUDGET;
      this.clock.advance(10); // setup() completes synchronously inside run()
    } catch (e) {
      // setup() blew up: leave the machine inert (not 'running'), rethrow for
      // the caller - the toolbar shows the error and the user edits the sketch.
      this.halt();
      this.machinePhase = 'stopped';
      throw e;
    } finally {
      this.yieldBudget = -1;
    }
  }

  stop(): void {
    this.halt();
    this.faultReason = null;
    this.machinePhase = 'stopped';
  }

  reset(): void {
    this.netlist.resetCapacitors(); // restarts are deterministic
    this.servos.clear();
    this.oleds.clear();
    this.oledBound = null;
    this.npStrips.clear();
    this.halt();
    this.clock.restart();
    this.registers.reset();
    this.gpio.reset();
    this.alarms.clear();
    this.serialLog = [];
    this.printBuf = '';
    this.droppedLines = 0;
    this.machinePhase = 'loaded';
    this.resolveCircuit();
  }

  /** Advance virtual time by `ms` milliseconds and re-resolve the circuit.
   *  Never throws: a runtime error faults the machine and notifies onFault. */
  advance(ms: number): void {
    this.yieldBudget = FRAME_YIELD_BUDGET;
    this.netlist.advanceTime(Math.round(ms * 1000)); // P3.4 RC relaxation
    try {
      this.clock.advance(ms * 1000);
    } catch (e) {
      this.fault(e instanceof Error ? e.message : String(e));
    } finally {
      this.yieldBudget = -1;
    }
    if (this.restartRequested) {
      this.restartRequested = false;
      this.run(); // a board reset clears the sketch state and serial buffer
      return;
    }
    this.resolveCircuit();
  }

  timeMs(): number {
    return Math.floor(this.clock.now() / 1000);
  }

  phase(): MachinePhase {
    return this.machinePhase;
  }

  pinLevel(gpio: number): 0 | 1 {
    return this.gpio.read(gpio);
  }

  pwm(gpio: number): number {
    return this.gpio.getPwm(gpio);
  }

  circuit(): ResolveResult {
    return this.lastCircuit ?? {
      leds: new Map(), pinLevels: new Map(), externals: new Map(),
      faults: [], netOf: new Map(), netVoltage: new Map(),
    };
  }

  /**
   * P3.1: bias the ADC pin from the UI (a bench supply behind 10k). Null
   * releases it. Survives document resyncs (Netlist keeps it pinned).
   */
  setAnalogForce(volts: number | null): void {
    this.netlist.pinForce('adc-force', volts, 'mcu.A0');
    this.resolveCircuit();
  }

  press(switchId: string, closed: boolean): void {
    this.netlist.setSwitchState(switchId, closed);
    this.resolveCircuit();
  }

  /**
   * P3.3: instance methods for WiFi mock objects (receiver resolved by the
   * caller from the dotted callee). TCP writes are mirrored to the Serial
   * console with a [net->host:port] tag - the "Serial-only dashboard".
   * available()/read() stay empty: outside clients cannot connect here.
   */
  /** F8: locked NTP epoch in seconds (virtual-time-corrected), 0 while syncing */
  private ntpEpochSec(): number {
    if (this.ntp.syncAt === null || this.clock.now() < this.ntp.syncAt) return 0;
    return Math.floor((Date.now() + (this.clock.now() - this.ntp.syncAt) / 1000) / 1000);
  }

  /** 4 KiB emulated EEPROM (core layout: LE lengths, raw ints/floats). */
  eepromBytes(): Uint8Array {
    return this.eeprom.slice();
  }

  eepromRestore(bytes: Uint8Array): void {
    this.eeprom.set(bytes.subarray(0, Math.min(bytes.length, 4096)));
  }

  private eepromCall(meth: string, args: HostValue[]): HostResult {
    const num = (v: HostValue | undefined): number =>
      typeof v === 'number' ? v : Number(v ?? 0) || 0;
    const ok = (v: number) => ({ value: v });
    const rd = (addr: number): number =>
      addr >= 0 && addr < 4096 ? this.eeprom[addr] : 0xff;
    const dv = new DataView(this.eeprom.buffer);
    switch (meth) {
      case 'begin':
        return ok(args.length === 0 || (num(args[0]) > 0 && num(args[0]) <= 4096) ? 1 : 0);
      case 'read':
        return ok(rd(num(args[0])));
      case 'write': {
        const a = num(args[0]);
        if (a >= 0 && a < 4096) this.eeprom[a] = Math.trunc(num(args[1])) & 0xff;
        return ok(0);
      }
      case 'commit':
        this.eepromDirty++;
        return ok(1);
      case 'length':
        return ok(4096);
      case 'erase': case 'clear':
        this.eeprom.fill(0xff);
        return ok(1);
      case 'readString': {
        const a = num(args[0]);
        if (a < 0 || a + 4 > 4096) return { value: '' };
        const n = dv.getUint32(a, true);
        if (n > 4096 - a - 4) return { value: '' }; // erased (0xFFFFFFFF) or corrupt
        return { value: String.fromCharCode(...this.eeprom.subarray(a + 4, a + 4 + n)) };
      }
      case 'writeString': {
        const a = num(args[0]);
        const text = typeof args[1] === 'string' && !args[1].startsWith('@') ? args[1] : '';
        if (a < 0 || a + 4 + text.length > 4096) return ok(0);
        dv.setUint32(a, text.length, true);
        for (let i = 0; i < text.length; i++) this.eeprom[a + 4 + i] = text.charCodeAt(i) & 0xff;
        return ok(1);
      }
      case 'readInt': {
        const a = num(args[0]);
        return a >= 0 && a + 4 <= 4096 ? ok(dv.getInt32(a, true)) : ok(-1);
      }
      case 'writeInt': {
        const a = num(args[0]);
        if (a >= 0 && a + 4 <= 4096) dv.setInt32(a, Math.trunc(num(args[1])) | 0, true);
        return ok(0);
      }
      case 'readFloat': case 'readDouble': {
        const a = num(args[0]);
        const size = meth === 'readFloat' ? 4 : 8;
        if (a < 0 || a + size > 4096) return ok(0);
        return ok(meth === 'readFloat' ? dv.getFloat32(a, true) : dv.getFloat64(a, true));
      }
      case 'writeFloat': case 'writeDouble': {
        const a = num(args[0]);
        const size = meth === 'writeFloat' ? 4 : 8;
        if (a >= 0 && a + size <= 4096) {
          if (meth === 'writeFloat') dv.setFloat32(a, num(args[1]), true);
          else dv.setFloat64(a, num(args[1]), true);
        }
        return ok(0);
      }
      default:
        throw new Error(`EEPROM.${meth} is not implemented on the emulated ESP8266`);
    }
  }

private npCall(obj: LibObj, meth: string, args: HostValue[]): HostResult {
  const num = (v: HostValue | undefined): number => (typeof v === 'number' ? v : Number(v ?? 0));
  // Adafruit packs Color() as G<<16|R<<8|B; the netlist strip stores RR GG BB
  const unpack = (c: number) => ({ r: (c >> 8) & 0xff, g: (c >> 16) & 0xff, b: c & 0xff });
  const strip = (): { count: number; physical: number; pixels: number[] } | null => {
    const gpio = obj.args[1] ?? 0;
    let st = this.npStrips.get(gpio);
    if (!st) {
      const comp = this.sensorAt('neopixel', gpio, 'din');
      if (!comp) return null; // nothing wired: the API answers, writes drop
      const physical = Math.max(1, Math.min(64, Number(comp.params.count ?? 8) || 8));
      const count = Math.max(1, Math.min(64, obj.args[0] || 8));
      st = { count, physical, pixels: Array.from({ length: physical }, () => 0) };
      this.npStrips.set(gpio, st);
    }
    return st;
  };
  switch (meth) {
    case 'begin': case 'show': case 'sync': case 'setBrightness':
    case 'setBrightnessColor': case 'updateLength': case 'updatePinAndMap':
    case 'setPin': case 'setByteOrder':
      return { value: 0 };
    case 'numPixels':
      return { value: Math.max(1, Math.min(64, obj.args[0] || 8)) };
    case 'Color': {
      const [r, g, b] = args.map((a) => num(a));
      return { value: (((g & 0xff) << 16) | ((r & 0xff) << 8) | (b & 0xff)) >>> 0 };
    }
    case 'gamma32':
      return { value: num(args[0]) };
    case 'setPixelColor': {
      const st = strip();
      if (!st) return { value: 0 };
      const i = num(args[0]);
      const c = unpack(num(args[1]));
      if (i >= 0 && i < st.count && i < st.pixels.length)
        st.pixels[i] = (c.r << 16) | (c.g << 8) | c.b;
      return { value: 0 };
    }
    case 'getPixelColor': {
      const st = strip();
      if (!st) return { value: 0 };
      const p = st.pixels[num(args[0])] ?? 0;
      return { value: (((p >> 8) & 0xff) << 16) | (((p >> 16) & 0xff) << 8) | (p & 0xff) };
    }
    case 'clear': {
      const st = strip();
      if (!st) return { value: 0 };
      const c = unpack(num(args[0]));
      st.pixels.fill((c.r << 16) | (c.g << 8) | c.b);
      return { value: 0 };
    }
    default:
      throw new Error(`'Adafruit_NeoPixel' has no method '${meth}'`);
  }
}

private ipCall(obj: LibObj, meth: string, args: HostValue[]): HostResult {
  switch (meth) {
    case 'toString':
      return { value: obj.args.slice(0, 4).join('.') };
    case 'fromString': {
      const parts = String(args[0] ?? '').split('.').map((x) => parseInt(x, 10) || 0);
      if (parts.length !== 4) return { value: 0 };
      obj.args = parts;
      return { value: 1 };
    }
    default:
      throw new Error(`'IPAddress' has no method '${meth}'`);
  }
}

/**
 * ESP8266WebServer object API. Requests arrive through the LAN inbox
 * (panel or another machine); handleClient() drains one per call, exactly
 * like the real library. Handlers run to completion inside handleClient -
 * delay() inside a handler is a documented no-op (milestone 12).
 */
private webCall(obj: LibObj, meth: string, args: HostValue[]): HostResult {
  const num = (v: HostValue | undefined): number => (typeof v === 'number' ? v : Number(v ?? 0));
  const str = (v: HostValue | undefined): string => (typeof v === 'string' ? v : String(v ?? ''));
  if (!obj.routes) obj.routes = new Map();
  switch (meth) {
    case 'on': {
      // on(path, fn) or on(path, HTTP_GET, fn)
      const fn = str(args[args.length - 1]);
      const method = args.length >= 3 ? num(args[1]) : 7;
      if (!/^[\w]+$/.test(fn)) throw new Error(`server.on handler must be a function, got '${fn}'`);
      obj.routes.set(str(args[0]), { fn, method });
      return { value: 0 };
    }
    case 'onNotFound':
      obj.notFoundFn = str(args[args.length - 1]);
      return { value: 0 };
    case 'begin':
      obj.listening = true;
      lan.register(this);
      return { value: 0 };
    case 'handleClient': {
      const req = this.httpInbox.shift();
      if (!req) return { value: 0 };
      const route = obj.routes.get(req.uri);
      const ok = route !== undefined && (route.method & (req.method === 'GET' ? 1 : 2)) !== 0;
      obj.active = req;
      try {
        const fn = ok ? route.fn : obj.notFoundFn;
        if (fn && this.interp?.hasFunction(fn)) this.drainGen(this.interp.callFn(fn));
        if (!req.resp)
          req.resp = ok
            ? { status: 200, body: '' } // handler forgot to send: empty 200
            : { status: 404, body: 'File not found:' };
      } finally {
        obj.active = null;
      }
      return { value: 1 };
    }
    case 'send': {
      const active = obj.active;
      if (active) active.resp = { status: num(args[0]), body: str(args[2]) };
      return { value: 0 };
    }
    case 'sendContent': {
      const active = obj.active;
      if (active?.resp) active.resp.body += str(args[0]);
      return { value: 0 };
    }
    case 'sendHeader': case 'send_P': case 'sendContent_P': case 'streamFile':
    case 'sendChunked_start': case 'sendChunked_write': case 'sendChunked_end':
      return { value: 0 };
    case 'uri': return { value: obj.active?.uri ?? '' };
    case 'method':
      return { value: obj.active ? (obj.active.method === 'GET' ? 'GET' : 'POST') : '' };
    case 'methodString': return { value: obj.active ? (obj.active.method ?? 'GET') : '' };
    case 'hostHeader': return { value: `${this.ip}:${obj.port}` };
    case 'args': return { value: obj.active?.args.length ?? 0 };
    case 'argName': return { value: obj.active?.args[num(args[0])]?.[0] ?? '' };
    case 'hasArg':
      return { value: obj.active?.args.some(([k]) => k === str(args[0])) ? 1 : 0 };
    case 'arg': {
      // Arduino overloads: arg(name) searches, arg(index) reads positionally
      if (obj.active && typeof args[0] === 'number')
        return { value: obj.active.args[num(args[0])]?.[1] ?? '' };
      const pair = obj.active?.args.find(([k]) => k === str(args[0]));
      return { value: pair ? pair[1] : '' };
    }
    case 'collectHeaders': case 'handleReset': case 'close': case 'closeCurrentConnection':
    case 'forceClose': case 'processExit': case 'enableCORS': case 'enableCacheControl':
    case 'enableTwoWire': case 'setContentLength': case 'ignoreAllOptions':
    case 'setContentFreeRAM':
      return { value: 0 };
    case 'hasClient': return { value: this.httpInbox.length > 0 ? 1 : 0 };
    default:
      throw new Error(`'ESP8266WebServer' has no method '${meth}'`);
  }
}

/**
 * HTTPClient: begin(url)/begin(client, url)/begin(client, host, port, path),
 * GET()/POST(body), GET-returns -1 for unknown peers (that is what makes
 * the v20 peer_cmd retry loop testable), getString/end.
 */
private httpCall(obj: LibObj, meth: string, args: HostValue[]): HostResult {
  const num = (v: HostValue | undefined): number => (typeof v === 'number' ? v : Number(v ?? 0));
  const str = (v: HostValue | undefined): string => (typeof v === 'string' ? v : String(v ?? ''));
  switch (meth) {
    case 'begin': {
      // begin(url) | begin(client, url) | begin(client, host, port[, path])
      let url = '';
      if (args.length === 1) url = str(args[0]);
      else if (args.length === 2) url = str(args[1]);
      else if (args.length >= 3) {
        const path = args.length >= 4 ? str(args[3]) : '/';
        url = `http://${str(args[1])}:${num(args[2])}${path}`;
      }
      const parts = parseUrl(url);
      obj.url = parts;
      obj.resp = null;
      obj.outBody = '';
      if (obj.timeoutMs === undefined) obj.timeoutMs = 5000;
      return { value: parts ? 1 : 0 };
    }
    case 'setTimeout': case 'setConnectTimeout':
      obj.timeoutMs = num(args[0]);
      return { value: 0 };
    case 'print': case 'println':
      obj.outBody = (obj.outBody ?? '') + str(args[0]);
      return { value: 0 };
    case 'GET': case 'POST': case 'PUT': case 'PATCH': case 'DELETE': {
      const method: 'GET' | 'POST' = meth === 'GET' ? 'GET' : 'POST';
      const url = obj.url;
      if (!url) return { value: -1 };
      const body = args.length ? str(args[0]) : meth === 'POST' ? obj.outBody ?? '' : '';
      const req: HttpReq = {
        method,
        uri: url.uri,
        args: [...url.args, ...(method === 'GET' ? [] : parseForm(body))],
        body,
      };
      const target = lan.routeHost(url.host);
      // no route, or fetching our own machine (our loop is busy inside GET;
      // the emulator does not buffer self-connections) -> connection failed
      if (!target || (target as unknown) === this) {
        obj.resp = null;
        obj.lastError = -1;
        return { value: -1 };
      }
      target.deliver(req);
      const deadline = obj.timeoutMs ?? 5000;
      for (let waited = 0; waited < deadline && !req.resp; waited++) target.pump(1);
      if (!req.resp) {
        obj.resp = null;
        obj.lastError = -1;
        return { value: -1 };
      }
      obj.resp = req.resp;
      return { value: req.resp.status };
    }
    case 'getString': {
      const body = obj.resp?.body ?? '';
      return { value: body };
    }
    case 'getSize': return { value: (obj.resp?.body ?? '').length };
    case 'getStream': return { value: obj.resp?.body ?? '' };
    case 'end':
      obj.url = null;
      obj.resp = null;
      obj.outBody = '';
      return { value: 0 };
    case 'setReuse': case 'setAuthorization': case 'addHeader': case 'setFollowRedirects':
    case 'setDNS': case 'useHTTP11': case 'setCTimeout': case 'setLedOff': case 'setLedOn':
    case 'setConnectionTimeout': case 'setConnectTimeout': case 'setReuse':
      return { value: 0 };
    default:
      throw new Error(`'HTTPClient' has no method '${meth}'`);
  }
}

/** Run a callback generator to completion without touching the clock. */
private drainGen(gen: SketchGen): void {
  let steps = 0;
  let r = gen.next();
  while (!r.done) {
    if (r.value.kind === 'delay') {
      r = gen.next(undefined); // delay() inside an HTTP handler is ignored
      continue;
    }
    if (++steps >= 200_000) {
      gen.return(undefined);
      throw new Error('HTTP handler does not terminate');
    }
    r = gen.next(undefined);
  }
}

/**
 * The GUI "HTTP" panel's entry point: one request to this machine, served
 * the honest way - the sketch must reach handleClient() on its own, so we
 * pump virtual time until the queue empties into a response.
 */
fetchHttp(method: 'GET' | 'POST', url: string, body = ''): HttpResp | null {
  if (this.machinePhase !== 'running') return null;
  const parts = parseUrl(url);
  if (!parts || lan.resolveHost(parts.host) !== this.ip) return null;
  const req: HttpReq = {
    method,
    uri: parts.uri,
    args: [...parts.args, ...(method === 'GET' ? [] : parseForm(body))],
    body,
  };
  this.httpInbox.push(req);
  for (let waited = 0; waited < 2000 && !req.resp; waited++) this.advance(1);
  return req.resp ?? null;
}

  private wifiCall(
    obj: { kind: string; port: number; peer: string | null; listening: boolean },
    meth: string,
    args: HostValue[],
  ): HostResult {
    const up = this.wifi.connectAt !== null && this.clock.now() >= this.wifi.connectAt;
    const str = (v: HostValue) => (typeof v === 'string' ? v : String(v));
    switch (meth) {
      case 'begin': // server.begin() - the port came from the constructor
        obj.listening = true;
        return { value: 1 };
      case 'connect': {
        if (!up) return { value: 0 };
        obj.peer = `${str(args[0] ?? '?')}:${Math.trunc(Number(args[1] ?? 0))}`;
        return { value: 1 };
      }
      case 'stop': obj.peer = null; return { value: 0 };
      case 'connected': return { value: obj.peer ? 1 : 0 };
      case 'available': return { value: 0 };
      case 'read': return { value: -1 };
      case 'flush': case 'setTimeout': case 'setNoDelay': return { value: 1 };
      case 'print': case 'write': {
        if (obj.peer) this.appendText(`[net->${obj.peer}] ${args.map(printValue).join('')}`);
        return { value: 0 };
      }
      case 'println': {
        if (obj.peer) this.appendText(`[net->${obj.peer}] ${args.map(printValue).join('')}
`);
        else if (!args.length) { /* println on a dead peer: no-op */ }
        return { value: 0 };
      }
      default:
        throw new Error(`'${obj.kind}' has no method '${meth}'`);
    }
  }

  // ---------- circuit <-> pins ----------

  private resolveCircuit(): void {
    // P1.1: re-solve only on a change signal (bus or netlist version).
    // An idle frame costs nothing instead of a full Thevenin solve.
    const g = this.gpio.version;
    const n = this.netlist.version;
    if (this.solvedGpio === g && this.solvedNet === n) return;
    this.solvedGpio = g;
    this.solvedNet = n;
    const r = this.netlist.resolve();
    // Feed OTHER drivers (buttons, rails, foreign outputs) back into the bus
    // so digitalRead() sees them; a pin never drives itself through this path.
    // (Feedback that moves a pin bumps the bus version itself, so the next
    // advance() re-solves once more and the result settles.)
    for (const rail of getBoard(this.boardId).rails) {
      if (rail.gpio === null) continue;
      const terminal = `mcu.${rail.name}`;
      const level = r.externals.get(terminal);
      this.gpio.setExternalDriver(rail.gpio, level === undefined ? 'none' : level ? 'high' : 'low');
    }
    this.lastCircuit = r;
    if (this.circuitListeners.length) {
      for (const cb of this.circuitListeners) cb(r);
    }
    this.checkInterrupts();
  }

  /**
   * P3.2: one edge check per circuit solve. Levels that changed between two
   * solves queue the ISR; two edges inside one solve collapse to one, same
   * as a busy MCU missing back-to-back pulses.
   */
  private checkInterrupts(): void {
    if (this.attachments.size === 0 || this.machinePhase !== 'running') return;
    for (const [g, a] of this.attachments) {
      const lvl = this.pinLevel(g);
      const prev = this.isrPrev.get(g);
      if (prev === lvl) continue;
      this.isrPrev.set(g, lvl);
      if (prev === undefined) continue; // first observation after attach
      const edge: 0 | 1 | 2 = lvl === 1 ? 2 : 1; // RISING=2, FALLING=1
      if (a.mode !== 0 && a.mode !== edge) continue;
      if (!this.interp?.hasFunction(a.fn)) {
        this.fault(`attachInterrupt: '${a.fn}()' is not defined`);
        return;
      }
      this.isrQueue.push(a.fn);
      this.scheduleWake(0, true);
    }
  }

  // ---------- CPU pump ----------

  /**
   * The sketch owns at most two coroutines: `mainGen` (setup/loop) and one
   * `isrGen` (timer callback). Each has its own scheduler wake-up task, so a
   * pending delay() wake-up and an alarm can never race for the same slot.
   * ISRs start when the main program is parked inside delay() - cooperative
   * "interrupts" (documented deviation: real hardware preempts anywhere).
   */
  private scheduleWake(us: number, forIsr: boolean): void {
    if (this.machinePhase !== 'running') return;
    const task = this.clock.setTimeout(Math.max(1, Math.round(us)), () => {
      if (forIsr) this.isrTask = null;
      else if (this.cpuTask === task) { this.cpuTask = null; this.mainSuspended = false; }
      else return; // stale wake-up after halt/restart
      this.step();
    });
    if (forIsr) this.isrTask = task;
    else this.cpuTask = task;
  }

  private step(): void {
    if (this.machinePhase !== 'running') return;
    if (!this.isrGen && this.isrQueue.length && this.mainSuspended && this.mainGen) {
      const name = this.isrQueue.shift()!;
      if (this.interp!.hasFunction(name)) this.isrGen = this.interp!.callFn(name);
    }
    if (this.isrGen) {
      this.runGen(this.isrGen, true);
      return;
    }
    if (this.mainSuspended || !this.mainGen) return; // parked in delay(); wake resumes it
    this.runGen(this.mainGen, false);
  }

  private runGen(gen: SketchGen, isIsr: boolean): void {
    let slices = 0;
    for (;;) {
      if (this.yieldBudget === 0) {
        // Out of CPU for this advance(). A 200 us retry quantum keeps the
        // wake-storm cheap while still handing the sketch ~5k wake-ups per
        // virtual millisecond when the world wants it to run.
        this.scheduleWake(200, isIsr);
        return;
      }
      if (this.restartRequested) {
        // ESP.restart(): freeze the program; advance() reboots right after
        this.mainSuspended = true;
        return;
      }
      if (this.yieldBudget > 0) this.yieldBudget -= 1;
      const r = gen.next();
      if (r.done) {
        if (isIsr) {
          this.isrGen = null;
          this.step(); // run the next queued ISR, or let parked main wait for its wake
          return;
        }
        this.mainGen = null;
        this.mainSuspended = false;
        if (this.machinePhase !== 'running' || !this.interp) return;
        this.mainGen = this.interp.loopOnce();
        this.scheduleWake(0, false);
        return;
      }
      const pause = r.value;
      if (pause.kind === 'delay') {
        if (isIsr) this.scheduleWake(pause.us, true);
        else {
          this.mainSuspended = true;
          this.scheduleWake(pause.us, false);
        }
        return;
      }
      if (++slices >= PUMP_SLICE) {
        this.scheduleWake(0, isIsr); // long computation: hand the world a turn
        return;
      }
    }
  }

  private halt(): void {
    for (const gen of [this.mainGen, this.isrGen]) gen?.return(undefined);
    this.mainGen = this.isrGen = null;
    this.mainSuspended = false;
    if (this.cpuTask !== null) this.clock.clear(this.cpuTask);
    if (this.isrTask !== null) this.clock.clear(this.isrTask);
    this.cpuTask = this.isrTask = null;
    this.isrQueue = [];
    this.attachments.clear();
    this.isrPrev.clear();
    this.httpInbox = [];
  }

  // ---------- registers ----------

  private sampleIn(mask: number): number {
    let v = 0;
    for (let g = 0; g < 17; g++) {
      if (mask & (1 << g)) v |= this.gpio.read(g) << g;
    }
    return v;
  }

  private syncOut(mask: number): void {
    // 17-bit logical view: bits 0..15 from the GPIO_OUT register block,
    // bit 16 from the GPIO16 (RTC) block the register file also tracks.
    const out = this.registers.outState();
    for (let g = 0; g < 17; g++) {
      if (mask & (1 << g)) this.gpio.write(g, ((out >> g) & 1) as 0 | 1);
    }
  }

  /** Panel state of every OLED bound so far: visible fb + 8x21 text cells. */
  oledFrames(): ReadonlyMap<string, { cells: string[]; fb: Uint8Array }> {
    return this.oleds;
  }

  /** P3.5 helpers: the back buffer is what drawing commands paint. */
  private oledFrame(): { cells: string[]; fb: Uint8Array; draw: Uint8Array } | null {
    return this.oledBound ? this.oleds.get(this.oledBound) ?? null : null;
  }

  private oledDot(
    f: { cells: string[]; fb: Uint8Array; draw: Uint8Array },
    x: number,
    y: number,
    on: boolean,
  ): void {
    x = Math.trunc(x);
    y = Math.trunc(y);
    if (x < 0 || x > 127 || y < 0 || y > 63) return; // off-panel is dropped
    const i = (y << 4) + (x >> 3);
    const bit = 1 << (x & 7);
    f.draw[i] = on ? f.draw[i] | bit : f.draw[i] & ~bit;
  }

  /** NeoPixel strips per data gpio: 0xRRGGBB per led. */
  strips(): ReadonlyMap<number, { count: number; physical: number; pixels: number[] }> {
    return this.npStrips;
  }

  /** Servo arm angles driven so far (for the schematic renderer). */
  servoAngles(): ReadonlyMap<number, number> {
    return this.servos;
  }

  /** First component of `type` whose `dataPin` net touches this gpio's pin. */
  private sensorAt(type: string, gpio: number, dataPin: string) {
    const label = getBoard(this.boardId).labelFor(gpio);
    if (!label) return null;
    for (const c of this.netlist.componentsOfType(type)) {
      if (this.netlist.sameNet(`mcu.${label}`, `${c.id}.${dataPin}`)) return c;
    }
    return null;
  }

  /**
   * ADC conversion of the voltage netlist.analogVolts reports on A0.
   * Only GPIO 17 (the Arduino A0 alias) has an ADC on the ESP8266.
   */
  analogRead(gpio: number): number {
    if (gpio !== 17) return 0;
    const v = this.netlist.analogVolts('mcu.A0');
    if (v === null) return 0;
    return Math.max(0, Math.min(1023, Math.round((v / 3.3) * 1023)));
  }

  // ---------- Arduino API ----------

  private env() {
    const board = getBoard(this.boardId);
    const constants: Record<string, number> = {
      LOW: 0, HIGH: 1, INPUT: 0, OUTPUT: 1, INPUT_PULLUP: 2,
      LED_BUILTIN: 2, BUILTIN_LED: 2,
      DEC: 10, HEX: 16, OCT: 8, BIN: 2,
      CHANGE: 0, FALLING: 1, RISING: 2, ON: 1, OFF: 0,
      PI: Math.PI, HALF_PI: Math.PI / 2, TWO_PI: 2 * Math.PI,
      timer0: 0, timer1: 1,
      // P3.3 WiFi mock (ESP8266WiFi library values)
      WL_IDLE_STATUS: 0, WL_NO_SSID_AVAIL: 1, WL_SCAN_COMPLETED: 2,
      WL_CONNECTED: 3, WL_CONNECT_FAILED: 4, WL_CONNECTION_LOST: 5, WL_DISCONNECTED: 6,
      WIFI_STA: 1, WIFI_AP: 2, WIFI_AP_STA: 3,
      A0: 17, // ESP8266 Arduino core: analogRead() uses pin 17
      HTTP_ANY: 7, HTTP_GET: 1, HTTP_HEAD: 4, HTTP_POST: 2, HTTP_PATCH: 64, HTTP_PUT: 8,
      NEO_KHZ400: 0x100, NEO_KHZ800: 0x800,
      NULL: 0, nullptr: 0, // Arduino.h / C++11
      NEO_GRB: 0x00, NEO_RGB: 0x08, NEO_BRG: 0x10, NEO_RBG: 0x18, NEO_BGR: 0x20,
    };
    for (let d = 0; d <= 8; d++) {
      const gpio = board.gpioFor(`D${d}`);
      if (gpio !== null) constants[`D${d}`] = gpio;
    }

    const num = (v: HostValue | undefined): number => (typeof v === 'number' ? v : Number(v ?? 0));
    const str = (v: HostValue | undefined): string =>
      typeof v === 'string' ? v : Array.isArray(v) ? v.map(str).join(',') : String(v ?? '');

    return {
      constants,
      millis: () => Math.floor(this.clock.now() / 1000),
      micros: () => Math.floor(this.clock.now()),

      call: (name: string, args: HostValue[]): HostResult => {
        switch (name) {
          case 'pinMode': {
            const g = num(args[0]);
            const m = num(args[1]);
            this.gpio.setMode(g, m === 1 ? PIN_OUTPUT : m === 2 ? PIN_INPUT_PULLUP : PIN_INPUT);
            const bit = 1 << g;
            this.registers.write(m === 1 ? GPIO_ENABLE_W1TS : GPIO_ENABLE_W1TC, bit);
            return { value: 0 };
          }
          case 'digitalWrite': {
            const g = num(args[0]);
            const level = num(args[1]) ? 1 : 0;
            // route through the register file like real firmware does
            this.registers.write(level ? GPIO_OUT_W1TS : GPIO_OUT_W1TC, 1 << g);
            return { value: 0 };
          }
          case 'attachInterrupt': {
            const g = num(args[0]);
            const fn = typeof args[1] === 'string' ? args[1] : String(args[1] ?? '');
            if (g < 0 || g > 16 || !fn)
              return { value: 0 }; // out-of-range pins: accept-and-ignore, like the core
            this.attachments.set(g, { fn, mode: num(args[2]) });
            this.isrPrev.set(g, this.pinLevel(g));
            return { value: 0 };
          }
          case 'detachInterrupt':
            this.attachments.delete(num(args[0]));
            return { value: 0 };
          case 'String':
            return { value: args.length ? printValue(args[0]) : '' };
          case 'digitalRead':
            return { value: this.gpio.read(num(args[0])) };
          case 'analogWrite':
            this.gpio.analogWrite(num(args[0]), num(args[1]));
            return { value: 0 };
          case 'analogRead':
            return { value: this.analogRead(num(args[0])) };
          case 'dhtSetup':
            return { value: this.sensorAt('dht', num(args[0]), 'data') ? 1 : 0 };
          case 'dhtReadTemperature': {
            const c = this.sensorAt('dht', num(args[0]), 'data');
            return { value: c ? Number(c.params.tempC ?? 22) : -999 };
          }
          case 'dhtReadHumidity': {
            const c = this.sensorAt('dht', num(args[0]), 'data');
            return { value: c ? Number(c.params.humPct ?? 50) : -999 };
          }
          case 'hcsrSetup': {
            const t = this.sensorAt('hcsr', num(args[0]), 'trig');
            const e = this.sensorAt('hcsr', num(args[1]), 'echo');
            return { value: t && t === e ? 1 : 0 };
          }
          case 'hcsrDistanceCm': {
            const c = this.sensorAt('hcsr', num(args[0]), 'echo');
            return { value: c ? Number(c.params.cm ?? 0) : -999 };
          }
          case 'hcsrPulseUs': {
            const c = this.sensorAt('hcsr', num(args[0]), 'echo');
            return { value: c ? Math.round(Number(c.params.cm ?? 0) * 58) : -999 };
          }
          case 'servoAttach': {
            const g = num(args[0]);
            if (!this.sensorAt('servo', g, 'sig')) return { value: 0 };
            if (!this.servos.has(g)) this.servos.set(g, 90);
            return { value: 1 };
          }
          case 'servoWrite': {
            const g = num(args[0]);
            this.servos.set(g, Math.max(0, Math.min(180, num(args[1]))));
            return { value: 0 };
          }
          case 'servoRead':
            return { value: this.servos.get(num(args[0])) ?? 0 };
          case 'oledBegin': {
            const addr = args.length ? num(args[0]) : 0x3c;
            const panel = this.netlist
              .componentsOfType('oled')
              .find((c) => Number(c.params.addr ?? 0x3c) === addr);
            if (!panel) return { value: 0 };
            this.oledBound = panel.id;
            if (!this.oleds.has(panel.id)) {
              this.oleds.set(panel.id, {
                cells: Array.from({ length: 8 }, () => ' '.repeat(21)),
                fb: new Uint8Array(1024),
                draw: new Uint8Array(1024),
              });
            }
            // re-init starts from a blank back buffer (the panel itself may
            // still hold the last committed frame until the next oledShow)
            this.oleds.get(panel.id)!.draw = new Uint8Array(1024);
            return { value: 1 };
          }
          case 'oledClear': {
            const f = this.oledFrame();
            if (f) {
              f.cells = Array.from({ length: 8 }, () => ' '.repeat(21));
              f.draw.fill(0);
            }
            return { value: 0 };
          }
          case 'oledPrint': {
            const f = this.oledBound && this.oleds.get(this.oledBound);
            if (!f) return { value: 0 };
            const x = num(args[0]);
            const y = num(args[1]);
            if (y < 0 || y > 7) return { value: 0 };
            const row = f.cells[y].split('');
            const text = str(args[2]);
            for (let i = 0; i < text.length && x + i < 21; i++) {
              if (x + i >= 0) row[x + i] = text[i];
            }
            f.cells[y] = row.join('');
            return { value: 0 };
          }
          case 'oledSetPixel': {
            const f = this.oledFrame();
            if (f) this.oledDot(f, num(args[0]), num(args[1]), args.length < 3 || num(args[2]) !== 0);
            return { value: 0 };
          }
          case 'oledLine': {
            // integer Bresenham, all eight octants
            const f = this.oledFrame();
            if (!f) return { value: 0 };
            const on = args.length < 5 || num(args[4]) !== 0;
            let x0 = num(args[0]);
            let y0 = num(args[1]);
            const x1 = num(args[2]);
            const y1 = num(args[3]);
            const dx = Math.abs(x1 - x0);
            const dy = -Math.abs(y1 - y0);
            const sx = x0 < x1 ? 1 : -1;
            const sy = y0 < y1 ? 1 : -1;
            let err = dx + dy; // Wikipedia's all-octant integer Bresenham
            for (;;) {
              this.oledDot(f, x0, y0, on);
              if (x0 === x1 && y0 === y1) break;
              const e2 = 2 * err;
              if (e2 >= dy) { err += dy; x0 += sx; }
              if (e2 <= dx) { err += dx; y0 += sy; }
            }
            return { value: 0 };
          }
          case 'oledRect': {
            const f = this.oledFrame();
            if (!f) return { value: 0 };
            const [x, y, w, h] = [num(args[0]), num(args[1]), num(args[2]), num(args[3])];
            const on = args.length < 5 || num(args[4]) !== 0;
            for (let i = 0; i < w; i++) {
              this.oledDot(f, x + i, y, on);
              this.oledDot(f, x + i, y + h - 1, on);
            }
            for (let j = 0; j < h; j++) {
              this.oledDot(f, x, y + j, on);
              this.oledDot(f, x + w - 1, y + j, on);
            }
            return { value: 0 };
          }
          case 'oledFillRect': {
            const f = this.oledFrame();
            if (!f) return { value: 0 };
            const [x, y, w, h] = [num(args[0]), num(args[1]), num(args[2]), num(args[3])];
            const on = args.length < 5 || num(args[4]) !== 0;
            for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.oledDot(f, x + i, y + j, on);
            return { value: 0 };
          }
          case 'oledShow': {
            // commit the back buffer; text cells stay immediate (legacy)
            const f = this.oledFrame();
            if (f) f.fb.set(f.draw);
            return { value: 0 };
          }
          case 'npSetup': {
            const g = num(args[0]);
            const comp = this.sensorAt('neopixel', g, 'din');
            if (!comp) return { value: 0 };
            // the strip is the hardware: its configured length wins. The
            // sketch count only says how far its shift register reaches;
            // pixels past it keep their (dark) state, writes past the
            // physical strip fall off the end of the line.
            const physical = Math.max(1, Math.min(64, Number(comp.params.count ?? 8) || 8));
            const count = Math.max(1, Math.min(64, num(args[1])));
            this.npStrips.set(g, {
              count, physical, pixels: Array.from({ length: physical }, () => 0),
            });
            return { value: 1 };
          }
          case 'npPixel': {
            const strip = this.npStrips.get(num(args[0]));
            const i = num(args[1]);
            if (!strip || i < 0 || i >= strip.count || i >= strip.pixels.length) return { value: 0 };
            const [r, g2, b] = [num(args[2]), num(args[3]), num(args[4])];
            strip.pixels[i] = ((r & 0xff) << 16) | ((g2 & 0xff) << 8) | (b & 0xff);
            return { value: 0 };
          }
          case 'npShow':
            return { value: 0 }; // colors land immediately; kept for API parity
          case 'delay':
            return { suspend: { kind: 'delay', us: Math.max(0, num(args[0]) * 1000) } };
          case 'delayMicroseconds':
            return { suspend: { kind: 'delay', us: Math.max(0, num(args[0])) } };
          case 'yield':
            return { suspend: { kind: 'delay', us: 0 } };

          case 'map': {
            const [v, ls, le, ts, te] = args.map((x) => num(x));
            return { value: Math.round(((v - ls) * (te - ts)) / (le - ls) + ts) };
          }
          case 'constrain': {
            const [v, lo, hi] = args.map((x) => num(x));
            return { value: Math.min(hi, Math.max(lo, v)) };
          }
          case 'abs': return { value: Math.abs(num(args[0])) };
          case 'min': return { value: Math.min(num(args[0]), num(args[1])) };
          case 'max': return { value: Math.max(num(args[0]), num(args[1])) };
          case 'sq': return { value: num(args[0]) ** 2 };
          case 'sqrt': return { value: Math.sqrt(num(args[0])), isFloat: true };
          case 'pow': return { value: Math.pow(num(args[0]), num(args[1])), isFloat: true };
          case 'sin': return { value: Math.sin(num(args[0])), isFloat: true };
          case 'cos': return { value: Math.cos(num(args[0])), isFloat: true };

          case 'timerAlarmWrite': {
            const which = num(args[0]);
            this.alarms.set(which, {
              periodUs: Math.max(1, num(args[1])), reload: !!args[2], task: null, armed: false,
            });
            return { value: 1 };
          }
          case 'timerAlarmEnable': {
            const which = num(args[0]);
            const a = this.alarms.get(which);
            if (a && !a.armed) {
              a.armed = true;
              const arm = (): void => {
                a.task = this.clock.setTimeout(a.periodUs, () => {
                  this.isrQueue.push(`timer${which}ISR`);
                  if (a.reload && a.armed) arm();
                  this.scheduleWake(0, true); // give the CPU a chance to run the ISR
                });
              };
              arm();
            }
            return { value: 1 };
          }
          case 'timerAlarmDisable': {
            const a = this.alarms.get(num(args[0]));
            if (a) {
              a.armed = false;
              if (a.task !== null) this.clock.clear(a.task);
              a.task = null;
            }
            return { value: 1 };
          }

          // ---- Serial ----
          case 'Serial.begin':
          case 'Serial.end':
          case 'Serial.flush':
            return { value: args.length ? 1 : 1 };
          case 'Serial.available': return { value: 0 };
          case 'Serial.read': return { value: -1 };
          case 'Serial.print':
            this.appendText(args.map(printValue).join(''));
            return { value: 0 };
          case 'Serial.println':
            if (args.length) this.appendText(args.map(printValue).join(''));
            this.appendText('\n');
            return { value: 0 };
          case 'Serial.write':
            this.appendText(args.map((a) => (typeof a === 'number' ? String.fromCharCode(a) : str(a))).join(''));
            return { value: 0 };
          case 'Serial.printf': {
            const [fmt, ...rest] = args;
            let i = 0;
            const text = str(fmt).replace(/%(-)?(\d+)?(?:\.(\d+))?([dsfxcb%])/g, (_all, _l, w, p, c) => {
              if (c === '%') return '%';
              const v = rest[i++];
              let s: string;
              if (c === 'd') s = String(Math.trunc(num(v)));
              else if (c === 'f') s = num(v).toFixed(p === undefined ? 6 : Number(p));
              else if (c === 'x') s = Math.trunc(num(v)).toString(16);
              else if (c === 'b') s = Math.trunc(num(v)).toString(2);
              else if (c === 'c') s = String.fromCharCode(num(v));
              else s = str(v);
              return w ? s.padStart(Number(w), ' ') : s;
            });
            this.appendText(text);
            return { value: text.length };
          }

          // ---- ESP. helpers ----
          case 'ESP.wdtFeed': case 'ESP.sleep':
            return { value: 0 };
          case 'ESP.restart':
            this.restartRequested = true;
            return { value: 0 };
          case 'ESP.getFreeHeap':
            return { value: 40_000 };

          // ---- inline `IPAddress(192, 168, 1, 60)` construction ----
          case 'IPAddress':
            return { value: `@IPAddress:${args.map((a) => num(a)).join(',')}` };

          // ---- P3.3 WiFi mock: globals ----
          case 'WiFi.mode': case 'WiFi.setSleep': case 'WiFi.persistent':
          case 'WiFi.setHostname': case 'WiFi.softAP':
          case 'WiFi.config': case 'WiFi.softAPConfig':
            return { value: 1 };
          case 'WiFi.isConnected': {
            const c = this.wifi.connectAt;
            return { value: c !== null && this.clock.now() >= c ? 1 : 0 };
          }
          case 'WiFi.reconnect':
            this.wifi.connectAt = this.clock.now() + 1_500_000;
            return { value: 0 }; // WL_DISCONNECTED while the join runs
          case 'WiFi.waitForConnectResult': {
            const c = this.wifi.connectAt;
            if (c === null) return { value: 6 }; // nobody ever began a join
            const wait = c - this.clock.now();
            return wait > 0
              ? { suspend: { kind: 'delay', us: wait }, value: 3 }
              : { value: 3 };
          }

          // ---- time & NTP (milestone 15) ----
          case 'configTime':
            this.ntp.gmtOff = num(args[0]);
            this.ntp.dstOff = args.length > 1 ? num(args[1]) : 0;
            if (this.ntp.syncAt === null) this.ntp.syncAt = this.clock.now() + 500_000;
            return { value: 0 };
          case 'setTimeZone':
            this.ntp.gmtOff = num(args[0]);
            if (args.length > 1) this.ntp.dstOff = num(args[1]);
            return { value: 0 };
          case 'time': case 'getEpochTime':
            return { value: this.ntpEpochSec() };
          case 'localTime':
            return { value: this.ntp.syncAt !== null ? this.ntpEpochSec() + this.ntp.gmtOff + this.ntp.dstOff : 0 };
          case 'getDaylightOffset':
            return { value: this.ntp.dstOff };
          case 'setSyncProvider': case 'setSyncInterval': case 'setSyncTickInterval':
            return { value: 0 };
          case 'setTime':
            this.timeLib = { base: args.length ? num(args[0]) : 0, setAt: this.clock.now() };
            return { value: 0 };
          case 'now':
            return { value: this.timeLib
              ? this.timeLib.base + Math.floor((this.clock.now() - this.timeLib.setAt) / 1_000_000)
              : this.ntpEpochSec() };
          case 'hour': case 'minute': case 'second': case 'day': case 'month':
          case 'year': case 'weekday': case 'dayOfWeek': case 'dayOfYear':
          case 'isPm': case 'isLeapYear': {
            const t = args.length
              ? num(args[0])
              : this.timeLib
                ? this.timeLib.base + Math.floor((this.clock.now() - this.timeLib.setAt) / 1_000_000)
                : this.ntpEpochSec();
            const d = new Date(t * 1000);
            switch (name) {
              case 'hour': return { value: Math.floor(t / 3600) % 24 };
              case 'minute': return { value: Math.floor(t / 60) % 60 };
              case 'second': return { value: t % 60 };
              case 'day': case 'dayOfWeek': return { value: d.getUTCDate() };
              case 'weekday': return { value: d.getUTCDay() === 0 ? 1 : d.getUTCDay() + 1 }; // TimeLib: Sunday = 1
              case 'month': return { value: d.getUTCMonth() + 1 };
              case 'year': return { value: d.getUTCFullYear() };
              case 'dayOfYear': return { value: Math.floor(t / 86400) % 366 + 1 };
              case 'isPm': return { value: (Math.floor(t / 3600) % 24 + 11) % 12 + 1 };
              default: return { value: (d.getUTCFullYear() % 4 === 0 && d.getUTCFullYear() % 100 !== 0) || d.getUTCFullYear() % 400 === 0 ? 1 : 0 };
            }
          }

          // ---- mDNS + OTA: accepted, not simulated (milestone 12) ----
          case 'MDNS.begin': {
            const name = typeof args[0] === 'string' ? args[0] : '';
            if (name) {
              lan.registerName(name, this.ip);
              this.mdnsNames.add(name.toLowerCase());
            }
            return { value: 1 };
          }
          case 'MDNS.addService': case 'MDNS.setHostname':
            return { value: 1 };
          case 'ArduinoOTA.onStart': case 'ArduinoOTA.onEnd':
          case 'ArduinoOTA.onProgress': case 'ArduinoOTA.onError':
          case 'ArduinoOTA.begin': case 'ArduinoOTA.handle':
          case 'ArduinoOTA.setHostname': case 'ArduinoOTA.setPassword':
            return { value: 0 };
          case 'WiFi.begin':
            this.wifi.connectAt = this.clock.now() + 1_500_000; // association latency
            return { value: 1 };
          case 'WiFi.disconnect':
            this.wifi.connectAt = null;
            return { value: 1 };
          case 'WiFi.status': {
            const c = this.wifi.connectAt;
            return { value: c !== null && this.clock.now() >= c ? 3 /* WL_CONNECTED */ : 6 };
          }
          case 'WiFi.localIP':
            return { value: this.wifi.connectAt !== null && this.clock.now() >= this.wifi.connectAt ? this.ip : '0.0.0.0' };
          case 'WiFi.softAPIP': return { value: '192.168.4.1' };
          case 'WiFi.macAddress': return { value: '18:fe:20:1c:b4:3a' };
          case 'WiFi.RSSI': return { value: -55 };
          case 'WiFi.hostname': return { value: 'esp8266' };
          case 'WiFiClient': case 'WiFiUDP': return { value: 0 };
          case 'WiFiServer': return { value: args.length ? num(args[0]) : 80 };

          default: {
            if (name.startsWith('EEPROM.')) return this.eepromCall(name.slice(7), args);
            const dot = name.indexOf('.');
            const obj = dot > 0 ? this.wifi.objs.get(name.slice(0, dot)) : undefined;
            if (obj) {
              const meth = name.slice(dot + 1);
              if (obj.kind === 'Adafruit_NeoPixel') return this.npCall(obj, meth, args);
              if (obj.kind === 'IPAddress') return this.ipCall(obj, meth, args);
              if (obj.kind === 'ESP8266WebServer') return this.webCall(obj, meth, args);
              if (obj.kind === 'HTTPClient') return this.httpCall(obj, meth, args);
              return this.wifiCall(obj, meth, args);
            }
            throw new Error(`function '${name}' is not implemented on the emulated ESP8266`);
          }
        }
      },
      objectDecl: (name: string, type: string, args: number[]) => {
        // all library objects share one registry; F4/F5 hang per-type state
        // off `args` (NeoPixel count/pin, WebServer port, IPAddress octets)
        const port = args.length ? args[0] : type === 'WiFiServer' || type === 'ESP8266WebServer' ? 80 : 0;
        this.wifi.objs.set(name, { kind: type as never, port, peer: null, listening: false, args });
      },
    };
  }

  /** Append to the pending line; embedded newlines flush whole lines. */
  private appendText(s: string): void {
    let rest = s;
    for (;;) {
      const nl = rest.indexOf('\n');
      if (nl < 0) {
        this.printBuf += rest;
        return;
      }
      this.printBuf += rest.slice(0, nl);
      this.flushLine();
      rest = rest.slice(nl + 1);
    }
  }

  private flushLine(): void {
    const line: SerialLine = { id: ++this.lineSeq, tMs: this.timeMs(), text: this.printBuf };
    this.printBuf = '';
    this.serialLog.push(line);
    if (this.serialLog.length > MAX_SERIAL_LINES) {
      this.serialLog.shift(); // drop-oldest keeps the tail + timestamps honest
      this.droppedLines++;
    }
    for (const cb of this.serialListeners) cb(line);
  }

}

// ---------- helpers ----------

function printValue(v: HostValue | undefined): string {
  if (v === undefined) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(roundFloat(v));
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? '1' : '0';
  return `[${v.map(printValue).join(',')}]`;
}

function roundFloat(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

