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
      return valid(p) ? { ...p, name } : null;
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
    return p;
  }
}

function valid(p: ProjectData): boolean {
  return (
    !!p &&
    typeof p.sketch === 'string' &&
    typeof p.schematic === 'string' &&
    typeof p.board === 'string'
  );
}
