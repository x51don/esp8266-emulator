import { describe, it, expect } from 'vitest';
import { version } from '../core/version';

// Smoke test: verifies the toolchain (TS + vitest) resolves modules across dirs.
describe('toolchain', () => {
  it('exports a version string from core', () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
