import { describe, expect, it } from 'vitest';
import { Schematic } from '../gui/canvas/schematic';
import { pathThroughRects, routeWiresSequential } from '../gui/canvas/routes';

describe('isolate w5', () => {
  it('alone', () => {
    const s = new Schematic();
    const b = s.addBoard('wemos-d1-mini', 160, 60);
    s.add('button', 0, 160, {});
    const r = s.add('resistor', 0, 180, { resistance: 220 });
    const led = s.add('led', -120, 180, {});
    const bodies = s.wireObstacles({ comp: led.id, pin: 'k' }, { comp: b.id, pin: 'GND' });
    const [p] = routeWiresSequential([{
      a: { x: -100, y: 180 }, b: { x: 320, y: 180 }, da: 'right', db: 'left',
      obstacles: bodies, bodies,
    }]);
    const rBody = s.bodyRect(s.component(r.id)!);
    console.log('bodies:', JSON.stringify(bodies), 'path:', JSON.stringify(p),
      'through:', pathThroughRects(p, [rBody], false, false).length);
    expect(pathThroughRects(p, [rBody], false, false).length).toBe(0);
  });
});
