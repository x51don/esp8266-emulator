#!/usr/bin/env node
/**
 * examples/ holds COPIES of firmware that is maintained outside this repo
 * (the production sketches live next to their own project). A copy goes stale
 * silently and the suite then tests firmware nobody ships.
 *
 * examples/sync-manifest.json is the contract:
 *   { "<copy name>": { "source": "<path relative to repo root>",
 *                       "sha256": "<hash of the source at the last sync>" } }
 *
 *   node scripts/sync-examples.mjs           copy every stale file in
 *   node scripts/sync-examples.mjs --check   verify, exit 1, print the fix
 *
 * --check is what tests/examples-sync.test.ts asserts on. It never writes.
 * A source that is not on this machine (a checkout without the sibling
 * project) is reported as skipped, never as a failure - but a copy whose hash
 * differs from the manifest hash is always a failure, source or no source.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export function readManifest(root = ROOT) {
  return JSON.parse(readFileSync(resolve(root, 'examples/sync-manifest.json'), 'utf8'));
}

/** One record per manifest entry: what matched and what did not. */
export function inspect(root = ROOT) {
  const rows = [];
  for (const [name, entry] of Object.entries(readManifest(root))) {
    const copyPath = resolve(root, 'examples', name);
    const sourcePath = resolve(root, entry.source);
    const row = {
      name,
      source: entry.source,
      sourcePath,
      copyPath,
      manifestSha: entry.sha256,
      copySha: existsSync(copyPath) ? sha256(readFileSync(copyPath)) : null,
      sourceSha: existsSync(sourcePath) ? sha256(readFileSync(sourcePath)) : null,
    };
    row.copyMissing = row.copySha === null;
    row.sourceMissing = row.sourceSha === null;
    // the copy must be what the manifest says it is, on every machine
    row.copyDrift = !row.copyMissing && row.copySha !== row.manifestSha;
    // and the manifest must describe the current source, where we can see it
    row.stale = !row.sourceMissing && !row.copyDrift && row.sourceSha !== row.manifestSha;
    row.ok = !row.copyMissing && !row.copyDrift && !row.stale;
    rows.push(row);
  }
  return rows;
}

/** Copy every stale entry and rewrite its hash in the manifest. */
export function sync(root = ROOT) {
  const manifestPath = resolve(root, 'examples/sync-manifest.json');
  const manifest = readManifest(root);
  const done = [];
  for (const row of inspect(root)) {
    if (row.sourceMissing) continue;
    if (row.ok) continue;
    writeFileSync(row.copyPath, readFileSync(row.sourcePath));
    manifest[row.name].sha256 = row.sourceSha;
    done.push(row.name);
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return done;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const rows = inspect();
  let bad = 0;
  for (const row of rows) {
    if (row.sourceMissing) {
      console.log(`skip   ${row.name} - source not present: ${row.source}`);
      continue;
    }
    if (row.ok) {
      console.log(`ok     ${row.name}`);
      continue;
    }
    bad++;
    console.log(
      row.copyMissing
        ? `MISSING ${row.name} - examples/${row.name} does not exist`
        : row.copyDrift
          ? `DRIFT   ${row.name} - examples/${row.name} was edited by hand; the source of truth is ${row.source}`
          : `STALE   ${row.name} - ${row.source} changed since the last sync`,
    );
  }
  if (check) {
    if (bad) {
      console.error(`\n${bad} example(s) out of sync. Run: npm run sync:examples`);
      process.exit(1);
    }
    process.exit(0);
  }
  const done = sync();
  console.log(done.length ? `synced: ${done.join(', ')}` : 'already in sync');
}
