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

export class Esp8266Machine {
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
    objs: new Map<string, { kind: 'WiFiClient' | 'WiFiServer' | 'WiFiUDP'; port: number; peer: string | null; listening: boolean }>(),
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
  /** -1 = unlimited; otherwise remaining interpreter yields for this advance. */
  private yieldBudget = -1;

  constructor(opts: { board: string }) {
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
    this.halt();
    this.clock.restart();
    this.registers.reset();
    this.gpio.reset();
    this.serialLog = [];
    this.alarms.clear();
    this.wifi.connectAt = null;
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

          // ---- P3.3 WiFi mock: globals ----
          case 'WiFi.mode': case 'WiFi.setSleep': case 'WiFi.persistent':
          case 'WiFi.setHostname': case 'WiFi.softAP':
            return { value: 1 };
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
            return { value: this.wifi.connectAt !== null && this.clock.now() >= this.wifi.connectAt ? '192.168.1.42' : '0.0.0.0' };
          case 'WiFi.softAPIP': return { value: '192.168.4.1' };
          case 'WiFi.macAddress': return { value: '18:fe:20:1c:b4:3a' };
          case 'WiFi.RSSI': return { value: -55 };
          case 'WiFi.hostname': return { value: 'esp8266' };
          case 'WiFiClient': case 'WiFiUDP': return { value: 0 };
          case 'WiFiServer': return { value: args.length ? num(args[0]) : 80 };

          default: {
            const obj = name.includes('.') ? this.wifi.objs.get(name.slice(0, name.indexOf('.'))) : undefined;
            if (obj) return this.wifiCall(obj, name.slice(name.indexOf('.') + 1), args);
            throw new Error(`function '${name}' is not implemented on the emulated ESP8266`);
          }
        }
      },
      objectDecl: (name: string, type: string, port: number) => {
        if (type === 'WiFiClient' || type === 'WiFiServer' || type === 'WiFiUDP')
          this.wifi.objs.set(name, { kind: type, port, peer: null, listening: false });
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

