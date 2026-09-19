/**
 * F13: opening and saving the sketch as a plain .ino file.
 * The pure helpers here decide the download name; the GUI wiring (file
 * input + blob download) is verified by the browser E2E.
 */
import { describe, it, expect } from 'vitest';
import { inoFileName } from '../gui/fileio';

describe('ino file helpers (F13)', () => {
  it('sanitizes a project/device name into a safe .ino name', () => {
    expect(inoFileName('roller-shutter')).toBe('roller-shutter.ino');
    expect(inoFileName('Moja Skica 2')).toBe('Moja_Skica_2.ino');
  });

  it('strips characters the filesystems dislike, keeps letters/digits/_/-', () => {
    expect(inoFileName('a/b:c*?<>|d')).toBe('a_b_c_d.ino');
    expect(inoFileName('żółw')).toBe('w.ino'); // non-ASCII folds away, edge underscores trim
  });

  it('never yields an empty stem and caps the length', () => {
    expect(inoFileName('')).toBe('sketch.ino');
    expect(inoFileName('!!!')).toBe('sketch.ino');
    expect(inoFileName('x'.repeat(100)).length).toBeLessThanOrEqual(44); // 40-char stem + .ino
  });

  it('must start with a letter or underscore (Arduino id rule)', () => {
    expect(inoFileName('2x40')).toBe('_2x40.ino');
    expect(inoFileName('_ok')).toBe('ok.ino'); // edge underscores trim; still a valid name
  });
});
