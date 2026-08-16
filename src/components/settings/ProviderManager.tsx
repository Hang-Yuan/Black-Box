import { Fragment, useEffect, useState, useCallback, useRef } from 'react';
import { hasUsableProviderCredential, useProviderStore } from '../../stores/providerStore';
import { useSettingsStore, type ModelTier } from '../../stores/settingsStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useChatStore } from '../../stores/chatStore';
import { bridge } from '../../lib/tauri-bridge';
import { useT } from '../../lib/i18n';
import { type PresetProvider } from '../../lib/provider-presets';
import { exportProvider } from '../../lib/api-config';
import { AddProviderMenu } from './AddProviderMenu';
import { ProviderCard, type CardTestStatus } from './ProviderCard';
import { ProviderForm, type TestStatus } from './ProviderForm';
import { getModelDisplayOptions, getProviderConnectionTestModel } from '../../lib/api-provider';

export function ProviderManager({ alwaysExpanded = false }: { alwaysExpanded?: boolean } = {}) {
  const t = useT();
  const providers = useProviderStore((s) => s.providers);
  const defaultApi = useProviderStore((s) => s.defaultApi);
  const defaultMainModel = useProviderStore((s) => s.defaultMainModel);
  const defaultAuxiliaryModel = useProviderStore((s) => s.defaultAuxiliaryModel);
  const activeProviderId = useProviderStore((s) => s.activeProviderId);
  const loaded = useProviderStore((s) => s.loaded);
  const selectedSessionId = useSessionStore((s) => s.selectedSessionId);
  const setActive = useProviderStore((s) => s.setActive);
  const setDefaultApi = useProviderStore((s) => s.setDefaultApi);
  const setDefaultMainModel = useProviderStore((s) => s.setDefaultMainModel);
  const setDefaultAuxiliaryModel = useProviderStore((s) => s.setDefaultAuxiliaryModel);
  const deleteProvider = useProviderStore((s) => s.deleteProvider);
  const addProvider = useProviderStore((s) => s.addProvider);

  const [collapsed, setCollapsed] = useState(alwaysExpanded ? false : true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [autoTestId, setAutoTestId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [importError, setImportError] = useState('');
  const [cardTestStatuses, setCardTestStatuses] = useState<Record<string, CardTestStatus>>({});
  const [cardTestTimes, setCardTestTimes] = useState<Record<string, number>>({});

  const addBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!loaded) {
      useProviderStore.getState().load();
    }
  }, [loaded]);

  const activeProvider = providers.find((p) => p.id === activeProviderId);
  const activeLabel = activeProvider ? activeProvider.name : t('provider.notConfigured');
  const defaultProvider = defaultApi
    ? providers.find((provider) => provider.id === defaultApi) ?? null
    : null;
  const defaultModelOptions = defaultApi
    ? getModelDisplayOptions(defaultProvider)
    : [];
  const defaultsComplete = Boolean(defaultApi && defaultMainModel && defaultAuxiliaryModel);
  const defaultProviderCredentialMissing = Boolean(
    defaultApi
    && (!defaultProvider
      || !hasUsableProviderCredential(defaultProvider)),
  );
  const defaultsRunnable = defaultsComplete && !defaultProviderCredentialMissing;

  const updateDefaultApi = (value: string) => {
    const next = value || null;
    setDefaultApi(next);
    if (!next) return;
    const nextProvider = providers.find((provider) => provider.id === next) ?? null;
    const supported = new Set(getModelDisplayOptions(nextProvider).map((option) => option.id));
    if (defaultMainModel && !supported.has(defaultMainModel)) setDefaultMainModel(null);
    if (defaultAuxiliaryModel && !supported.has(defaultAuxiliaryModel)) {
      setDefaultAuxiliaryModel(null);
    }
  };

  const applyDefaultsToCurrentConversation = useCallback(() => {
    if (!defaultsRunnable || !defaultApi || !defaultMainModel || !defaultAuxiliaryModel) return;
    setActive(defaultApi);
    useSettingsStore.getState().setSelectedModel(defaultMainModel);
    useSettingsStore.getState().setAuxiliaryModel(defaultAuxiliaryModel);
    useSettingsStore.getState().setCustomModelId(null);
  }, [defaultApi, defaultMainModel, defaultAuxiliaryModel, defaultsRunnable, setActive]);

  useEffect(() => {
    if (!defaultsRunnable || !selectedSessionId?.startsWith('draft_')) return;
    const tab = useChatStore.getState().getTab(selectedSessionId);
    if (tab?.messages.length) return;
    applyDefaultsToCurrentConversation();
  }, [applyDefaultsToCurrentConversation, defaultsRunnable, selectedSessionId]);

  const handleAddFromPreset = useCallback((preset: PresetProvider) => {
    const existingCount = providers.filter((p) => p.preset === preset.id).length;

    addProvider({
      name: existingCount > 0 ? `${preset.name} (${existingCount + 1})` : preset.name,
      baseUrl: preset.baseUrl,
      apiFormat: preset.apiFormat,
      authScheme: preset.authScheme,
      modelMappings: [
        { tier: 'fable', providerModel: preset.defaultModels?.fable || preset.defaultModels?.opus || preset.defaultModel || 'claude-fable-5' },
        { tier: 'opus', providerModel: preset.defaultModels?.opus || preset.defaultModel || 'claude-opus-4-8' },
        { tier: 'sonnet', providerModel: preset.defaultModels?.sonnet || preset.defaultModel || 'claude-sonnet-4-6' },
        { tier: 'haiku', providerModel: preset.defaultModels?.haiku || preset.defaultModel || 'claude-haiku-4-5-20251001' },
      ],
      extraEnv: { ...preset.extraEnv },
      preset: preset.id,
    });
    const { providers: updated } = useProviderStore.getState();
    const last = updated[updated.length - 1];
    if (last) {
      setActive(last.id);
      setEditingId(last.id);
    }
  }, [addProvider, providers, setActive]);

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setImportError('');
    try {
      await deleteProvider(deleteTarget);
      if (editingId === deleteTarget) setEditingId(null);
      setDeleteTarget(null);
    } catch (error) {
      setImportError(String(error));
    }
  }, [deleteTarget, editingId, deleteProvider]);

  /** Card test button: quick independent test without opening form */
  const handleCardTest = useCallback(async (providerId: string) => {
    const p = useProviderStore.getState().providers.find((pr) => pr.id === providerId);
    if (!p) return;

    setCardTestStatuses((prev) => ({ ...prev, [providerId]: 'testing' }));
    setCardTestTimes((prev) => { const next = { ...prev }; delete next[providerId]; return next; });

    const testModel = getProviderConnectionTestModel(p.modelMappings);
    if (!testModel || (!p.apiKey && (!p.credentialState || p.credentialState === 'missing'))) {
      setCardTestStatuses((prev) => ({ ...prev, [providerId]: 'failed' }));
      return;
    }

    try {
      const start = Date.now();
      const result = await bridge.testProviderConnection(
        p.baseUrl,
        p.apiFormat,
        p.apiKey || undefined,
        testModel,
        p.proxyUrl || undefined,
        p.id,
        p.authScheme,
      );
      const elapsed = Date.now() - start;

      if (result.connectivity.ok && result.auth.ok && result.model.ok) {
        setCardTestStatuses((prev) => ({ ...prev, [providerId]: 'success' }));
        setCardTestTimes((prev) => ({ ...prev, [providerId]: elapsed }));
      } else if (!result.auth.ok && result.connectivity.ok) {
        setCardTestStatuses((prev) => ({ ...prev, [providerId]: 'auth_error' }));
      } else {
        setCardTestStatuses((prev) => ({ ...prev, [providerId]: 'failed' }));
      }
    } catch (e) {
      setCardTestStatuses((prev) => ({ ...prev, [providerId]: 'failed' }));
    }
  }, []);


  /** Export from card */
  const handleCardExport = useCallback(async (providerId: string) => {
    const p = useProviderStore.getState().providers.find((pr) => pr.id === providerId);
    if (!p) return;
    try {
      const json = exportProvider(p);
      const { save: saveDialog } = await import('@tauri-apps/plugin-dialog');
      const filePath = await saveDialog({
        title: t('provider.exportTitle'),
        defaultPath: `${p.name || 'provider'}-config.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (!filePath) return;
      const exportTabId = useSessionStore.getState().selectedSessionId;
      if (exportTabId) {
        await bridge.addPathGrant(exportTabId, filePath).catch(() => {});
      }
      await bridge.writeFileContent(filePath, json, exportTabId || undefined);
    } catch (e) {
      console.error('Export failed:', e);
    }
  }, [t]);

  const isExpanded = alwaysExpanded || !collapsed;
  return (
    <div className={alwaysExpanded ? '' : 'pt-2 border-t border-border-subtle'}>
      {/* Header */}
      {!alwaysExpanded && (
        <div className="flex items-center justify-between mb-2">
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="flex items-center gap-1.5"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none"
              stroke="currentColor" strokeWidth="1.5"
              className={`text-text-tertiary transition-transform ${collapsed ? '' : 'rotate-90'}`}>
              <path d="M3 1l4 4-4 4" />
            </svg>
            <h3 className="text-[13px] font-medium text-text-primary">
              {t('provider.title')}
            </h3>
            <span className="text-xs text-text-tertiary">
              {activeLabel}
            </span>
          </button>
        </div>
      )}

      {isExpanded && (
        <div className="space-y-3 ml-0">
          <div className="rounded-md border border-accent/25 bg-accent/5 px-3 py-2 text-[12px] leading-5 text-text-muted">
            {t('provider.fixedCatalogNotice')}
          </div>

          <section
            data-testid="default-system-configuration"
            className="rounded-lg border border-accent/25 bg-accent/5 p-3"
          >
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <h4 className="text-[13px] font-medium text-text-primary">
                  {t('provider.systemDefaults')}
                </h4>
                <p className="mt-0.5 text-[11px] leading-5 text-text-tertiary">
                  {t('provider.systemDefaultsDesc')}
                </p>
              </div>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px]
                ${!defaultsComplete
                  ? 'bg-amber-500/10 text-amber-400'
                  : defaultProviderCredentialMissing
                    ? 'bg-red-500/10 text-red-400'
                    : 'bg-green-500/10 text-green-400'}`}
              >
                {!defaultsComplete
                  ? t('provider.notConfigured')
                  : defaultProviderCredentialMissing
                    ? t('provider.unavailable')
                    : t('provider.configured')}
              </span>
            </div>

            <div className="grid gap-2 md:grid-cols-3">
              <label className="space-y-1">
                <span className="text-[11px] text-text-muted">{t('provider.defaultApi')}</span>
                <select
                  data-testid="default-system-api"
                  value={defaultApi ?? ''}
                  onChange={(event) => updateDefaultApi(event.target.value)}
                  className="w-full rounded-md border border-border-subtle bg-bg-primary px-2 py-1.5
                    text-[12px] text-text-primary outline-none focus:border-accent/50"
                >
                  <option value="">{t('provider.chooseDefault')}</option>
                  {providers.map((provider) => {
                    const available = hasUsableProviderCredential(provider);
                    return (
                    <option key={provider.id} value={provider.id} disabled={!available}>
                      {provider.name || t('provider.unnamed')}
                    </option>
                    );
                  })}
                </select>
              </label>

              <label className="space-y-1">
                <span className="text-[11px] text-text-muted">{t('provider.defaultMainModel')}</span>
                <select
                  data-testid="default-main-model"
                  value={defaultMainModel ?? ''}
                  disabled={!defaultApi}
                  onChange={(event) => setDefaultMainModel(
                    (event.target.value || null) as ModelTier | null,
                  )}
                  className="w-full rounded-md border border-border-subtle bg-bg-primary px-2 py-1.5
                    text-[12px] text-text-primary outline-none focus:border-accent/50
                    disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <option value="">{t('provider.chooseDefault')}</option>
                  {defaultModelOptions.map((option) => (
                    <option key={option.id} value={option.id}>{option.label}</option>
                  ))}
                </select>
              </label>

              <label className="space-y-1">
                <span className="text-[11px] text-text-muted">
                  {t('provider.defaultAuxiliaryModel')}
                </span>
                <select
                  data-testid="default-auxiliary-model"
                  value={defaultAuxiliaryModel ?? ''}
                  disabled={!defaultApi}
                  onChange={(event) => setDefaultAuxiliaryModel(
                    (event.target.value || null) as ModelTier | null,
                  )}
                  className="w-full rounded-md border border-border-subtle bg-bg-primary px-2 py-1.5
                    text-[12px] text-text-primary outline-none focus:border-accent/50
                    disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <option value="">{t('provider.chooseDefault')}</option>
                  {defaultModelOptions.map((option) => (
                    <option key={option.id} value={option.id}>{option.label}</option>
                  ))}
                </select>
              </label>
            </div>

            {defaultProviderCredentialMissing && (
              <p className="mt-2 rounded-md bg-red-500/5 px-2 py-1.5 text-[10px] text-red-400">
                {t('provider.defaultApiCredentialMissing')}
              </p>
            )}

            <div className="mt-3 flex items-center justify-between gap-3">
              <span className="text-[10px] leading-4 text-text-tertiary">
                {t('provider.currentConversationOverrideHint')}
              </span>
              <button
                type="button"
                disabled={!defaultsRunnable}
                onClick={applyDefaultsToCurrentConversation}
                className="shrink-0 rounded-md border border-border-subtle px-2.5 py-1 text-[11px]
                  text-text-muted transition-smooth hover:bg-bg-secondary hover:text-text-primary
                  disabled:cursor-not-allowed disabled:opacity-40"
              >
                {t('provider.applyDefaultsToConversation')}
              </button>
            </div>
          </section>

          {/* Provider cards + inline forms */}
          <div className="space-y-1.5">
            {providers.map((p) => (
              <Fragment key={p.id}>
                <ProviderCard
                  provider={p}
                  isActive={activeProviderId === p.id}
                  isEditing={editingId === p.id}
                  testStatus={cardTestStatuses[p.id] || 'idle'}
                  testTimeMs={cardTestTimes[p.id]}
                  onActivate={() => setActive(p.id)}
                  onToggleEdit={() => { setEditingId(editingId === p.id ? null : p.id); setAutoTestId(null); }}
                  onRequestDelete={() => setDeleteTarget(p.id)}
                  onExport={() => handleCardExport(p.id)}
                  onTest={() => handleCardTest(p.id)}
                />

                {/* Delete confirmation inline */}
                {deleteTarget === p.id && (
                  <div className="flex items-center gap-2 p-2 bg-red-500/5 border border-red-500/20 rounded-md text-xs ml-5">
                    <span className="text-red-400 flex-1">
                      {t('provider.deleteConfirm').replace('{name}', p.name || t('provider.unnamed'))}
                    </span>
                    <button
                      onClick={handleConfirmDelete}
                      className="text-red-400 font-medium hover:text-red-300 transition-smooth px-2 py-0.5"
                    >
                      {t('provider.deleteProvider')}
                    </button>
                    <button
                      onClick={() => setDeleteTarget(null)}
                      className="text-text-tertiary hover:text-text-muted transition-smooth px-2 py-0.5"
                    >
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none"
                        stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                        <path d="M2 2l6 6M8 2l-6 6" />
                      </svg>
                    </button>
                  </div>
                )}

                {/* Inline edit form */}
                {editingId === p.id && (
                  <ProviderForm
                    provider={p}
                    onClose={() => { setEditingId(null); setAutoTestId(null); }}
                    onDelete={() => setDeleteTarget(p.id)}
                    autoTest={autoTestId === p.id}
                    onTestStatusChange={(status: TestStatus) =>
                      setCardTestStatuses((prev) => ({ ...prev, [p.id]: status as CardTestStatus }))
                    }
                  />
                )}
              </Fragment>
            ))}
          </div>

          {/* Add button */}
          <div className="flex items-center gap-2">
            <button
              ref={addBtnRef}
              onClick={() => setMenuOpen(!menuOpen)}
              className="px-3 py-2 rounded-md text-[13px] font-medium transition-smooth
                border border-border-subtle text-text-muted hover:bg-bg-secondary
                flex items-center gap-1.5"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
                stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <path d="M6 1v10M1 6h10" />
              </svg>
              {t('provider.addProvider')}
            </button>

            {importError && (
              <span className="text-xs text-red-400 truncate flex-1" title={importError}>
                {importError}
              </span>
            )}
          </div>

          <AddProviderMenu
            open={menuOpen}
            onClose={() => setMenuOpen(false)}
            anchorRef={addBtnRef}
            providers={providers}
            onAddFromPreset={handleAddFromPreset}
          />
        </div>
      )}
    </div>
  );
}
