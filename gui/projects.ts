/**
 * Named projects: save / list / load / export / import of a whole document
 * (sketch + schematic + board). Storage is injected so the logic runs in
 * plain node tests; the app passes window.localStorage.
 */

export interface ProjectData {
  name: string;
  sketch: string;
  schematic: string; // Schematic.toJSON() text
  board: string;
  eeprom?: string; // base64 of the 4096-byte flash sector (F6)
  /** F11: the rest of the LAN bench; index 0 is the primary device
   *  (whose sketch/eeprom also live in the top-level fields). */
  devices?: DeviceData[];
}

export interface DeviceData {
  name: string;
  sketch: string;
  eeprom?: string;
}

export function eepromToB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 1024) {
    s += String.fromCharCode(...bytes.subarray(i, i + 1024));
  }
  return btoa(s);
}

/** undefined / corrupt base64 -> an unprogrammed chip (all 0xFF) */
export function eepromFromB64(b64: string | undefined): Uint8Array {
  const out = new Uint8Array(4096).fill(0xff);
  if (!b64) return out;
  try {
    const d = atob(b64);
    for (let i = 0; i < Math.min(d.length, 4096); i++) out[i] = d.charCodeAt(i);
  } catch {
    /* keep the erased chip */
  }
  return out;
}

const PREFIX = 'esp8266-emu.project.';
const LIST_KEY = 'esp8266-emu.projects';

interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

export class ProjectStore {
  constructor(private ls: StorageLike) {}

  list(): string[] {
    try {
      const names = JSON.parse(this.ls.getItem(LIST_KEY) ?? '[]') as string[];
      return Array.from(new Set(names)).sort();
    } catch {
      return [];
    }
  }

  save(p: ProjectData): void {
    this.ls.setItem(PREFIX + p.name, JSON.stringify(p));
    const names = this.list();
    if (!names.includes(p.name)) {
      names.push(p.name);
      this.ls.setItem(LIST_KEY, JSON.stringify(names.sort()));
    }
  }

  load(name: string): ProjectData | null {
    const raw = this.ls.getItem(PREFIX + name);
    if (!raw) return null;
    try {
      const p = JSON.parse(raw) as ProjectData;
      return valid(p) ? sanitize({ ...p, name }) : null;
    } catch {
      return null;
    }
  }

  remove(name: string): void {
    this.ls.removeItem(PREFIX + name);
    this.ls.setItem(LIST_KEY, JSON.stringify(this.list().filter((n) => n !== name)));
  }

  exportJson(p: ProjectData): string {
    return JSON.stringify(p, null, 2);
  }

  parseImport(text: string): ProjectData {
    let p: ProjectData;
    try {
      p = JSON.parse(text) as ProjectData;
    } catch {
      throw new Error('not a JSON file');
    }
    if (!valid(p)) throw new Error('not an ESP8266-emu project file');
    return sanitize(p);
  }
}

/** F11: drop hand-edited junk out of the devices array */
function sanitize(p: ProjectData): ProjectData {
  if (p.devices === undefined) return p;
  if (!Array.isArray(p.devices)) {
    const { devices, ...rest } = p;
    return rest as ProjectData;
  }
  const ok = (p.devices as unknown[]).filter(
    (d): d is DeviceData =>
      !!d && typeof d === 'object' && typeof (d as DeviceData).sketch === 'string',
  );
  return { ...p, devices: ok.map((d) => ({ name: d.name ?? '', sketch: d.sketch, eeprom: d.eeprom })) };
}

function valid(p: ProjectData): boolean {
  return (
    !!p &&
    typeof p.sketch === 'string' &&
    typeof p.schematic === 'string' &&
    typeof p.board === 'string'
  );
}
