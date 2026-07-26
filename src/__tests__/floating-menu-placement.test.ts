import { describe, expect, it } from 'vitest';
import { placeContextMenu, placeSubmenu } from '../lib/floating-menu-placement';

describe('viewport-aware conversation menus', () => {
  const viewport = { width: 1200, height: 800, margin: 8 };

  it('opens a high context menu downward', () => {
    expect(placeContextMenu(160, 100, { width: 190, height: 320 }, viewport))
      .toMatchObject({ left: 160, top: 100, vertical: 'down' });
  });

  it('moves a low context menu upward without changing item order', () => {
    expect(placeContextMenu(160, 720, { width: 190, height: 320 }, viewport))
      .toMatchObject({ left: 160, top: 400, vertical: 'up' });
  });

  it('opens a high group submenu downward beside its trigger', () => {
    expect(placeSubmenu(
      { left: 160, right: 350, top: 220, bottom: 250 },
      { width: 220, height: 360 },
      viewport,
    )).toMatchObject({ left: 354, top: 220, horizontal: 'right', vertical: 'down' });
  });

  it('bottom-aligns a low group submenu so it grows upward', () => {
    expect(placeSubmenu(
      { left: 160, right: 350, top: 700, bottom: 730 },
      { width: 220, height: 360 },
      viewport,
    )).toMatchObject({ left: 354, top: 370, horizontal: 'right', vertical: 'up' });
  });

  it('flips the submenu to the left near the right viewport edge', () => {
    expect(placeSubmenu(
      { left: 1000, right: 1190, top: 200, bottom: 230 },
      { width: 220, height: 300 },
      viewport,
    )).toMatchObject({ left: 776, horizontal: 'left' });
  });
});
