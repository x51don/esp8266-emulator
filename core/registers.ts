/**
 * ESP8266 GPIO register file.
 *
 * Models the write-1-to-set / write-1-to-clear register trio the real chip uses,
 * so sketches or register-level code drive virtual pins the same way they would
 * drive hardware. GPIO16 lives in a separate (RTC) block on real silicon and
 * never appears in the 16-bit GPIO_OUT/ENABLE *read* registers; the block keeps
 * it as an internal 17th bit so the whole machine can mirror one logical state
 * (`outState()`/`enableState()` include it, `read()` of the 16-bit registers
 * does not). The machine consumes bit 16 through its change listeners.
 *
 * Addresses come from the ESP8266 Technical Reference (as used by the
 * esp8266 Arduino core headers).
 */

export const GPIO_ENABLE = 0x60000300;
export const GPIO_OUT_W1TS = 0x60000304;
export const GPIO_ENABLE_W1TS = 0x60000308;
export const GPIO_OUT_W1TC = 0x6000030c;
export const GPIO_ENABLE_W1TC = 0x60000310;
export const GPIO_IN = 0x3ff00018;
export const GPIO_OUT = 0x600003fc;

const MASK16 = 0xffff;
/** Logical view: 16-bit GPIO block plus the GPIO16 (RTC) block as bit 16. */
const MASK17 = 0x1ffff;

export type InputSampler = (mask: number) => number;
export type ChangeListener = (changedMask: number) => void;

export class GpioRegisters {
  private out = 0;
  private enable = 0;

  private outListeners: ChangeListener[] = [];
  private enableListeners: ChangeListener[] = [];

  constructor(private readonly sampleInputs: InputSampler = () => 0) {}

  onOutChange(listener: ChangeListener): void {
    this.outListeners.push(listener);
  }

  onEnableChange(listener: ChangeListener): void {
    this.enableListeners.push(listener);
  }

  write(addr: number, value: number): void {
    const v = value & MASK17;
    switch (addr) {
      case GPIO_OUT:
        this.setOut((this.out & ~MASK16) | (v & MASK16));
        break;
      case GPIO_OUT_W1TS:
        this.setOut((this.out | v) & MASK17);
        break;
      case GPIO_OUT_W1TC:
        this.setOut(this.out & ~v & MASK17);
        break;
      case GPIO_ENABLE:
        this.setEnable((this.enable & ~MASK16) | (v & MASK16));
        break;
      case GPIO_ENABLE_W1TS:
        this.setEnable((this.enable | v) & MASK17);
        break;
      case GPIO_ENABLE_W1TC:
        this.setEnable(this.enable & ~v & MASK17);
        break;
      default:
        throw new Error(`unknown GPIO register address 0x${addr.toString(16)}`);
    }
  }

  read(addr: number): number {
    switch (addr) {
      case GPIO_OUT:
        return this.out & MASK16;
      case GPIO_ENABLE:
        return this.enable & MASK16;
      case GPIO_IN:
        return this.sampleInputs(MASK17) & MASK17;
      default:
        throw new Error(`unknown GPIO register address 0x${addr.toString(16)}`);
    }
  }

  /** Full 17-bit logical output state (GPIO0..15 register block + GPIO16). */
  outState(): number {
    return this.out & MASK17;
  }

  /** Full 17-bit logical output-enable state. */
  enableState(): number {
    return this.enable & MASK17;
  }

  reset(): void {
    this.setOut(0);
    this.setEnable(0);
  }

  private setOut(value: number): void {
    const changed = this.out ^ value;
    this.out = value;
    if (changed !== 0) for (const l of this.outListeners) l(changed);
  }

  private setEnable(value: number): void {
    const changed = this.enable ^ value;
    this.enable = value;
    if (changed !== 0) for (const l of this.enableListeners) l(changed);
  }
}
