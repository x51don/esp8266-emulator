import { describe, expect, it, vi } from 'vitest';
import { resolveBoardId } from '../gui/App';

describe('boot-time board id (P0.4)', () => {
  it('keeps a known board id', () => {
    expect(resolveBoardId('nodemcu-v3')).toBe('nodemcu-v3');
  });

  it('falls back to wemos for unknown or missing ids', () => {
    expect(resolveBoardId(null)).toBe('wemos-d1-mini');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveBoardId('esp32-devkit')).toBe('wemos-d1-mini');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
