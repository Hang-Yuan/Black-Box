import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DESKTOP_PET_APPEARANCE,
  DESKTOP_PET_PRESETS,
  normalizeDesktopPetAppearance,
  normalizeDesktopPetDesign,
  randomDesktopPetDesign,
  resolveDesktopPetDesign,
} from '../desktop-pet-presets';

describe('desktop pet preset catalog', () => {
  it('ships exactly twenty unique code-native presets', () => {
    expect(DESKTOP_PET_PRESETS).toHaveLength(20);
    expect(new Set(DESKTOP_PET_PRESETS.map((preset) => preset.id)).size).toBe(20);
    expect(DESKTOP_PET_PRESETS.every((preset) => /^#[0-9A-F]{6}$/i.test(preset.design.bodyColor))).toBe(true);
    expect(DESKTOP_PET_PRESETS.every((preset) => /^#[0-9A-F]{6}$/i.test(preset.design.accentColor))).toBe(true);
  });

  it('falls back safely when persisted custom fields are invalid', () => {
    expect(normalizeDesktopPetAppearance({
      presetId: 'unknown-preset',
      custom: {
        ...DEFAULT_DESKTOP_PET_APPEARANCE.custom,
        name: '  This name is deliberately much too long  ',
        bodyColor: 'url(evil)',
        body: 'dragon' as never,
      },
    })).toMatchObject({
      presetId: 'hourglass',
      custom: {
        name: 'This name is del',
        body: 'cat',
        bodyColor: '#202B42',
      },
    });
  });

  it('resolves custom designs independently from the preset catalog', () => {
    const custom = normalizeDesktopPetDesign({
      ...DEFAULT_DESKTOP_PET_APPEARANCE.custom,
      name: 'Nova',
      body: 'spirit',
      accentColor: '#AABBCC',
    });
    expect(resolveDesktopPetDesign({ presetId: 'custom', custom })).toEqual(custom);
    expect(resolveDesktopPetDesign(DEFAULT_DESKTOP_PET_APPEARANCE).name).toBe('沙漏信使');
  });

  it('can produce a valid surprise design without selecting the legacy hourglass', () => {
    const sequence = [0.2, 0.4, 0.6, 0.8, 0.3, 0.7];
    let index = 0;
    const generated = randomDesktopPetDesign(() => sequence[index++ % sequence.length]);
    expect(generated.body).not.toBe('hourglass');
    expect(generated.bodyColor).toMatch(/^#[0-9A-F]{6}$/);
    expect(generated.accentColor).toMatch(/^#[0-9A-F]{6}$/);
  });
});
