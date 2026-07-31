import { bridge, type ConversationRuntimePreference } from './tauri-bridge';
import { useProviderStore } from '../stores/providerStore';
import { useSessionStore } from '../stores/sessionStore';
import {
  isModelTier,
  normalizeModelTier,
  useSettingsStore,
} from '../stores/settingsStore';

type PreferenceMap = Record<string, ConversationRuntimePreference>;

let preferences: PreferenceMap = {};
let loadPromise: Promise<void> | null = null;
let mutationQueue: Promise<void> = Promise.resolve();
let initialized = false;
let restoringDepth = 0;

function isDurableSessionId(sessionId: string): boolean {
  return !!sessionId
    && !sessionId.startsWith('draft_')
    && !sessionId.startsWith('desk_');
}

function normalizePreference(
  value: Partial<ConversationRuntimePreference> | null | undefined,
): ConversationRuntimePreference | null {
  if (!value || !isModelTier(value.selectedModel)) return null;
  const providerId = typeof value.providerId === 'string'
    ? value.providerId.trim().slice(0, 256) || null
    : null;
  const customModelId = typeof value.customModelId === 'string'
    ? value.customModelId.trim().slice(0, 256) || null
    : null;
  return {
    providerId,
    selectedModel: normalizeModelTier(value.selectedModel),
    customModelId,
  };
}

function normalizePreferenceMap(value: unknown): PreferenceMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const next: PreferenceMap = {};
  for (const [rawSessionId, rawPreference] of Object.entries(value)) {
    const sessionId = rawSessionId.trim();
    if (!isDurableSessionId(sessionId)) continue;
    const preference = normalizePreference(
      rawPreference as Partial<ConversationRuntimePreference>,
    );
    if (preference) next[sessionId] = preference;
  }
  return next;
}

function captureCurrentPreference(): ConversationRuntimePreference {
  const settings = useSettingsStore.getState();
  const providerId = useProviderStore.getState().activeProviderId;
  return {
    providerId,
    selectedModel: normalizeModelTier(settings.selectedModel),
    customModelId: providerId ? null : settings.customModelId?.trim() || null,
  };
}

async function ensureLoaded(): Promise<void> {
  if (loadPromise) return loadPromise;
  const attempt = bridge.loadConversationRuntimePreferences()
    .then((loaded) => {
      preferences = normalizePreferenceMap(loaded);
    })
    .catch((error) => {
      console.error('[conversation-runtime] load failed:', error);
      if (loadPromise === attempt) loadPromise = null;
      throw error;
    });
  loadPromise = attempt;
  return attempt;
}

async function persistPreferences(): Promise<void> {
  const durable: PreferenceMap = {};
  for (const [sessionId, preference] of Object.entries(preferences)) {
    if (isDurableSessionId(sessionId)) durable[sessionId] = preference;
  }
  await bridge.saveConversationRuntimePreferences(durable);
}

/**
 * Record the active conversation's exact provider/key route and main model.
 * Store subscriptions call this synchronously with an already-captured thread
 * id so a rapid tab switch can never assign the choice to the next thread.
 */
export function rememberConversationRuntimePreference(
  sessionId: string | null,
  preference: ConversationRuntimePreference = captureCurrentPreference(),
): Promise<void> {
  if (!sessionId || restoringDepth > 0) return Promise.resolve();
  const normalized = normalizePreference(preference);
  if (!normalized) return Promise.resolve();

  mutationQueue = mutationQueue
    .then(async () => {
      await ensureLoaded();
      preferences[sessionId] = normalized;
      if (isDurableSessionId(sessionId)) await persistPreferences();
    })
    .catch((error) => {
      console.error('[conversation-runtime] save failed:', error);
    });
  return mutationQueue;
}

/** Seed a newly-created draft once without overwriting a choice it already owns. */
function seedConversationRuntimePreference(
  sessionId: string,
  preference: ConversationRuntimePreference = captureCurrentPreference(),
): Promise<void> {
  const normalized = normalizePreference(preference);
  if (!normalized) return Promise.resolve();
  mutationQueue = mutationQueue
    .then(async () => {
      await ensureLoaded();
      if (!preferences[sessionId]) preferences[sessionId] = normalized;
    })
    .catch((error) => {
      console.error('[conversation-runtime] draft seed failed:', error);
    });
  return mutationQueue;
}

/**
 * Restore a thread before its cached or disk transcript becomes interactive.
 * A first-seen conversation is seeded from the current global choice.
 */
export async function restoreConversationRuntimePreference(
  sessionId: string,
): Promise<boolean> {
  await mutationQueue;
  await ensureLoaded();
  const providerStore = useProviderStore.getState();
  if (!providerStore.loaded) await providerStore.load();
  if (useSessionStore.getState().selectedSessionId !== sessionId) return false;

  let preference = preferences[sessionId];
  if (!preference) {
    preference = captureCurrentPreference();
    preferences[sessionId] = preference;
    if (isDurableSessionId(sessionId)) {
      try {
        await persistPreferences();
      } catch (error) {
        console.error('[conversation-runtime] seed save failed:', error);
      }
    }
    return useSessionStore.getState().selectedSessionId === sessionId;
  }

  const providerAvailable = !preference.providerId
    || useProviderStore.getState().providers.some(
      (provider) => provider.id === preference.providerId,
    );
  const providerId = providerAvailable ? preference.providerId : null;
  if (!providerAvailable) {
    preference = { ...preference, providerId: null, customModelId: null };
    preferences[sessionId] = preference;
    if (isDurableSessionId(sessionId)) {
      try {
        await persistPreferences();
      } catch (error) {
        console.error('[conversation-runtime] provider fallback save failed:', error);
      }
    }
  }

  restoringDepth += 1;
  try {
    useProviderStore.getState().setActive(providerId);
    useSettingsStore.getState().setSelectedModel(preference.selectedModel);
    if (!providerId && preference.customModelId) {
      useSettingsStore.getState().setCustomModelId(preference.customModelId);
    }
  } finally {
    restoringDepth -= 1;
  }
  return useSessionStore.getState().selectedSessionId === sessionId;
}

/** Carry an in-memory draft choice onto Claude's durable session UUID. */
export function moveConversationRuntimePreference(
  oldSessionId: string,
  newSessionId: string,
): Promise<void> {
  mutationQueue = mutationQueue
    .then(async () => {
      await ensureLoaded();
      const preference = preferences[oldSessionId] ?? (
        useSessionStore.getState().selectedSessionId === newSessionId
          ? captureCurrentPreference()
          : undefined
      );
      delete preferences[oldSessionId];
      if (preference) preferences[newSessionId] = preference;
      if (preference && isDurableSessionId(newSessionId)) await persistPreferences();
    })
    .catch((error) => {
      console.error('[conversation-runtime] draft promotion save failed:', error);
    });
  return mutationQueue;
}

/** Remove both the in-process route and its durable metadata entry. */
export function forgetConversationRuntimePreference(sessionId: string): Promise<void> {
  mutationQueue = mutationQueue
    .then(async () => {
      await ensureLoaded();
      delete preferences[sessionId];
      if (isDurableSessionId(sessionId)) await persistPreferences();
    })
    .catch((error) => {
      console.error('[conversation-runtime] delete cleanup failed:', error);
    });
  return mutationQueue;
}

/**
 * Start exact-change tracking once. Provider hydration is ignored; later
 * provider/model mutations are explicit choices for the currently selected
 * conversation.
 */
export function initializeConversationRuntimePreferences(): void {
  if (initialized) return;
  initialized = true;
  void ensureLoaded().catch(() => {
    // The next restore or mutation retries. Never treat a failed read as an
    // authoritative empty map, because that could erase durable preferences.
  });

  useSessionStore.subscribe((state, previous) => {
    if (
      state.selectedSessionId === previous.selectedSessionId
      || !state.selectedSessionId?.startsWith('draft_')
    ) return;
    void seedConversationRuntimePreference(
      state.selectedSessionId,
      captureCurrentPreference(),
    );
  });

  useSettingsStore.subscribe((state, previous) => {
    if (
      state.selectedModel === previous.selectedModel
      && state.customModelId === previous.customModelId
    ) return;
    const sessionId = useSessionStore.getState().selectedSessionId;
    void rememberConversationRuntimePreference(sessionId, captureCurrentPreference());
  });

  useProviderStore.subscribe((state, previous) => {
    if (state.activeProviderId === previous.activeProviderId) return;
    if (!previous.loaded && state.loaded) return;
    const sessionId = useSessionStore.getState().selectedSessionId;
    void rememberConversationRuntimePreference(sessionId, captureCurrentPreference());
  });
}

export const __conversationRuntimePreferencesTesting = {
  reset: () => {
    preferences = {};
    loadPromise = null;
    mutationQueue = Promise.resolve();
    restoringDepth = 0;
  },
  flush: async () => {
    await mutationQueue;
  },
  load: async () => {
    await ensureLoaded();
  },
  snapshot: () => ({ ...preferences }),
};
