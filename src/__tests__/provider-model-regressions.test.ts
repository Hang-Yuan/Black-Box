import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  captureSpawnConfiguration,
  detectResumeConfigurationSwitch,
  envFingerprint,
  getSpawnConfigurationErrorMessage,
  spawnConfigHash,
} from '../lib/api-provider';
import { useProviderStore, type ApiProvider } from '../stores/providerStore';
import { useSettingsStore } from '../stores/settingsStore';
import { maskedProviderKey } from '../components/chat/ProviderQuickSelector';

const providerForm = readFileSync(
  resolve(__dirname, '../components/settings/ProviderForm.tsx'),
  'utf8',
);
const providerManager = readFileSync(
  resolve(__dirname, '../components/settings/ProviderManager.tsx'),
  'utf8',
);
const addProviderMenu = readFileSync(
  resolve(__dirname, '../components/settings/AddProviderMenu.tsx'),
  'utf8',
);
const inputBar = readFileSync(
  resolve(__dirname, '../components/chat/InputBar.tsx'),
  'utf8',
);
const chatPanel = readFileSync(
  resolve(__dirname, '../components/chat/ChatPanel.tsx'),
  'utf8',
);
const historicalFork = readFileSync(
  resolve(__dirname, '../hooks/useHistoricalFork.ts'),
  'utf8',
);
const automations = readFileSync(
  resolve(__dirname, '../components/settings/AutomationsTab.tsx'),
  'utf8',
);
const streamProcessor = readFileSync(
  resolve(__dirname, '../hooks/useStreamProcessor.ts'),
  'utf8',
);
const sessionLifecycle = readFileSync(
  resolve(__dirname, '../lib/sessionLifecycle.ts'),
  'utf8',
);
const quickSelector = readFileSync(
  resolve(__dirname, '../components/chat/ProviderQuickSelector.tsx'),
  'utf8',
);
const apiConfig = readFileSync(resolve(__dirname, '../lib/api-config.ts'), 'utf8');
const providerStore = readFileSync(resolve(__dirname, '../stores/providerStore.ts'), 'utf8');

function provider(): ApiProvider {
  return {
    id: 'relay',
    name: 'Relay',
    baseUrl: 'https://relay.example.com',
    apiFormat: 'anthropic',
    apiKey: 'test-only',
    proxyUrl: 'http://127.0.0.1:7890',
    modelMappings: [
      { tier: 'fable', providerModel: 'relay-fable' },
      { tier: 'opus', providerModel: 'relay-opus' },
      { tier: 'sonnet', providerModel: 'relay-sonnet' },
      { tier: 'haiku', providerModel: 'relay-haiku' },
    ],
    createdAt: 1,
    updatedAt: 42,
  };
}

describe('provider editing regressions', () => {
  it('updates every edit in memory immediately and flushes the store on close', () => {
    expect(providerForm).not.toContain('saveTimerRef');
    expect(providerForm).toContain('updateProvider(provider.id, patch);');
    expect(providerForm).toContain('void flushSave().catch');
    expect(providerForm).toContain('providerStore coalesces the');
  });

  it('uses the configured proxy in both form and card connection tests', () => {
    expect(providerForm).toContain('proxyUrl || undefined,');
    expect(providerForm).toContain('provider.id,');
    expect(providerForm).toContain('provider.authScheme, provider.credentialState');
    expect(providerManager).toContain('p.proxyUrl || undefined');
    expect(providerManager).toContain('p.authScheme,');
  });

  it('provides a masked top-bar API key switcher without rendering full secrets', () => {
    const active = { ...provider(), apiKey: 'sk-live-super-secret-1234' };
    expect(maskedProviderKey(active)).toBe('•••• 1234');
    expect(maskedProviderKey({ ...active, credentialHint: '•••• 9876', apiKey: undefined })).toBe('•••• 9876');
    expect(maskedProviderKey({ ...active, apiKey: undefined })).toBe('');
    expect(quickSelector).toContain('data-testid="provider-quick-selector"');
    expect(quickSelector).toContain("openSettings('provider')");
    expect(quickSelector).not.toContain('{provider.apiKey}');
  });

  it('keeps locally stored credentials out of exports and removes Keychain migration UX', () => {
    const exportBlock = apiConfig.slice(
      apiConfig.indexOf('export function exportProvider'),
      apiConfig.indexOf('export function parseAndValidate'),
    );
    expect(exportBlock).not.toContain('provider.apiKey');
    expect(providerManager).not.toContain('legacyCredentialCount');
    expect(providerManager).not.toContain('migrationConfirm');
    expect(providerManager).not.toContain('migrateLegacyCredentials');
    expect(providerStore).toContain('version: 3');
    expect(providerStore).toContain('credentialRef: persisted.credentialRef');
  });

  it('keeps protocol editing for existing providers while limiting new entries to the fixed catalog', () => {
    expect(providerForm).toContain("t('provider.formatAnthropic')");
    expect(providerForm).toContain("t('provider.formatOpenai')");
    expect(providerForm).toContain("t('provider.formatGemini')");
    expect(providerForm).toContain('handleApiFormatChange');
    expect(providerManager).not.toContain('handleAddCustom');
    expect(providerManager).not.toContain('handleImport');
    expect(providerManager).not.toContain('ccswitchNotice');
    expect(addProviderMenu).not.toContain('onAddCustom');
    expect(addProviderMenu).not.toContain('onImport');
  });
});

describe('stopped-session provider/model resume compatibility', () => {
  it('detects a provider switch even after the live stdin route is gone', () => {
    expect(detectResumeConfigurationSwitch(
      {
        providerId: 'opus-route',
        model: 'claude-opus-4-8',
        envFingerprint: '{"activeProviderId":"opus-route","providerRevision":1}',
      },
      {
        providerId: 'discount-route',
        model: 'claude-fable-5',
        envFingerprint: '{"activeProviderId":"discount-route","providerRevision":1}',
      },
    )).toEqual({
      providerSwitched: true,
      modelSwitched: true,
    });
  });

  it('detects edits to the same provider without misclassifying the model', () => {
    expect(detectResumeConfigurationSwitch(
      {
        providerId: 'relay',
        model: 'relay-sonnet',
        envFingerprint: '{"activeProviderId":"relay","providerRevision":1}',
      },
      {
        providerId: 'relay',
        model: 'relay-sonnet',
        envFingerprint: '{"activeProviderId":"relay","providerRevision":2}',
      },
    )).toEqual({
      providerSwitched: true,
      modelSwitched: false,
    });
  });

  it('keeps an unchanged stopped session resumable without sanitization', () => {
    const snapshot = {
      providerId: 'relay',
      model: 'relay-sonnet',
      envFingerprint: '{"activeProviderId":"relay","providerRevision":3}',
    };
    expect(detectResumeConfigurationSwitch(snapshot, snapshot)).toEqual({
      providerSwitched: false,
      modelSwitched: false,
    });
  });

  it('does not invent a switch for legacy sessions without a spawn snapshot', () => {
    expect(detectResumeConfigurationSwitch(
      {},
      {
        providerId: 'relay',
        model: 'relay-sonnet',
        envFingerprint: '{"activeProviderId":"relay","providerRevision":1}',
      },
    )).toEqual({
      providerSwitched: false,
      modelSwitched: false,
    });
  });

  it('wires stopped-session drift detection before model_switch is decided', () => {
    const driftIndex = inputBar.indexOf('const stoppedResumeSwitch =');
    const modelSwitchIndex = inputBar.indexOf('const didSwitchModel = Boolean(');
    expect(driftIndex).toBeGreaterThan(-1);
    expect(modelSwitchIndex).toBeGreaterThan(driftIndex);
    expect(inputBar).toContain('resumeMeta.configSnapshot');
    expect(inputBar).toContain('model_switch: didSwitchModel && !forkSourceId ? true : undefined');
  });
});

describe('single spawn configuration capture', () => {
  it('captures one coherent four-tier provider snapshot', () => {
    const active = provider();
    useProviderStore.setState({
      providers: [active],
      activeProviderId: active.id,
      loaded: true,
    });
    useSettingsStore.setState({ selectedModel: 'sonnet', auxiliaryModel: 'sonnet', thinkingLevel: 'high', agentTeamsEnabled: false });

    const captured = captureSpawnConfiguration();
    expect(captured).toEqual({
      ok: true,
      providerId: 'relay',
      selectedModel: 'sonnet',
      model: 'relay-sonnet',
      auxiliaryModelTier: 'sonnet',
      auxiliaryModel: 'relay-sonnet',
      thinkingLevel: 'high',
      agentTeamsEnabled: false,
      configHash: spawnConfigHash(),
      envFingerprint: envFingerprint(),
    });

    useProviderStore.setState({ activeProviderId: null });
    useSettingsStore.setState({ selectedModel: 'haiku', thinkingLevel: 'low' });
    expect(captured.ok && captured.model).toBe('relay-sonnet');
    expect(captured.ok && captured.thinkingLevel).toBe('high');
  });

  it('fails closed when the captured tier has no provider mapping', () => {
    const active = { ...provider(), modelMappings: [{ tier: 'haiku', providerModel: 'relay-haiku' }] };
    useProviderStore.setState({ providers: [active], activeProviderId: active.id, loaded: true });
    useSettingsStore.setState({ selectedModel: 'sonnet', thinkingLevel: 'medium' });
    expect(captureSpawnConfiguration()).toEqual({
      ok: false,
      reason: 'no_mapping',
      tier: 'sonnet',
      providerName: 'Relay',
    });
  });

  it('fails closed when official Kimi K2.7 Code is selected with Thinking off', () => {
    const active: ApiProvider = {
      ...provider(),
      id: 'kimi-official',
      name: 'Kimi',
      preset: 'kimi',
      baseUrl: 'https://api.moonshot.cn/anthropic',
      modelMappings: [
        { tier: 'fable', providerModel: 'kimi-k3[1m]' },
        { tier: 'opus', providerModel: 'kimi-k2.7-code' },
        { tier: 'sonnet', providerModel: 'kimi-k2.6' },
        { tier: 'haiku', providerModel: 'kimi-k2.6' },
      ],
    };
    useProviderStore.setState({ providers: [active], activeProviderId: active.id, loaded: true });
    useSettingsStore.setState({
      selectedModel: 'opus',
      auxiliaryModel: 'haiku',
      thinkingLevel: 'off',
    });

    const blocked = captureSpawnConfiguration();
    expect(blocked).toEqual({
      ok: false,
      reason: 'thinking_required',
      tier: 'opus',
      providerName: 'Kimi',
      model: 'kimi-k2.7-code',
      minimumThinkingLevel: 'low',
    });
    if (!blocked.ok) {
      expect(getSpawnConfigurationErrorMessage(blocked, (key) => (
        key === 'provider.thinkingRequired'
          ? '「{provider}」的 {model} 必须开启思考模式。'
          : key
      ))).toBe('「Kimi」的 Kimi K2.7 Code 必须开启思考模式。');
    }

    useSettingsStore.setState({ thinkingLevel: 'low' });
    expect(captureSpawnConfiguration()).toMatchObject({
      ok: true,
      model: 'kimi-k2.7-code',
      thinkingLevel: 'low',
    });
  });

  it('applies the Kimi Thinking constraint to auxiliary work but not custom providers', () => {
    const official: ApiProvider = {
      ...provider(),
      id: 'kimi-official',
      name: 'Kimi',
      preset: 'kimi',
      baseUrl: 'https://api.moonshot.cn/anthropic/',
      modelMappings: [
        { tier: 'fable', providerModel: 'kimi-k3[1m]' },
        { tier: 'opus', providerModel: 'kimi-k2.7-code' },
        { tier: 'sonnet', providerModel: 'kimi-k2.6' },
        { tier: 'haiku', providerModel: 'kimi-k2.6' },
      ],
    };
    useProviderStore.setState({ providers: [official], activeProviderId: official.id, loaded: true });
    useSettingsStore.setState({
      selectedModel: 'sonnet',
      auxiliaryModel: 'opus',
      thinkingLevel: 'off',
    });
    expect(captureSpawnConfiguration()).toMatchObject({
      ok: false,
      reason: 'thinking_required',
      tier: 'opus',
    });

    const custom: ApiProvider = {
      ...official,
      id: 'custom-kimi-route',
      name: 'Custom relay',
      preset: undefined,
    };
    useProviderStore.setState({ providers: [custom], activeProviderId: custom.id, loaded: true });
    expect(captureSpawnConfiguration()).toMatchObject({
      ok: true,
      model: 'kimi-k2.6',
      auxiliaryModel: 'kimi-k2.7-code',
      thinkingLevel: 'off',
    });
  });

  it('uses only the captured values throughout asynchronous session startup', () => {
    const start = inputBar.indexOf('const spawnConfig = await flushAndCaptureSpawnConfiguration();');
    const end = inputBar.indexOf('useSessionStore.getState().fetchSessions();', start);
    const spawnBlock = inputBar.slice(start, end);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(spawnBlock).toContain('model: spawnConfig.model');
    expect(spawnBlock).toContain('providerId: spawnConfig.providerId');
    expect(spawnBlock).toContain('thinkingLevel: spawnConfig.thinkingLevel');
    expect(spawnBlock).toContain('agentTeamsEnabled: spawnConfig.agentTeamsEnabled');
    expect(spawnBlock).toContain('agent_teams_enabled: spawnConfig.agentTeamsEnabled');
    expect(spawnBlock).toContain('provider_id: spawnConfig.providerId || undefined');
    expect(spawnBlock).toContain('spawnedModel: spawnConfig.model');
    expect(spawnBlock).toContain('spawnConfigHash: spawnConfig.configHash');
    expect(spawnBlock).not.toContain('resolveModelForProvider(selectedModel)');
  });

  it('settles provider persistence before every user-triggered backend launch path', () => {
    expect(inputBar).toContain('await useProviderStore.getState().flushSave();');
    expect(inputBar).toContain('const spawnConfig = await flushAndCaptureSpawnConfiguration();');
    expect(chatPanel).toContain('const spawnConfig = await flushAndCaptureSpawnConfiguration();');
    expect(historicalFork).toContain('const config = await flushAndCaptureSpawnConfiguration();');
    expect(automations).toContain('await useProviderStore.getState().flushSave();');
    expect(automations).toContain('const persistedProviders = useProviderStore.getState().providers;');
    expect(sessionLifecycle).toContain('await useProviderStore.getState().flushSave();');
    expect(streamProcessor).toContain('const sessionHashMismatch = tab?.sessionMeta.spawnConfigHash !== undefined');
    expect(streamProcessor).toContain('hashMismatch || sessionHashMismatch || stdinMismatch');
  });
});
