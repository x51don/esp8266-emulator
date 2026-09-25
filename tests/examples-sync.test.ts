/**
 * Fix 1: examples/ keeps COPIES of firmware that is maintained in the Rolety
 * project. A copy that quietly goes stale turns the whole roleta suite green
 * against firmware nobody ships - which is exactly what happened to v20 (the
 * copy predated the pump()/reconnect fixes).
 *
 * The contract is examples/sync-manifest.json, maintained by
 * `npm run sync:examples`. These tests are the guard.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { inspect, sync } from '../scripts/sync-examples.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIX = 'Run: npm run sync:examples';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('example sketches are copies of the production firmware (F1)', () => {
  const rows = inspect(ROOT);

  it('the manifest lists the firmware copies and every copy exists', () => {
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.copyMissing, `examples/${row.name} is missing. ${FIX}`).toBe(false);
    }
  });

  it('no copy was edited by hand - the source of truth is the firmware file', () => {
    for (const row of rows) {
      expect(
        row.copyDrift,
        `examples/${row.name} differs from the hash recorded in examples/sync-manifest.json, `
        + `so it was edited here instead of in ${row.source}. ${FIX}`,
      ).toBe(false);
    }
  });

  it('no production sketch changed since the last sync', () => {
    const visible = rows.filter((r) => !r.sourceMissing);
    // A checkout without the sibling Rolety project cannot check this; the
    // manifest-hash guard above still holds there.
    if (!visible.length) return;
    for (const row of visible) {
      expect(
        row.stale,
        `${row.source} changed since examples/${row.name} was copied - the suite would be `
        + `testing stale firmware. ${FIX}`,
      ).toBe(false);
    }
  });

  it('every synced example is actually consumed by a test or the GUI', () => {
    // An example nobody imports cannot fail: syncing it would be theatre.
    const consumers = ['tests', 'gui']
      .flatMap((dir) =>
        readdirSync(join(ROOT, dir), { recursive: true })
          .map((p) => String(p))
          .filter((p) => /\.tsx?$/.test(p))
          .map((p) => readFileSync(join(ROOT, dir, p), 'utf8')),
      )
      .join('\n');
    for (const row of rows) {
      expect(consumers, `${row.name} is imported nowhere - it is dead weight`).toContain(
        `examples/${row.name}?raw`,
      );
    }
  });
});

describe('the sync guard itself (F1)', () => {
  /** A throwaway checkout: <tmp>/proj/examples/a.ino copies <tmp>/firmware/a.ino. */
  function fixture(sourceText: string, copyText: string): string {
    const tmp = mkdtempSync(join(tmpdir(), 'esp-sync-'));
    const root = join(tmp, 'proj');
    mkdirSync(join(root, 'examples'), { recursive: true });
    mkdirSync(join(tmp, 'firmware'), { recursive: true });
    writeFileSync(join(tmp, 'firmware/a.ino'), sourceText);
    writeFileSync(join(root, 'examples/a.ino'), copyText);
    writeFileSync(
      join(root, 'examples/sync-manifest.json'),
      JSON.stringify({ 'a.ino': { source: '../firmware/a.ino', sha256: sha(sourceText) } }),
    );
    return root;
  }

  it('a word changed in the source without a sync is stale, and sync() fixes it', () => {
    const root = fixture('void setup() { }\n', 'void setup() { }\n');
    expect(inspect(root)[0].ok).toBe(true);

    // one word in the production sketch, no sync
    writeFileSync(join(root, '..', 'firmware/a.ino'), 'void setup() { delay(1); }\n');
    const stale = inspect(root)[0];
    expect(stale.stale).toBe(true);
    expect(stale.ok).toBe(false);

    expect(sync(root)).toEqual(['a.ino']);
    const after = inspect(root)[0];
    expect(after.ok).toBe(true);
    expect(readFileSync(join(root, 'examples/a.ino'), 'utf8')).toContain('delay(1)');
  });

  it('a hand-edited copy is reported as drift, not as up to date', () => {
    const root = fixture('void setup() { }\n', 'void setup() { }\n');
    writeFileSync(join(root, 'examples/a.ino'), 'void setup() { hacked(); }\n');
    const row = inspect(root)[0];
    expect(row.copyDrift).toBe(true);
    expect(row.ok).toBe(false);
    // sync overwrites the local edit with the firmware file
    expect(sync(root)).toEqual(['a.ino']);
    expect(readFileSync(join(root, 'examples/a.ino'), 'utf8')).toBe('void setup() { }\n');
  });

  it('a missing source is skipped, never silently trusted', () => {
    const root = fixture('void setup() { }\n', 'void setup() { }\n');
    // simulate the sibling project being absent on this machine
    writeFileSync(
      join(root, 'examples/sync-manifest.json'),
      JSON.stringify({ 'a.ino': { source: '../firmware/nope.ino', sha256: sha('void setup() { }\n') } }),
    );
    const row = inspect(root)[0];
    expect(row.sourceMissing).toBe(true);
    expect(row.ok).toBe(true); // the copy still matches what the manifest recorded
    expect(sync(root)).toEqual([]);
  });
});
