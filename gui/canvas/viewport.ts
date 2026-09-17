/**
 * Viewport: the only thing that knows about the camera. Pure math, no DOM -
 * the renderer feeds it canvas size, the interaction layer feeds it gestures.
 *
 * Screen coords: pixels on the canvas (origin top-left).
 * World coords: schematic space, 1 unit = 1 grid cell base (10).
 * screen = (world - cam) * zoom
 */

export interface Pt {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 4;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export class Viewport {
  camX = 0;
  camY = 0;
  zoom = 1;

  screenToWorld(sx: number, sy: number): Pt {
    return { x: sx / this.zoom + this.camX, y: sy / this.zoom + this.camY };
  }

  worldToScreen(wx: number, wy: number): Pt {
    return { x: (wx - this.camX) * this.zoom, y: (wy - this.camY) * this.zoom };
  }

  /** Drag the world by a screen-pixel delta (content follows the cursor). */
  panBy(dxScreen: number, dyScreen: number): void {
    this.camX -= dxScreen / this.zoom;
    this.camY -= dyScreen / this.zoom;
  }

  setZoom(z: number): void {
    this.zoom = clamp(z, MIN_ZOOM, MAX_ZOOM);
  }

  /** Zoom keeping the world point under (sx, sy) exactly where it is. */
  zoomAt(factor: number, sx: number, sy: number): void {
    const anchor = this.screenToWorld(sx, sy);
    this.setZoom(this.zoom * factor);
    this.camX = anchor.x - sx / this.zoom;
    this.camY = anchor.y - sy / this.zoom;
  }

  /** Center `rect` inside a viewW x viewH viewport, respecting `padding` px. */
  fit(rect: Rect, viewW: number, viewH: number, padding = 20): void {
    const availW = Math.max(1, viewW - 2 * padding);
    const availH = Math.max(1, viewH - 2 * padding);
    this.zoom = clamp(
      Math.min(availW / Math.max(rect.w, 1e-6), availH / Math.max(rect.h, 1e-6)),
      MIN_ZOOM,
      MAX_ZOOM,
    );
    this.camX = rect.x + rect.w / 2 - viewW / 2 / this.zoom;
    this.camY = rect.y + rect.h / 2 - viewH / 2 / this.zoom;
  }

  /** World-space rect currently visible (for culling). */
  visibleWorldRect(viewW: number, viewH: number): Rect {
    const tl = this.screenToWorld(0, 0);
    const br = this.screenToWorld(viewW, viewH);
    return { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y };
  }
}
