import { describe, expect, it } from 'vitest';
import type { PluginMarketplaceRecord, PluginRecord } from '../tauri-bridge';
import {
  compareCatalogPlugins,
  formatInstallCount,
  pluginAudience,
  pluginCategory,
  pluginHue,
  pluginInitials,
  searchablePluginText,
} from '../plugin-catalog';

const plugin = (patch: Partial<PluginRecord> = {}): PluginRecord => ({
  id: 'github@claude-plugins-official',
  name: 'github',
  marketplaceName: 'claude-plugins-official',
  description: 'GitHub integration',
  version: null,
  availableVersion: null,
  scope: null,
  enabled: false,
  installed: false,
  updateAvailable: false,
  source: null,
  installPath: null,
  installedAt: null,
  lastUpdated: null,
  category: 'Development',
  tags: ['source-control'],
  homepage: null,
  repository: null,
  authorName: 'Anthropic',
  installCount: 12_400,
  components: ['MCP'],
  strict: true,
  ...patch,
});

const marketplaces: PluginMarketplaceRecord[] = [
  { name: 'claude-plugins-official', source: 'github', path: null, installLocation: '/cache/official' },
  { name: 'my-tools', source: 'directory', path: '/tmp/tools', installLocation: '/tmp/tools' },
];

describe('plugin catalog helpers', () => {
  it('separates remote public sources from local personal sources', () => {
    expect(pluginAudience(plugin(), marketplaces)).toBe('public');
    expect(pluginAudience(plugin({ id: 'mine@my-tools', marketplaceName: 'my-tools' }), marketplaces)).toBe('personal');
  });

  it('searches manifest metadata and normalizes categories', () => {
    expect(searchablePluginText(plugin())).toContain('source-control');
    expect(searchablePluginText(plugin())).toContain('anthropic');
    expect(pluginCategory(plugin())).toBe('development');
    expect(pluginCategory(plugin({ category: null }))).toBe('other');
  });

  it('sorts installed first and then by observed install count', () => {
    const records = [
      plugin({ id: 'low', name: 'low', installCount: 5 }),
      plugin({ id: 'high', name: 'high', installCount: 500 }),
      plugin({ id: 'installed', name: 'installed', installed: true, installCount: 1 }),
    ].sort(compareCatalogPlugins);
    expect(records.map((record) => record.id)).toEqual(['installed', 'high', 'low']);
  });

  it('creates stable local glyphs and compact popularity labels', () => {
    expect(pluginHue(plugin())).toBe(pluginHue(plugin()));
    expect(pluginInitials(plugin({ name: 'google-drive' }))).toBe('GD');
    expect(formatInstallCount(12_400)).toBe('12.4k');
    expect(formatInstallCount(null)).toBeNull();
  });
});
