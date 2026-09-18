import { describe, expect, it } from 'vitest';
import { ProjectStore, type ProjectData } from '../gui/projects';

/** Minimal in-memory Storage stand-in. */
class FakeStorage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  key(i: number): string | null {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.m.has(k) ? (this.m.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v);
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
}

const sample: ProjectData = {
  name: 'lab-4',
  sketch: 'void setup() {}',
  schematic: '{"comps":[],"wires":[]}',
  board: 'nodemcu-v3',
};

describe('ProjectStore', () => {
  it('round-trips save/list/load', () => {
    const st = new ProjectStore(new FakeStorage());
    expect(st.list()).toEqual([]);
    st.save(sample);
    expect(st.list()).toEqual(['lab-4']);
    expect(st.load('lab-4')).toEqual(sample);
  });

  it('keeps the list sorted and replaces an existing name', () => {
    const st = new ProjectStore(new FakeStorage());
    st.save({ ...sample, name: 'zebra' });
    st.save({ ...sample, name: 'alpha' });
    st.save({ ...sample, name: 'zebra', sketch: 'v2' });
    expect(st.list()).toEqual(['alpha', 'zebra']);
    expect(st.load('zebra')?.sketch).toBe('v2');
  });

  it('remove drops data and list entry', () => {
    const st = new ProjectStore(new FakeStorage());
    st.save(sample);
    st.remove('lab-4');
    expect(st.list()).toEqual([]);
    expect(st.load('lab-4')).toBeNull();
  });

  it('load of a corrupt entry returns null, not a throw', () => {
    const raw = new FakeStorage();
    const st = new ProjectStore(raw);
    st.save(sample);
    raw.setItem('esp8266-emu.project.lab-4', '{oops');
    expect(st.load('lab-4')).toBeNull();
  });

  it('export/parseImport round-trip', () => {
    const st = new ProjectStore(new FakeStorage());
    const text = st.exportJson(sample);
    expect(st.parseImport(text)).toEqual(sample);
  });

  it('parseImport rejects junk', () => {
    const st = new ProjectStore(new FakeStorage());
    expect(() => st.parseImport('nonsense')).toThrow();
    expect(() => st.parseImport('{"sketch":1}')).toThrow();
  });
});
