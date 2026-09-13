import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  persistedPreferences: {} as Record<string, unknown>,
  loadConversationRuntimePreferences: vi.fn(),
  saveConversationRuntimePreferences: vi.fn(),
}));
mocks.loadConversationRuntimePreferences.mockImplementation(
  async () => structuredClone(mocks.persistedPreferences),
);
mocks.saveConversationRuntimePreferences.mockImplementation(
  async (data: Record<string, unknown>) => {
    mocks.persistedPreferences = structuredClone(data);
  },
);

vi.mock('../tauri-bridge', () => ({
  bridge: {
    loadConversationRuntimePreferences: mocks.loadConversationRuntimePreferences,
    saveConversationRuntimePreferences: mocks.saveConversationRuntimePreferences,
    saveProviders: vi.fn(async (data) => data),
  },
}));

import {
  __conversationRuntimePreferencesTesting,
  applyDefaultRuntimeToConversation,
  ensureConversationRuntimeReady,
  forgetConversationRuntimePreference,
  initializeConversationRuntimePreferences,
  inheritContinuationRuntimePreference,
  moveConversationRuntimePreference,
  restoreConversationRuntimePreference,
} from '../conversation-runtime-preferences';
import { useProviderStore, type ApiProvider } from '../../stores/providerStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';

const relay: ApiProvider = {
  id: 'relay',
  name: 'Relay',
  baseUrl: 'https://relay.invalid',
  apiFormat: 'anthropic',
  credentialHint: '•••• 1234',
  credentialState: 'local_file',
  revision: 1,
  modelMappings: [
    { tier: 'fable', providerModel: 'relay-fable' },
    { tier: 'opus', providerModel: 'relay-opus' },
    { tier: 'sonnet', providerModel: 'relay-sonnet' },
    { tier: 'haiku', providerModel: 'relay-haiku' },
  ],
  createdAt: 1,
  updatedAt: 1,
};

function selectThread(sessionId: string | null) {
  useSessionStore.setState({ selectedSessionId: sessionId });
}

describe('conversation runtime preferences', () => {
  beforeAll(async () => {
    initializeConversationRuntimePreferences();
    await __conversationRuntimePreferencesTesting.load();
  });

  beforeEach(() => {
    selectThread(null);
    mocks.persistedPreferences = {};
    mocks.loadConversationRuntimePreferences.mockReset();
    mocks.loadConversationRuntimePreferences.mockImplementation(
      async () => structuredClone(mocks.persistedPreferences),
    );
    mocks.saveConversationRuntimePreferences.mockClear();
    __conversationRuntimePreferencesTesting.reset();
    useProviderStore.setState({
      providers: [relay],
      defaultApi: null,
      defaultMainModel: null,
      defaultAuxiliaryModel: null,
      activeProviderId: null,
      loaded: true,
    });
    useSettingsStore.setState({
      selectedModel: 'sonnet',
      auxiliaryModel: 'sonnet',
      customModelId: null,
    });
  });

  it('keeps rapid provider and model changes bound to the thread selected at change time', async () => {
    selectThread('thread-a');
    useProviderStore.setState({ activeProviderId: 'relay' });
    useSettingsStore.getState().setSelectedModel('opus');

    selectThread('thread-b');
    useProviderStore.setState({ activeProviderId: null });
    useSettingsStore.getState().setSelectedModel('haiku');
    await __conversationRuntimePreferencesTesting.flush();

    expect(mocks.persistedPreferences).toMatchObject({
      'thread-a': {
        providerId: 'relay',
        selectedModel: 'opus',
        auxiliaryModel: 'sonnet',
        customModelId: null,
      },
      'thread-b': {
        providerId: null,
        selectedModel: 'haiku',
        auxiliaryModel: 'sonnet',
        customModelId: null,
      },
    });
  });

  it('inherits a continuation route before selection and promotion without copying system defaults', async () => {
    useProviderStore.setState({ defaultApi: 'relay', defaultMainModel: 'opus', defaultAuxiliaryModel: 'sonnet' });
    selectThread('source');
    useProviderStore.setState({ activeProviderId: 'relay' });
    useSettingsStore.getState().setSelectedModel('haiku');
    useSettingsStore.getState().setAuxiliaryModel('haiku');
    await inheritContinuationRuntimePreference('source', 'draft_next');
    selectThread('draft_next');
    expect(useSettingsStore.getState().selectedModel).toBe('haiku');
    expect(useSettingsStore.getState().auxiliaryModel).toBe('haiku');
    expect(useProviderStore.getState().activeProviderId).toBe('relay');
    await moveConversationRuntimePreference('draft_next', 'continued');
    expect(mocks.persistedPreferences).toMatchObject({ continued: { selectedModel: 'haiku', auxiliaryModel: 'haiku', providerId: 'relay' } });
    expect(useProviderStore.getState().defaultMainModel).toBe('opus');
    selectThread('draft_unrelated');
    expect(useSettingsStore.getState().selectedModel).toBe('opus');
    await expect(inheritContinuationRuntimePreference('source', 'draft_stale')).rejects.toThrow('HANDOFF_SOURCE_CHANGED');
  });

  it('restores each conversation after switching away and back', async () => {
    mocks.persistedPreferences = {
      'thread-a': {
        providerId: 'relay',
        selectedModel: 'opus',
        customModelId: null,
      },
      'thread-b': {
        providerId: null,
        selectedModel: 'sonnet',
        customModelId: 'claude-native-custom',
      },
    };

    selectThread('thread-a');
    expect(await restoreConversationRuntimePreference('thread-a')).toBe(true);
    expect(useProviderStore.getState().activeProviderId).toBe('relay');
    expect(useSettingsStore.getState().selectedModel).toBe('opus');
    expect(useSettingsStore.getState().auxiliaryModel).toBe('sonnet');
    expect(useSettingsStore.getState().customModelId).toBeNull();

    selectThread('thread-b');
    expect(await restoreConversationRuntimePreference('thread-b')).toBe(true);
    expect(useProviderStore.getState().activeProviderId).toBeNull();
    expect(useSettingsStore.getState().selectedModel).toBe('sonnet');
    expect(useSettingsStore.getState().auxiliaryModel).toBe('sonnet');
    expect(useSettingsStore.getState().customModelId).toBe('claude-native-custom');
  });

  it('carries a draft choice to the durable Claude session id', async () => {
    selectThread('draft_123');
    useProviderStore.setState({ activeProviderId: 'relay' });
    useSettingsStore.getState().setSelectedModel('fable');
    await __conversationRuntimePreferencesTesting.flush();

    selectThread('thread-real');
    await moveConversationRuntimePreference('draft_123', 'thread-real');

    expect(mocks.persistedPreferences).toEqual({
      'thread-real': {
        providerId: 'relay',
        selectedModel: 'fable',
        auxiliaryModel: 'sonnet',
        customModelId: null,
      },
    });
    expect(JSON.stringify(mocks.persistedPreferences)).not.toContain('draft_123');
  });

  it('seeds an untouched draft before a background durable-id promotion', async () => {
    useProviderStore.setState({
      activeProviderId: null,
      defaultApi: 'relay',
      defaultMainModel: 'opus',
      defaultAuxiliaryModel: 'haiku',
    });
    useSettingsStore.getState().setSelectedModel('opus');
    selectThread('draft_background');
    selectThread('thread-other');

    await moveConversationRuntimePreference('draft_background', 'thread-real');

    expect(mocks.persistedPreferences).toEqual({
      'thread-real': {
        providerId: 'relay',
        selectedModel: 'opus',
        auxiliaryModel: 'haiku',
        customModelId: null,
      },
    });
  });

  it('retries a failed metadata load without overwriting durable preferences', async () => {
    mocks.persistedPreferences = {
      'thread-a': {
        providerId: 'relay',
        selectedModel: 'opus',
        customModelId: null,
      },
    };
    mocks.loadConversationRuntimePreferences
      .mockRejectedValueOnce(new Error('temporary read failure'))
      .mockImplementation(
        async () => structuredClone(mocks.persistedPreferences),
      );

    await expect(__conversationRuntimePreferencesTesting.load()).rejects.toThrow(
      'temporary read failure',
    );
    selectThread('thread-a');
    expect(await restoreConversationRuntimePreference('thread-a')).toBe(true);
    expect(useProviderStore.getState().activeProviderId).toBe('relay');
    expect(useSettingsStore.getState().selectedModel).toBe('opus');
    expect(mocks.saveConversationRuntimePreferences).not.toHaveBeenCalled();
  });

  it('falls back from a deleted provider and persists the cleaned route', async () => {
    useProviderStore.setState({
      defaultApi: 'relay',
      defaultMainModel: 'opus',
      defaultAuxiliaryModel: 'haiku',
    });
    mocks.persistedPreferences = {
      'thread-a': {
        providerId: 'missing-provider',
        selectedModel: 'haiku',
        customModelId: null,
      },
    };
    selectThread('thread-a');

    expect(await restoreConversationRuntimePreference('thread-a')).toBe(true);
    expect(useProviderStore.getState().activeProviderId).toBe('relay');
    expect(useSettingsStore.getState().selectedModel).toBe('opus');
    expect(mocks.persistedPreferences).toEqual({
      'thread-a': {
        providerId: 'relay',
        selectedModel: 'opus',
        auxiliaryModel: 'haiku',
        customModelId: null,
      },
    });
  });

  it('migrates a legacy system-login conversation to the complete default triple', async () => {
    useProviderStore.setState({
      defaultApi: 'relay',
      defaultMainModel: 'opus',
      defaultAuxiliaryModel: 'haiku',
    });
    mocks.persistedPreferences = {
      'thread-a': {
        providerId: null,
        selectedModel: 'fable',
        auxiliaryModel: 'sonnet',
        customModelId: null,
      },
    };
    selectThread('thread-a');

    expect(await restoreConversationRuntimePreference('thread-a')).toBe(true);
    expect(useProviderStore.getState().activeProviderId).toBe('relay');
    expect(useSettingsStore.getState().selectedModel).toBe('opus');
    expect(useSettingsStore.getState().auxiliaryModel).toBe('haiku');
    expect(mocks.persistedPreferences).toEqual({
      'thread-a': {
        providerId: 'relay',
        selectedModel: 'opus',
        auxiliaryModel: 'haiku',
        customModelId: null,
      },
    });
  });

  it('repairs an unavailable visible route before a new turn starts', async () => {
    useProviderStore.setState({
      defaultApi: 'relay',
      defaultMainModel: 'opus',
      defaultAuxiliaryModel: 'haiku',
      activeProviderId: null,
    });
    selectThread('thread-a');

    expect(await ensureConversationRuntimeReady('thread-a')).toMatchObject({
      ready: true,
      switchedToDefault: true,
      defaultSummary: 'Relay · opus · haiku',
    });
    expect(useProviderStore.getState().activeProviderId).toBe('relay');
    expect(mocks.persistedPreferences).toMatchObject({
      'thread-a': {
        providerId: 'relay',
        selectedModel: 'opus',
        auxiliaryModel: 'haiku',
      },
    });
  });

  it('applies defaults only to the conversation that remains selected', async () => {
    useProviderStore.setState({
      defaultApi: 'relay',
      defaultMainModel: 'opus',
      defaultAuxiliaryModel: 'haiku',
    });
    selectThread('thread-a');
    expect(await applyDefaultRuntimeToConversation('thread-a')).toMatchObject({
      ready: true,
      switchedToDefault: true,
    });

    selectThread('thread-b');
    expect(await applyDefaultRuntimeToConversation('thread-a')).toEqual({
      ready: false,
      switchedToDefault: false,
      reason: 'selection_changed',
    });
  });

  it('forgets a deleted conversation in memory and durable metadata', async () => {
    mocks.persistedPreferences = {
      'thread-a': {
        providerId: 'relay',
        selectedModel: 'opus',
        customModelId: null,
      },
    };
    await __conversationRuntimePreferencesTesting.load();

    await forgetConversationRuntimePreference('thread-a');

    expect(mocks.persistedPreferences).toEqual({});
    expect(__conversationRuntimePreferencesTesting.snapshot()).toEqual({});
  });

  it('ignores a stale restore when the user has already selected another thread', async () => {
    mocks.persistedPreferences = {
      'thread-a': {
        providerId: 'relay',
        selectedModel: 'opus',
        customModelId: null,
      },
    };
    selectThread('thread-b');

    expect(await restoreConversationRuntimePreference('thread-a')).toBe(false);
    expect(useProviderStore.getState().activeProviderId).toBeNull();
    expect(useSettingsStore.getState().selectedModel).toBe('sonnet');
  });
});
