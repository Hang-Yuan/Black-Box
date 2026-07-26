export const DESKTOP_PET_BODIES = [
  'hourglass',
  'cat',
  'fox',
  'rabbit',
  'bear',
  'owl',
  'robot',
  'cloud',
  'slime',
  'axolotl',
  'spirit',
] as const;

export const DESKTOP_PET_EYES = ['dot', 'sparkle', 'sleepy', 'visor', 'wink'] as const;
export const DESKTOP_PET_MOUTHS = ['smile', 'cat', 'tiny', 'flat', 'none'] as const;
export const DESKTOP_PET_ACCESSORIES = [
  'none',
  'crown',
  'bow',
  'leaf',
  'star',
  'glasses',
  'headset',
  'scarf',
  'antenna',
] as const;
export const DESKTOP_PET_MOTIONS = ['float', 'bounce', 'pulse', 'orbit'] as const;
export const DESKTOP_PET_SCALES = ['compact', 'normal', 'large'] as const;

export type DesktopPetBody = typeof DESKTOP_PET_BODIES[number];
export type DesktopPetEyes = typeof DESKTOP_PET_EYES[number];
export type DesktopPetMouth = typeof DESKTOP_PET_MOUTHS[number];
export type DesktopPetAccessory = typeof DESKTOP_PET_ACCESSORIES[number];
export type DesktopPetMotion = typeof DESKTOP_PET_MOTIONS[number];
export type DesktopPetScale = typeof DESKTOP_PET_SCALES[number];

export interface DesktopPetDesign {
  name: string;
  body: DesktopPetBody;
  bodyColor: string;
  accentColor: string;
  eyes: DesktopPetEyes;
  mouth: DesktopPetMouth;
  accessory: DesktopPetAccessory;
  motion: DesktopPetMotion;
  scale: DesktopPetScale;
  showCaption: boolean;
}

export interface DesktopPetAppearance {
  presetId: string;
  custom: DesktopPetDesign;
}

export interface DesktopPetPreset {
  id: string;
  name: { zh: string; en: string };
  design: DesktopPetDesign;
}

const design = (
  name: string,
  body: DesktopPetBody,
  bodyColor: string,
  accentColor: string,
  eyes: DesktopPetEyes,
  mouth: DesktopPetMouth,
  accessory: DesktopPetAccessory,
  motion: DesktopPetMotion,
): DesktopPetDesign => ({
  name,
  body,
  bodyColor,
  accentColor,
  eyes,
  mouth,
  accessory,
  motion,
  scale: 'normal',
  showCaption: true,
});

/**
 * The preset library stays parametric and code-native. Every entry is a small
 * appearance record rather than a raster asset, so state animation, scaling,
 * accessibility and future theme migration remain deterministic.
 */
export const DESKTOP_PET_PRESETS: readonly DesktopPetPreset[] = [
  { id: 'hourglass', name: { zh: '沙漏信使', en: 'Hourglass Courier' }, design: design('沙漏信使', 'hourglass', '#171B20', '#E8D694', 'dot', 'none', 'none', 'float') },
  { id: 'midnight-cat', name: { zh: '午夜猫', en: 'Midnight Cat' }, design: design('午夜猫', 'cat', '#202B42', '#87B9FF', 'sparkle', 'cat', 'star', 'float') },
  { id: 'aurora-cat', name: { zh: '极光猫', en: 'Aurora Cat' }, design: design('极光猫', 'cat', '#5E4A78', '#A9F0D1', 'wink', 'cat', 'bow', 'bounce') },
  { id: 'amber-fox', name: { zh: '琥珀狐', en: 'Amber Fox' }, design: design('琥珀狐', 'fox', '#C96E3B', '#FFE0A1', 'sleepy', 'smile', 'scarf', 'float') },
  { id: 'snow-rabbit', name: { zh: '雪团兔', en: 'Snow Rabbit' }, design: design('雪团兔', 'rabbit', '#F1F4FF', '#8DA9FF', 'dot', 'tiny', 'bow', 'bounce') },
  { id: 'mint-rabbit', name: { zh: '薄荷兔', en: 'Mint Rabbit' }, design: design('薄荷兔', 'rabbit', '#BDE9D6', '#497E70', 'wink', 'smile', 'leaf', 'bounce') },
  { id: 'cocoa-bear', name: { zh: '可可熊', en: 'Cocoa Bear' }, design: design('可可熊', 'bear', '#7C5748', '#F5C98A', 'dot', 'smile', 'scarf', 'pulse') },
  { id: 'polar-bear', name: { zh: '极地熊', en: 'Polar Bear' }, design: design('极地熊', 'bear', '#E7EDF4', '#79B8D8', 'sleepy', 'tiny', 'headset', 'float') },
  { id: 'lavender-owl', name: { zh: '薰衣草鸮', en: 'Lavender Owl' }, design: design('薰衣草鸮', 'owl', '#75618D', '#E0C8FF', 'sparkle', 'tiny', 'glasses', 'pulse') },
  { id: 'forest-owl', name: { zh: '森林鸮', en: 'Forest Owl' }, design: design('森林鸮', 'owl', '#426554', '#CFE39A', 'sleepy', 'smile', 'leaf', 'float') },
  { id: 'brass-robot', name: { zh: '黄铜机', en: 'Brass Bot' }, design: design('黄铜机', 'robot', '#45413B', '#E5BB65', 'visor', 'flat', 'antenna', 'pulse') },
  { id: 'neon-robot', name: { zh: '霓虹机', en: 'Neon Bot' }, design: design('霓虹机', 'robot', '#1D2940', '#59E3FF', 'visor', 'smile', 'headset', 'orbit') },
  { id: 'rain-cloud', name: { zh: '小雨云', en: 'Rain Cloud' }, design: design('小雨云', 'cloud', '#6B7B97', '#B8DFFF', 'sleepy', 'flat', 'none', 'float') },
  { id: 'sunset-cloud', name: { zh: '晚霞云', en: 'Sunset Cloud' }, design: design('晚霞云', 'cloud', '#CC8792', '#FFD59E', 'wink', 'smile', 'star', 'float') },
  { id: 'lime-slime', name: { zh: '青柠冻', en: 'Lime Slime' }, design: design('青柠冻', 'slime', '#82C98F', '#D7FF9A', 'dot', 'smile', 'leaf', 'bounce') },
  { id: 'berry-slime', name: { zh: '莓果冻', en: 'Berry Slime' }, design: design('莓果冻', 'slime', '#9C5F91', '#FFB4DB', 'sparkle', 'cat', 'crown', 'bounce') },
  { id: 'coral-axolotl', name: { zh: '珊瑚六角', en: 'Coral Axolotl' }, design: design('珊瑚六角', 'axolotl', '#E68D91', '#FFD1C7', 'dot', 'smile', 'bow', 'float') },
  { id: 'ocean-axolotl', name: { zh: '深海六角', en: 'Ocean Axolotl' }, design: design('深海六角', 'axolotl', '#416D8B', '#80E1D1', 'sleepy', 'tiny', 'star', 'float') },
  { id: 'lunar-spirit', name: { zh: '月光灵', en: 'Lunar Spirit' }, design: design('月光灵', 'spirit', '#6772A8', '#D9D8FF', 'sparkle', 'none', 'crown', 'orbit') },
  { id: 'star-spirit', name: { zh: '星尘灵', en: 'Stardust Spirit' }, design: design('星尘灵', 'spirit', '#724F83', '#FFE38A', 'wink', 'smile', 'star', 'orbit') },
] as const;

export const DEFAULT_CUSTOM_DESKTOP_PET: DesktopPetDesign = {
  ...DESKTOP_PET_PRESETS[1].design,
  name: '我的伙伴',
};

export const DEFAULT_DESKTOP_PET_APPEARANCE: DesktopPetAppearance = {
  presetId: DESKTOP_PET_PRESETS[0].id,
  custom: DEFAULT_CUSTOM_DESKTOP_PET,
};

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

function choice<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return typeof value === 'string' && values.includes(value as T) ? value as T : fallback;
}

function color(value: unknown, fallback: string): string {
  return typeof value === 'string' && HEX_COLOR.test(value) ? value.toUpperCase() : fallback;
}

export function normalizeDesktopPetDesign(
  value: Partial<DesktopPetDesign> | null | undefined,
): DesktopPetDesign {
  const fallback = DEFAULT_CUSTOM_DESKTOP_PET;
  const name = typeof value?.name === 'string' && value.name.trim()
    ? value.name.trim().slice(0, 16)
    : fallback.name;
  return {
    name,
    body: choice(value?.body, DESKTOP_PET_BODIES, fallback.body),
    bodyColor: color(value?.bodyColor, fallback.bodyColor),
    accentColor: color(value?.accentColor, fallback.accentColor),
    eyes: choice(value?.eyes, DESKTOP_PET_EYES, fallback.eyes),
    mouth: choice(value?.mouth, DESKTOP_PET_MOUTHS, fallback.mouth),
    accessory: choice(value?.accessory, DESKTOP_PET_ACCESSORIES, fallback.accessory),
    motion: choice(value?.motion, DESKTOP_PET_MOTIONS, fallback.motion),
    scale: choice(value?.scale, DESKTOP_PET_SCALES, fallback.scale),
    showCaption: typeof value?.showCaption === 'boolean' ? value.showCaption : fallback.showCaption,
  };
}

export function normalizeDesktopPetAppearance(
  value: Partial<DesktopPetAppearance> | null | undefined,
): DesktopPetAppearance {
  const known = new Set(DESKTOP_PET_PRESETS.map((preset) => preset.id));
  const presetId = value?.presetId === 'custom' || known.has(String(value?.presetId || ''))
    ? String(value?.presetId)
    : DEFAULT_DESKTOP_PET_APPEARANCE.presetId;
  return {
    presetId,
    custom: normalizeDesktopPetDesign(value?.custom),
  };
}

export function resolveDesktopPetDesign(appearance: DesktopPetAppearance): DesktopPetDesign {
  const normalized = normalizeDesktopPetAppearance(appearance);
  if (normalized.presetId === 'custom') return normalized.custom;
  return DESKTOP_PET_PRESETS.find((preset) => preset.id === normalized.presetId)?.design
    ?? DESKTOP_PET_PRESETS[0].design;
}

const RANDOM_COLORS = [
  ['#283450', '#8FC5FF'],
  ['#76506F', '#FFB6DD'],
  ['#3E6956', '#BEEA9D'],
  ['#A65E43', '#FFD19A'],
  ['#5D5A88', '#D4CAFF'],
  ['#43778A', '#93F0DE'],
] as const;

function pick<T>(values: readonly T[], random: () => number): T {
  const index = Math.min(values.length - 1, Math.floor(Math.max(0, random()) * values.length));
  return values[index];
}

export function randomDesktopPetDesign(random: () => number = Math.random): DesktopPetDesign {
  const palette = pick(RANDOM_COLORS, random);
  return normalizeDesktopPetDesign({
    ...DEFAULT_CUSTOM_DESKTOP_PET,
    body: pick(DESKTOP_PET_BODIES.filter((body) => body !== 'hourglass'), random),
    bodyColor: palette[0],
    accentColor: palette[1],
    eyes: pick(DESKTOP_PET_EYES, random),
    mouth: pick(DESKTOP_PET_MOUTHS, random),
    accessory: pick(DESKTOP_PET_ACCESSORIES, random),
    motion: pick(DESKTOP_PET_MOTIONS, random),
  });
}
