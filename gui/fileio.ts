/**
 * F13: open/save the sketch as a plain .ino file.
 *
 * The pure name sanitizer decides what the downloaded file is called; the
 * DOM helpers are the thin browser side (blob download, file pick). Arduino
 * sketch names must be identifiers, so anything outside [A-Za-z0-9_-] is
 * folded to '_' and a digit-initial stem gets a '_' guard.
 */

/** Project/device/file label -> safe `name.ino` (non-empty, <= 41 chars). */
export function inoFileName(label: string): string {
  let stem = label
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  if (/^[0-9]/.test(stem)) stem = `_${stem}`;
  if (!stem) stem = 'sketch';
  return `${stem}.ino`;
}

/** Trigger a browser download of text as a file. */
export function downloadText(name: string, text: string, mime = 'text/plain'): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = name;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
