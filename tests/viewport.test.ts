import { describe, expect, it } from 'vitest';
import { Viewport } from '../gui/canvas/viewport';

describe('Viewport transforms', () => {
  it('identity at cam 0/0 zoom 1', () => {
    const v = new Viewport();
    expect(v.worldToScreen(120, -40)).toEqual({ x: 120, y: -40 });
    expect(v.screenToWorld(120, -40)).toEqual({ x: 120, y: -40 });
  });

  it('pan drags content with the cursor (screen pixels)', () => {
    const v = new Viewport();
    v.panBy(-50, 30); // user drags left+down: content moves left+down, we now look at world right+up
    expect(v.screenToWorld(0, 0)).toEqual({ x: 50, y: -30 });
  });

  it('zoom scales world distances on screen', () => {
    const v = new Viewport();
    v.setZoom(2);
    expect(v.worldToScreen(10, 0)).toEqual({ x: 20, y: 0 });
  });

  it('zoomAt keeps the world point under the cursor fixed', () => {
    const v = new Viewport();
    const before = v.screenToWorld(400, 300);
    v.zoomAt(1.5, 400, 300);
    const after = v.screenToWorld(400, 300);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });

  it('clamps zoom to sane bounds', () => {
    const v = new Viewport();
    v.setZoom(0.0001);
    expect(v.zoom).toBeGreaterThanOrEqual(0.1);
    v.setZoom(999);
    expect(v.zoom).toBeLessThanOrEqual(4);
  });

  it('round-trips screen->world->screen through pan and zoom', () => {
    const v = new Viewport();
    v.panBy(133, -77);
    v.zoomAt(2.7, 120, 60);
    const s = v.worldToScreen(v.screenToWorld(321, 111).x, v.screenToWorld(321, 111).y);
    expect(s.x).toBeCloseTo(321, 6);
    expect(s.y).toBeCloseTo(111, 6);
  });

  it('fit centers a world rect with padding', () => {
    const v = new Viewport();
    v.fit({ x: 0, y: 0, w: 200, h: 100 }, 800, 600, 40);
    const c = v.worldToScreen(100, 50); // center of the rect -> center of view
    expect(c.x).toBeCloseTo(400, 6);
    expect(c.y).toBeCloseTo(300, 6);
    const tl = v.worldToScreen(0, 0);
    expect(tl.x).toBeGreaterThanOrEqual(40 - 0.001); // respects padding
  });
});
