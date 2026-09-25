export interface SyncRow {
  name: string;
  source: string;
  sourcePath: string;
  copyPath: string;
  manifestSha: string;
  copySha: string | null;
  sourceSha: string | null;
  copyMissing: boolean;
  sourceMissing: boolean;
  copyDrift: boolean;
  stale: boolean;
  ok: boolean;
}

export interface ManifestEntry {
  source: string;
  sha256: string;
}

export function readManifest(root?: string): Record<string, ManifestEntry>;
export function inspect(root?: string): SyncRow[];
export function sync(root?: string): string[];
