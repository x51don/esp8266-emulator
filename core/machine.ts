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
  GpioRegisters, GPIO_OUT, GPIO_OUT_W1TS, GPIO_OUT_W1TC, GPIO_ENABLE_W1TS, GPIO_ENABLE_W1TC,
} from './registers';
import { GpioBus, PIN_INPUT, PIN_OUTPUT, PIN_INPUT_PULLUP } from '../peripherals/gpio';
import { Netlist, type ResolveResult } from '../peripherals/netlist';
import { Interpreter, type SketchGen, type HostResult, type HostValue } from './sketch/interp';
import { parse } from './sketch/parser';
import { getBoard } from './boards';

export interface SerialLine {
  tMs: number;
  text: string;
}

export type MachinePhase = 'loaded' | 'running' | 'stopped';

interface Alarm {
  periodUs: number;
  reload: boolean;
  task: TimerId | null;
  armed: boolean;
}

const PUMP_SLICE = 5000; // tick yields before the CPU hands the world a turn

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
  private lastCircuit: ResolveResult | null = null;
  private servos = new Map<number, number>(); // gpio -> angle (degrees)
  private oleds = new Map<string, { cells: string[] }>(); // compId -> 8x21 grid
  private oledBound: string | null = null;
  private npStrips = new Map<number, { count: number; pixels: number[] }>();

  private serialLog: SerialLine[] = [];
  private serialListeners: Array<(line: SerialLine) => void> = [];
  private printBuf = '';
  private circuitListeners: Array<(r: ResolveResult) => void> = [];

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

  onSerial(cb: (line: SerialLine) => void): void {
    this.serialListeners.push(cb);
  }

  onCircuit(cb: (r: ResolveResult) => void): void {
    this.circuitListeners.push(cb);
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
    this.interp = new Interpreter(parse(this.source), this.env());
    this.machinePhase = 'running';
    this.mainGen = this.interp.setup();
    this.mainSuspended = false;
    this.scheduleWake(0, false);
    this.clock.advance(10); // setup() completes synchronously inside run()
  }

  stop(): void {
    this.halt();
    this.machinePhase = 'stopped';
  }

  reset(): void {
    this.servos.clear();
    this.oleds.clear();
    this.oledBound = null;
    this.npStrips.clear();
    this.halt();
    this.clock.restart();
    this.gpio.reset();
    this.serialLog = [];
    this.machinePhase = 'loaded';
    this.resolveCircuit();
  }

  /** Advance virtual time by `ms` milliseconds and re-resolve the circuit. */
  advance(ms: number): void {
    this.clock.advance(ms * 1000);
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

  press(switchId: string, closed: boolean): void {
    this.netlist.setSwitchState(switchId, closed);
    this.resolveCircuit();
  }

  // ---------- circuit <-> pins ----------

  private resolveCircuit(): void {
    const r = this.netlist.resolve();
    // Feed OTHER drivers (buttons, rails, foreign outputs) back into the bus
    // so digitalRead() sees them; a pin never drives itself through this path.
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
    const out = this.registers.read(GPIO_OUT);
    for (let g = 0; g < 17; g++) {
      if (mask & (1 << g)) this.gpio.write(g, ((out >> g) & 1) as 0 | 1);
    }
  }

  /** Text frames of every OLED bound so far (8 rows x 21 chars). */
  oledFrames(): ReadonlyMap<string, { cells: string[] }> {
    return this.oleds;
  }

  /** NeoPixel strips per data gpio: 0xRRGGBB per led. */
  strips(): ReadonlyMap<number, { count: number; pixels: number[] }> {
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
              this.oleds.set(panel.id, { cells: Array.from({ length: 8 }, () => ' '.repeat(21)) });
            }
            return { value: 1 };
          }
          case 'oledClear': {
            const f = this.oledBound && this.oleds.get(this.oledBound);
            if (f) f.cells = Array.from({ length: 8 }, () => ' '.repeat(21));
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
          case 'oledShow':
            return { value: 0 }; // immediate model: prints land on the panel
          case 'npSetup': {
            const g = num(args[0]);
            if (!this.sensorAt('neopixel', g, 'din')) return { value: 0 };
            const count = Math.max(1, Math.min(64, num(args[1])));
            this.npStrips.set(g, { count, pixels: Array.from({ length: count }, () => 0) });
            return { value: 1 };
          }
          case 'npPixel': {
            const strip = this.npStrips.get(num(args[0]));
            const i = num(args[1]);
            if (!strip || i < 0 || i >= strip.count) return { value: 0 };
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

          default:
            throw new Error(`function '${name}' is not implemented on the emulated ESP8266`);
        }
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
    const line: SerialLine = { tMs: this.timeMs(), text: this.printBuf };
    this.printBuf = '';
    this.serialLog.push(line);
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

