/**
 * ESP8266 GPIO register file (GPIO0..GPIO15 block).
 *
 * Models the write-1-to-set / write-1-to-clear register trio the real chip uses,
 * so sketches or register-level code drive virtual pins the same way they would
 * drive hardware. GPIO16 sits in a separate block on real silicon; the machine
 * handles that pin outside this file.
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
    const v = value & MASK16;
    switch (addr) {
      case GPIO_OUT:
        this.setOut(v);
        break;
      case GPIO_OUT_W1TS:
        this.setOut((this.out | v) & MASK16);
        break;
      case GPIO_OUT_W1TC:
        this.setOut(this.out & ~v & MASK16);
        break;
      case GPIO_ENABLE:
        this.setEnable(v);
        break;
      case GPIO_ENABLE_W1TS:
        this.setEnable((this.enable | v) & MASK16);
        break;
      case GPIO_ENABLE_W1TC:
        this.setEnable(this.enable & ~v & MASK16);
        break;
      default:
        throw new Error(`unknown GPIO register address 0x${addr.toString(16)}`);
    }
  }

  read(addr: number): number {
    switch (addr) {
      case GPIO_OUT:
        return this.out;
      case GPIO_ENABLE:
        return this.enable;
      case GPIO_IN:
        return this.sampleInputs(MASK16) & MASK16;
      default:
        throw new Error(`unknown GPIO register address 0x${addr.toString(16)}`);
    }
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
