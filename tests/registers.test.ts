import { describe, it, expect, vi } from 'vitest';
import { GpioRegisters, GPIO_ENABLE, GPIO_ENABLE_W1TS, GPIO_ENABLE_W1TC, GPIO_OUT, GPIO_OUT_W1TS, GPIO_OUT_W1TC, GPIO_IN } from '../core/registers';

// Models the ESP8266 GPIO register file (GPIO0..GPIO15 half; GPIO16 lives in a
// separate block on real silicon and is handled by the machine). Addresses match
// the ESP8266 Technical Reference / esp8266 Arduino core headers.

describe('GpioRegisters - addresses', () => {
  it('exposes the documented peripheral addresses', () => {
    expect(GPIO_ENABLE).toBe(0x60000300);
    expect(GPIO_OUT_W1TS).toBe(0x60000304);
    expect(GPIO_ENABLE_W1TS).toBe(0x60000308);
    expect(GPIO_OUT_W1TC).toBe(0x6000030c);
    expect(GPIO_ENABLE_W1TC).toBe(0x60000310);
    expect(GPIO_IN).toBe(0x3ff00018);
    expect(GPIO_OUT).toBe(0x600003fc);
  });
});

describe('GpioRegisters - OUT and ENABLE', () => {
  it('starts with all outputs low and disabled', () => {
    const r = new GpioRegisters();
    expect(r.read(GPIO_OUT)).toBe(0);
    expect(r.read(GPIO_ENABLE)).toBe(0);
  });

  it('writes the full OUT register (16-bit mask)', () => {
    const r = new GpioRegisters();
    r.write(GPIO_OUT, 0b1011);
    expect(r.read(GPIO_OUT)).toBe(0b1011);
    r.write(GPIO_OUT, 0xffffffff); // bits above 15 are dropped
    expect(r.read(GPIO_OUT)).toBe(0xffff);
  });

  it('W1TS sets only the written bits', () => {
    const r = new GpioRegisters();
    r.write(GPIO_OUT, 0b0011);
    r.write(GPIO_OUT_W1TS, 0b0100);
    expect(r.read(GPIO_OUT)).toBe(0b0111);
  });

  it('W1TC clears only the written bits', () => {
    const r = new GpioRegisters();
    r.write(GPIO_OUT, 0b1111);
    r.write(GPIO_OUT_W1TC, 0b0110);
    expect(r.read(GPIO_OUT)).toBe(0b1001);
  });

  it('ENABLE supports the same write semantics as OUT', () => {
    const r = new GpioRegisters();
    r.write(GPIO_ENABLE, 0b1);
    r.write(GPIO_ENABLE_W1TS, 0b10);
    expect(r.read(GPIO_ENABLE)).toBe(0b11);
    r.write(GPIO_ENABLE_W1TC, 0b1);
    expect(r.read(GPIO_ENABLE)).toBe(0b10);
  });

  it('writing non-GPIO addresses throws', () => {
    const r = new GpioRegisters();
    expect(() => r.write(0x60000000, 1)).toThrow(/unknown register/i);
    expect(() => r.read(0x60000000)).toThrow(/unknown register/i);
  });
});

describe('GpioRegisters - IN sampling', () => {
  it('reads IN through the injected sampler', () => {
    const sampler = vi.fn((mask: number) => (mask & 0b1010) !== 0 ? 0b1010 : 0);
    const r = new GpioRegisters(sampler);
    expect(r.read(GPIO_IN)).toBe(0b1010);
    expect(sampler).toHaveBeenCalledWith(0xffff);
  });

  it('defaults IN to low without a sampler', () => {
    const r = new GpioRegisters();
    expect(r.read(GPIO_IN)).toBe(0);
  });
});

describe('GpioRegisters - change notification', () => {
  it('reports changed output bits on change', () => {
    const r = new GpioRegisters();
    const changes: number[] = [];
    r.onOutChange((changedMask) => changes.push(changedMask));
    r.write(GPIO_OUT_W1TS, 0b0101);
    expect(changes).toEqual([0b0101]);
    r.write(GPIO_OUT_W1TS, 0b0101); // no actual change -> no event
    expect(changes).toEqual([0b0101]);
  });

  it('reports changed enable bits on change', () => {
    const r = new GpioRegisters();
    const changes: number[] = [];
    r.onEnableChange((changedMask) => changes.push(changedMask));
    r.write(GPIO_ENABLE, 0b11);
    expect(changes).toEqual([0b11]);
  });

  it('reset() zeroes registers and reports the diff', () => {
    const r = new GpioRegisters();
    r.write(GPIO_OUT, 0b110);
    r.write(GPIO_ENABLE, 0b110);
    const out: number[] = [];
    const en: number[] = [];
    r.onOutChange((m) => out.push(m));
    r.onEnableChange((m) => en.push(m));
    r.reset();
    expect(r.read(GPIO_OUT)).toBe(0);
    expect(r.read(GPIO_ENABLE)).toBe(0);
    expect(out).toEqual([0b110]);
    expect(en).toEqual([0b110]);
  });
});
