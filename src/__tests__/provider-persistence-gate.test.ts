import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiProvider } from '../stores/providerStore';
import type { ProvidersFile } from '../lib/tauri-bridge';

function provider(overrides: Partial<ApiProvider> = {}): ApiProvider {
  return {
    id: 'relay',
    name: 'Relay',
    baseUrl: 'https://relay.example.com',
    apiFormat: 'anthropic',
    modelMappings: [
      { tier: 'fable', providerModel: 'relay-fable' },
      { tier: 'opus', providerModel: 'relay-opus' },
      { tier: 'sonnet', providerModel: 'relay-sonnet' },
      { tier: 'haiku', providerModel: 'relay-haiku' },
    ],
    revision: 3,
    createdAt: 1,
    updatedAt: 100,
    ...overrides,
  };
}

async function freshModules() {
  vi.resetModules();
  const { bridge } = await import('../lib/tauri-bridge');
  const loadProviders = vi.spyOn(bridge, 'loadProviders');
  const saveProviders = vi.spyOn(bridge, 'saveProviders');
  const { useProviderStore } = await import('../stores/providerStore');
  return { bridge, loadProviders, saveProviders, useProviderStore };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('provider persistence barrier', () => {
  it('persists an untouched historical preset migration during initial load', async () => {
    const { loadProviders, saveProviders, useProviderStore } = await freshModules();
    loadProviders.mockResolvedValue({
      version: 3,
      activeProviderId: 'qwen-old',
      providers: [provider({
        id: 'qwen-old',
        preset: 'qwen',
        baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic',
        authScheme: undefined,
        modelMappings: [
          { tier: 'opus', providerModel: 'qwen3-max' },
          { tier: 'sonnet', providerModel: 'qwen3.5-plus' },
          { tier: 'haiku', providerModel: 'qwen3.5-flash' },
        ],
      })],
    });
    saveProviders.mockImplementation(async (data) => data);

    await useProviderStore.getState().load();

    expect(saveProviders).toHaveBeenCalledTimes(1);
    expect(saveProviders.mock.calls[0][0].providers[0]).toMatchObject({
      baseUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
      authScheme: 'bearer',
      modelMappings: [
        { tier: 'fable', providerModel: 'qwen3.7-plus' },
        { tier: 'opus', providerModel: 'qwen3.7-plus' },
        { tier: 'sonnet', providerModel: 'qwen3.6-plus' },
        { tier: 'haiku', providerModel: 'qwen3.5-plus' },
      ],
    });
    expect(useProviderStore.getState().providers[0].baseUrl).toBe(
      'https://coding.dashscope.aliyuncs.com/apps/anthropic',
    );
  });

  it('persists the lossless OpenAI-compatible Gemini migration during initial load', async () => {
    const { loadProviders, saveProviders, useProviderStore } = await freshModules();
    loadProviders.mockResolvedValue({
      version: 3,
      activeProviderId: 'gemini-old',
      providers: [provider({
        id: 'gemini-old',
        preset: 'gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        apiFormat: 'openai',
        authScheme: 'bearer',
        credentialHint: '•••• 2468',
        credentialState: 'local_file',
        proxyUrl: 'http://127.0.0.1:7890',
        modelMappings: [
          { tier: 'fable', providerModel: 'gemini-3.5-flash' },
          { tier: 'opus', providerModel: 'gemini-3.5-flash' },
          { tier: 'sonnet', providerModel: 'gemini-3.5-flash' },
          { tier: 'haiku', providerModel: 'gemini-3.1-flash-lite' },
        ],
      })],
    });
    saveProviders.mockImplementation(async (data) => data);

    await useProviderStore.getState().load();

    expect(saveProviders).toHaveBeenCalledTimes(1);
    expect(saveProviders.mock.calls[0][0].providers[0]).toMatchObject({
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiFormat: 'gemini',
      authScheme: 'x-goog-api-key',
      credentialHint: '•••• 2468',
      credentialState: 'local_file',
      proxyUrl: 'http://127.0.0.1:7890',
    });
  });

  it('does not rewrite a provider that already matches the current preset', async () => {
    const { loadProviders, saveProviders, useProviderStore } = await freshModules();
    loadProviders.mockResolvedValue({
      version: 3,
      activeProviderId: 'deepseek-current',
      providers: [provider({
        id: 'deepseek-current',
        preset: 'deepseek',
        baseUrl: 'https://api.deepseek.com/anthropic',
        authScheme: 'x-api-key',
        modelMappings: [
          { tier: 'fable', providerModel: 'deepseek-v4-pro' },
          { tier: 'opus', providerModel: 'deepseek-v4-pro' },
          { tier: 'sonnet', providerModel: 'deepseek-v4-flash' },
          { tier: 'haiku', providerModel: 'deepseek-v4-flash' },
        ],
        extraEnv: {},
      })],
    });

    await useProviderStore.getState().load();

    expect(saveProviders).not.toHaveBeenCalled();
    expect(useProviderStore.getState().providers[0]).toMatchObject({
      id: 'deepseek-current',
      baseUrl: 'https://api.deepseek.com/anthropic',
      authScheme: 'x-api-key',
    });
  });

  it('does not write when flushSave has no dirty provider state', async () => {
    const { saveProviders, useProviderStore } = await freshModules();
    useProviderStore.setState({
      providers: [provider()],
      activeProviderId: 'relay',
      loaded: true,
    });

    await useProviderStore.getState().flushSave();

    expect(saveProviders).not.toHaveBeenCalled();
  });

  it('persists an immediate key switch before capturing backend spawn metadata', async () => {
    const { saveProviders, useProviderStore } = await freshModules();
    saveProviders.mockImplementation(async (data: ProvidersFile) => ({
      ...data,
      providers: data.providers.map((entry) => ({
        ...entry,
        apiKey: undefined,
        credentialHint: '•••• 4321',
        credentialState: 'local_file' as const,
        revision: 4,
      })),
    }));
    useProviderStore.setState({
      providers: [provider()],
      activeProviderId: null,
      loaded: true,
    });
    useProviderStore.getState().updateProvider('relay', { apiKey: 'sk-new-4321' });
    useProviderStore.getState().setActive('relay');

    const { useSettingsStore } = await import('../stores/settingsStore');
    useSettingsStore.setState({
      selectedModel: 'sonnet',
      thinkingLevel: 'high',
      agentTeamsEnabled: false,
    });
    const { flushAndCaptureSpawnConfiguration } = await import('../lib/api-provider');
    const captured = await flushAndCaptureSpawnConfiguration();

    expect(saveProviders).toHaveBeenCalledTimes(1);
    const persisted = saveProviders.mock.calls[0][0];
    expect(persisted.activeProviderId).toBe('relay');
    expect(persisted.providers[0].apiKey).toBe('sk-new-4321');
    expect(useProviderStore.getState().providers[0]).toMatchObject({
      credentialHint: '•••• 4321',
      credentialState: 'local_file',
      revision: 4,
    });
    expect(captured).toMatchObject({
      ok: true,
      providerId: 'relay',
      model: 'relay-sonnet',
      thinkingLevel: 'high',
    });
    expect(captured.ok && captured.configHash).toContain('|4|');
  });

  it('serializes overlapping saves and preserves an edit made during the first write', async () => {
    const { saveProviders, useProviderStore } = await freshModules();
    let resolveFirst: ((value: ProvidersFile) => void) | undefined;
    saveProviders
      .mockImplementationOnce((data: ProvidersFile) => new Promise<ProvidersFile>((resolve) => {
        resolveFirst = () => resolve({
          ...data,
          providers: data.providers.map((entry) => ({ ...entry, revision: 4 })),
        });
      }))
      .mockImplementationOnce(async (data: ProvidersFile) => ({
        ...data,
        providers: data.providers.map((entry) => ({ ...entry, revision: 5 })),
      }));
    useProviderStore.setState({
      providers: [provider()],
      activeProviderId: 'relay',
      loaded: true,
    });

    useProviderStore.getState().updateProvider('relay', { name: 'First edit' });
    const firstFlush = useProviderStore.getState().flushSave();
    await vi.waitFor(() => expect(saveProviders).toHaveBeenCalledTimes(1));

    useProviderStore.getState().updateProvider('relay', { name: 'Second edit' });
    const joinedFlush = useProviderStore.getState().flushSave();
    resolveFirst?.(saveProviders.mock.calls[0][0]);
    await Promise.all([firstFlush, joinedFlush]);

    expect(saveProviders).toHaveBeenCalledTimes(2);
    expect(saveProviders.mock.calls[0][0].providers[0].name).toBe('First edit');
    expect(saveProviders.mock.calls[1][0].providers[0].name).toBe('Second edit');
    expect(useProviderStore.getState().providers[0]).toMatchObject({
      name: 'Second edit',
      revision: 5,
    });
  });
});
