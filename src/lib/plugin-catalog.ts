import type { PluginMarketplaceRecord, PluginRecord } from './tauri-bridge';

export type PluginAudience = 'public' | 'personal';

const LOCAL_MARKETPLACE_SOURCES = new Set(['directory', 'file', 'local', 'path']);

export function pluginAudience(
  plugin: PluginRecord,
  marketplaces: PluginMarketplaceRecord[],
): PluginAudience {
  const marketplace = marketplaces.find((item) => item.name === plugin.marketplaceName);
  if (marketplace) {
    return LOCAL_MARKETPLACE_SOURCES.has(marketplace.source.toLowerCase())
      ? 'personal'
      : 'public';
  }
  return plugin.marketplaceName?.toLowerCase().includes('official') ? 'public' : 'personal';
}

export function pluginCategory(plugin: PluginRecord): string {
  const category = plugin.category?.trim().toLowerCase();
  return category || 'other';
}

export function searchablePluginText(plugin: PluginRecord): string {
  return [
    plugin.name,
    plugin.id,
    plugin.description,
    plugin.marketplaceName,
    plugin.category,
    plugin.authorName,
    ...plugin.tags,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

export function compareCatalogPlugins(left: PluginRecord, right: PluginRecord): number {
  if (left.installed !== right.installed) return left.installed ? -1 : 1;
  const popularity = (right.installCount || 0) - (left.installCount || 0);
  return popularity || left.name.localeCompare(right.name, 'zh-Hans-CN');
}

export function pluginHue(plugin: Pick<PluginRecord, 'id'>): number {
  let hash = 0;
  for (const character of plugin.id) hash = ((hash * 31) + character.charCodeAt(0)) >>> 0;
  return hash % 360;
}

export function pluginInitials(plugin: Pick<PluginRecord, 'name'>): string {
  const pieces = plugin.name.split(/[-_\s]+/).filter(Boolean);
  return (pieces.length > 1 ? `${pieces[0][0]}${pieces[1][0]}` : plugin.name.slice(0, 2))
    .toUpperCase();
}

export function formatInstallCount(count: number | null): string | null {
  if (!count || count < 1) return null;
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(count >= 10_000_000 ? 0 : 1)}m`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(count >= 100_000 ? 0 : 1)}k`;
  return String(count);
}
