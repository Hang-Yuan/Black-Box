import { useEffect, useState, useCallback, useRef } from 'react';
import { useProviderStore, type ApiProvider, type ModelMapping } from '../../stores/providerStore';
import { bridge, type ConnectionTestResult } from '../../lib/tauri-bridge';
import { useT } from '../../lib/i18n';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  PROVIDER_PRESETS,
  inferProviderAuthScheme,
  type ProviderApiFormat,
} from '../../lib/provider-presets';
import { getProviderConnectionTestModel } from '../../lib/api-provider';
import { getOfficialClaudeContextWindow } from '../../lib/model-context-window';
import {
  CLAUDE_MODEL_TIERS,
  mergeDiscoveredClaudeMappings,
  selectHighestClaudeModels,
} from '../../lib/provider-model-discovery';

const MODEL_TIERS: { tier: 'fable' | 'opus' | 'sonnet' | 'haiku'; labelKey: string; placeholderKey: string }[] = [
  { tier: 'fable', labelKey: 'provider.fableModel', placeholderKey: 'provider.fablePlaceholder' },
  { tier: 'opus', labelKey: 'provider.opusModel', placeholderKey: 'provider.opusPlaceholder' },
  { tier: 'sonnet', labelKey: 'provider.sonnetModel', placeholderKey: 'provider.sonnetPlaceholder' },
  { tier: 'haiku', labelKey: 'provider.haikuModel', placeholderKey: 'provider.haikuPlaceholder' },
];

const INPUT_BASE_CLASS = 'px-3 py-2 text-[13px] bg-bg-chat border border-border-subtle rounded-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent';
const INPUT_CLASS = `w-full ${INPUT_BASE_CLASS}`;

export function parseContextWindowInput(value: string): number | undefined {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*([km])?$/i);
  if (!match) return undefined;
  const multiplier = match[2]?.toLowerCase() === 'm'
    ? 1_000_000
    : match[2]?.toLowerCase() === 'k'
      ? 1_000
      : 1;
  const tokens = Math.round(Number(match[1]) * multiplier);
  return Number.isInteger(tokens) && tokens >= 1_024 && tokens <= 10_000_000
    ? tokens
    : undefined;
}

/* SVG eye icons */
function EyeOpenIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z" />
      <circle cx="8" cy="8" r="2" />
    </svg>
  );
}

function EyeClosedIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z" />
      <circle cx="8" cy="8" r="2" />
      <path d="M2 14L14 2" />
    </svg>
  );
}

export type TestStatus = 'idle' | 'testing' | 'success' | 'auth_error' | 'failed';
type DiscoveryStatus = 'idle' | 'discovering' | 'success' | 'failed';

interface ProviderFormProps {
  provider: ApiProvider;
  onClose: () => void;
  onDelete: () => void;
  autoTest?: boolean;
  onTestStatusChange?: (status: TestStatus) => void;
}

export function ProviderForm({ provider, onClose, onDelete, autoTest, onTestStatusChange }: ProviderFormProps) {
  const t = useT();
  const updateProvider = useProviderStore((s) => s.updateProvider);
  const flushSave = useProviderStore((s) => s.flushSave);
  const clearProviderCredential = useProviderStore((s) => s.clearProviderCredential);

  const [name, setName] = useState(provider.name);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  const [apiFormat, setApiFormat] = useState(provider.apiFormat);
  const [apiKey, setApiKey] = useState(provider.apiKey || '');
  const [showKey, setShowKey] = useState(false);
  const [proxyUrl, setProxyUrl] = useState(provider.proxyUrl || '');
  const [mappings, setMappings] = useState<ModelMapping[]>(provider.modelMappings);
  const [contextInputs, setContextInputs] = useState<Record<string, string>>(() => Object.fromEntries(
    provider.modelMappings.map((mapping) => [
      mapping.tier,
      mapping.contextWindowTokens ? String(mapping.contextWindowTokens) : '',
    ]),
  ));
  const [extraEnv, setExtraEnv] = useState<Record<string, string>>(provider.extraEnv || {});
  const [testStatus, _setTestStatus] = useState<TestStatus>('idle');
  const [_testError, setTestError] = useState('');
  const [testTimeMs, setTestTimeMs] = useState<number | null>(null);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
  const [clearKeyConfirm, setClearKeyConfirm] = useState(false);
  const [credentialError, setCredentialError] = useState('');
  const [discoveryStatus, setDiscoveryStatus] = useState<DiscoveryStatus>('idle');
  const [discoveryMessage, setDiscoveryMessage] = useState('');

  const setTestStatus = useCallback((status: TestStatus) => {
    _setTestStatus(status);
    onTestStatusChange?.(status);
  }, [onTestStatusChange]);

  useEffect(() => {
    return () => {
      void flushSave().catch((error) => {
        console.error('[ProviderForm] failed to flush provider changes:', error);
      });
    };
  }, [flushSave]);

  const autoSave = useCallback((patch: Partial<ApiProvider>) => {
    // Reset test status on any field change
    setTestStatus('idle');
    setTestError('');
    setTestTimeMs(null);
    // Update the in-memory provider immediately so consecutive edits to
    // different fields cannot cancel each other. providerStore coalesces the
    // disk write, and the unmount cleanup above flushes it before the form is
    // closed or another provider is opened.
    updateProvider(provider.id, patch);
  }, [provider.id, updateProvider]);

  const handleNameChange = (v: string) => { setName(v); autoSave({ name: v }); };
  const handleBaseUrlChange = (v: string) => { setBaseUrl(v); autoSave({ baseUrl: v }); };
  const handleApiKeyChange = (v: string) => { setApiKey(v); autoSave({ apiKey: v || undefined }); };
  const handleProxyUrlChange = (v: string) => { setProxyUrl(v); autoSave({ proxyUrl: v || undefined }); };
  const handleApiFormatChange = (v: ProviderApiFormat) => {
    setApiFormat(v);
    autoSave({
      apiFormat: v,
      authScheme: inferProviderAuthScheme({ apiFormat: v, preset: provider.preset }),
    });
  };

  const FIXED_TIERS = new Set(['fable', 'opus', 'sonnet', 'haiku']);

  const getMapping = (tier: string): string => {
    return mappings.find((m) => m.tier === tier)?.providerModel || '';
  };

  const getContextWindow = (tier: string): string => {
    return contextInputs[tier] ?? '';
  };

  const getOfficialContextWindow = (modelId: string): number | undefined => (
    getOfficialClaudeContextWindow(modelId)
  );

  const updateMapping = (tier: string, value: string) => {
    const current = mappings.find((m) => m.tier === tier);
    const updated = mappings.filter((m) => m.tier !== tier);
    if (value) {
      updated.push({ ...current, tier, providerModel: value });
    }
    setMappings(updated);
    autoSave({ modelMappings: updated });
  };

  const commitMappingContext = (tier: string) => {
    const raw = contextInputs[tier] ?? '';
    const parsed = raw.trim() ? parseContextWindowInput(raw) : undefined;
    if (raw.trim() && parsed === undefined) {
      const previous = mappings.find((mapping) => mapping.tier === tier)?.contextWindowTokens;
      setContextInputs((current) => ({ ...current, [tier]: previous ? String(previous) : '' }));
      return;
    }
    const updated = mappings.map((mapping) => (
      mapping.tier === tier
        ? {
            ...mapping,
            contextWindowTokens: parsed,
          }
        : mapping
    ));
    setContextInputs((current) => ({ ...current, [tier]: parsed ? String(parsed) : '' }));
    setMappings(updated);
    autoSave({ modelMappings: updated });
  };

  const extraMappings = mappings.filter((m) => !FIXED_TIERS.has(m.tier));

  const addExtraMapping = () => {
    const updated = [...mappings, { tier: '', providerModel: '' }];
    setMappings(updated);
    autoSave({ modelMappings: updated });
  };

  /** Update extra model: tier and providerModel are always the same value */
  const updateExtraModel = (oldTier: string, modelName: string) => {
    const updated = mappings.map((m) =>
      m.tier === oldTier && !FIXED_TIERS.has(m.tier) ? { ...m, tier: modelName, providerModel: modelName } : m,
    );
    setContextInputs((current) => {
      const next = { ...current, [modelName]: current[oldTier] ?? '' };
      if (oldTier !== modelName) delete next[oldTier];
      return next;
    });
    setMappings(updated);
    autoSave({ modelMappings: updated });
  };

  const removeExtraMapping = (tier: string) => {
    const updated = mappings.filter((m) => m.tier !== tier || FIXED_TIERS.has(m.tier));
    setMappings(updated);
    autoSave({ modelMappings: updated });
  };

  const handleExtraEnvChange = (key: string, value: string) => {
    const updated = { ...extraEnv, [key]: value };
    setExtraEnv(updated);
    autoSave({ extraEnv: updated });
  };

  const handleExtraEnvRemove = (key: string) => {
    const updated = { ...extraEnv };
    delete updated[key];
    setExtraEnv(updated);
    autoSave({ extraEnv: updated });
  };

  const handleExtraEnvAdd = () => {
    const key = `NEW_VAR_${Object.keys(extraEnv).length}`;
    setExtraEnv({ ...extraEnv, [key]: '' });
  };

  const discoverHighestModels = useCallback(async (): Promise<ModelMapping[] | null> => {
    if (!apiKey && (!provider.credentialState || provider.credentialState === 'missing')) {
      setDiscoveryStatus('failed');
      setDiscoveryMessage(t('provider.testNoKey'));
      return null;
    }

    setDiscoveryStatus('discovering');
    setDiscoveryMessage('');
    try {
      const modelIds = await bridge.discoverProviderModels(
        baseUrl,
        apiFormat,
        apiKey || undefined,
        proxyUrl || undefined,
        provider.id,
        provider.authScheme,
      );
      const discovered = selectHighestClaudeModels(modelIds);
      const foundTiers = CLAUDE_MODEL_TIERS.filter((tier) => discovered[tier]);
      if (foundTiers.length === 0) {
        setDiscoveryStatus('failed');
        setDiscoveryMessage(t('provider.modelDiscoveryNoClaude'));
        return null;
      }

      const persistedMappings = useProviderStore.getState().providers
        .find((candidate) => candidate.id === provider.id)?.modelMappings ?? mappings;
      const updated = mergeDiscoveredClaudeMappings(persistedMappings, discovered);
      setMappings(updated);
      setContextInputs((current) => {
        const next = { ...current };
        for (const tier of foundTiers) next[tier] = '';
        return next;
      });
      updateProvider(provider.id, { modelMappings: updated });
      await flushSave();
      setDiscoveryStatus('success');
      setDiscoveryMessage(foundTiers
        .map((tier) => `${tier[0].toUpperCase()}${tier.slice(1)}: ${discovered[tier]}`)
        .join(' · '));
      return updated;
    } catch (error) {
      setDiscoveryStatus('failed');
      setDiscoveryMessage(`${t('provider.modelDiscoveryFailed')}: ${String(error)}`);
      return null;
    }
  }, [apiFormat, apiKey, baseUrl, flushSave, mappings, provider.authScheme, provider.credentialState, provider.id, proxyUrl, t, updateProvider]);

  const handleTestConnection = useCallback(async () => {
    setTestStatus('testing');
    setTestError('');
    setTestTimeMs(null);
    setTestResult(null);
    try {
      if (!apiKey && (!provider.credentialState || provider.credentialState === 'missing')) {
        setTestStatus('failed');
        setTestError(t('provider.testNoKey'));
        return;
      }
      const discoveredMappings = await discoverHighestModels();
      const testModel = getProviderConnectionTestModel(discoveredMappings ?? mappings);
      if (!testModel) {
        setTestStatus('failed');
        setTestError(t('provider.testNoModel'));
        return;
      }
      const start = Date.now();
      const result = await bridge.testProviderConnection(
        baseUrl,
        apiFormat,
        apiKey || undefined,
        testModel,
        proxyUrl || undefined,
        provider.id,
        provider.authScheme,
      );
      const elapsed = Date.now() - start;
      setTestResult(result);
      setTestTimeMs(elapsed);
      if (result.connectivity.ok && result.auth.ok && result.model.ok) {
        setTestStatus('success');
      } else if (!result.auth.ok && result.connectivity.ok) {
        setTestStatus('auth_error');
        setTestError(result.auth.message);
      } else {
        setTestStatus('failed');
        const failedStep = !result.connectivity.ok ? result.connectivity : result.model;
        setTestError(failedStep.message);
      }
    } catch (e) {
      setTestStatus('failed');
      setTestError(String(e));
    }
  }, [baseUrl, apiFormat, apiKey, discoverHighestModels, mappings, provider.authScheme, provider.credentialState, provider.id, proxyUrl, t]);

  // Auto-trigger test when opened via card test button
  const autoTestDone = useRef(false);
  useEffect(() => {
    if (autoTest && !autoTestDone.current) {
      autoTestDone.current = true;
      handleTestConnection();
    }
  }, [autoTest, handleTestConnection]);

  return (
    <div className="p-4 rounded-lg border border-border-subtle bg-bg-secondary/50 space-y-3 ml-5">
      {/* Form header */}
      <div className="flex items-center justify-between">
        <h4 className="text-[13px] font-medium text-text-primary">{t('provider.editProvider')}</h4>
        <div className="flex items-center gap-1">
          <button onClick={onDelete}
            className="px-2 py-1 rounded text-xs text-red-400 hover:text-red-300 transition-smooth">
            {t('provider.deleteProvider')}
          </button>
          <button onClick={onClose}
            className="px-2 py-1 rounded text-xs text-text-tertiary hover:text-text-muted transition-smooth">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none"
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M2 2l6 6M8 2l-6 6" />
            </svg>
          </button>
        </div>
      </div>

      {/* Test Connection — at the top */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <button
            onClick={handleTestConnection}
            disabled={!baseUrl || testStatus === 'testing'}
            className={`px-3 py-2 rounded-md text-[13px] font-medium transition-smooth
              border border-border-subtle
              ${testStatus === 'success'
                ? 'bg-green-500/10 text-green-500 border-green-500/30'
                : testStatus === 'failed' || testStatus === 'auth_error'
                  ? 'bg-red-500/10 text-red-500 border-red-500/30'
                  : 'text-text-muted hover:bg-bg-secondary'
              }
              disabled:opacity-40 disabled:cursor-not-allowed`}
          >
            {testStatus === 'testing' ? (
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 border-[1.5px] border-accent/30
                  border-t-accent rounded-full animate-spin" />
                {t('provider.testing')}
              </span>
            ) : (
              t('provider.testConnection')
            )}
          </button>
          {testTimeMs != null && testStatus !== 'testing' && (
            <span className="text-xs text-text-tertiary">{testTimeMs}ms</span>
          )}
        </div>
        {testResult && (
          <div className="space-y-0.5 text-xs">
            {([
              { key: 'connectivity' as const, label: t('provider.testConnectivity') },
              { key: 'auth' as const, label: t('provider.testAuth') },
              { key: 'model' as const, label: t('provider.testModel') },
            ]).map(({ key, label }) => {
              const step = testResult[key];
              const isSkipped = step.message === 'Skipped';
              return (
                <div key={key} className="flex items-center gap-1.5">
                  {step.ok ? (
                    <svg width="10" height="10" viewBox="0 0 16 16" fill="none"
                      stroke="rgb(34 197 94)" strokeWidth="2" strokeLinecap="round">
                      <path d="M3 8l4 4 6-7" />
                    </svg>
                  ) : isSkipped ? (
                    <span className="w-2.5 h-2.5 rounded-full bg-text-tertiary/30" />
                  ) : (
                    <svg width="10" height="10" viewBox="0 0 16 16" fill="none"
                      stroke="rgb(239 68 68)" strokeWidth="2" strokeLinecap="round">
                      <path d="M4 4l8 8M12 4l-8 8" />
                    </svg>
                  )}
                  <span className={step.ok ? 'text-green-500' : isSkipped ? 'text-text-tertiary' : 'text-red-400'}>
                    {label}
                  </span>
                  {!step.ok && !isSkipped && (
                    <span className="text-red-400/70 truncate flex-1" title={step.message}>
                      — {step.message}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Name */}
      <div>
        <label className="text-xs text-text-muted mb-1 block">{t('provider.providerName')}</label>
        <input className={INPUT_CLASS} value={name}
          onChange={(e) => handleNameChange(e.target.value)}
          placeholder={t('provider.providerNamePlaceholder')} />
      </div>

      {/* Base URL */}
      <div>
        <label className="text-xs text-text-muted mb-1 block">{t('provider.baseUrl')}</label>
        <input className={INPUT_CLASS} value={baseUrl}
          onChange={(e) => handleBaseUrlChange(e.target.value)}
          placeholder={t('provider.baseUrlPlaceholder')} />
      </div>

      {/* API protocol */}
      <div>
        <label className="text-xs text-text-muted mb-1 block">{t('provider.format')}</label>
        <select
          className={INPUT_CLASS}
          value={apiFormat}
          onChange={(event) => handleApiFormatChange(event.target.value as ProviderApiFormat)}
        >
          <option value="anthropic">{t('provider.formatAnthropic')}</option>
          <option value="openai">{t('provider.formatOpenai')}</option>
          <option value="gemini">{t('provider.formatGemini')}</option>
        </select>
        <p className="mt-1 text-[11px] leading-4 text-text-tertiary">
          {t('provider.formatHint')}
        </p>
      </div>

      {/* API Key */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-xs text-text-muted">{t('provider.apiKey')}</label>
          {provider.preset && (() => {
            const keyUrl = PROVIDER_PRESETS.find(p => p.id === provider.preset)?.keyUrl;
            return keyUrl ? (
              <button onClick={() => openUrl(keyUrl)}
                className="text-xs text-accent hover:underline">
                {t('provider.getApiKey')}
              </button>
            ) : null;
          })()}
        </div>
        <div className="flex gap-1.5">
          <input
            className={`${INPUT_CLASS} flex-1`}
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => handleApiKeyChange(e.target.value)}
            placeholder={provider.credentialHint || t('provider.apiKeyPlaceholder')}
          />
          <button onClick={() => setShowKey(!showKey)}
            className="px-2 py-1.5 rounded-md border border-border-subtle
              text-text-muted hover:bg-bg-secondary transition-smooth flex items-center justify-center">
            {showKey ? <EyeClosedIcon /> : <EyeOpenIcon />}
          </button>
        </div>
        {provider.credentialState === 'local_file' && (
          <p className="mt-1 text-xs text-success">{t('provider.keyStoredLocally')}</p>
        )}
        {provider.credentialState && provider.credentialState !== 'missing' && (
          <div className="mt-1.5 flex items-center gap-2">
            <button
              type="button"
              onClick={async () => {
                if (!clearKeyConfirm) {
                  setClearKeyConfirm(true);
                  return;
                }
                setCredentialError('');
                try {
                  await clearProviderCredential(provider.id);
                  setApiKey('');
                  setClearKeyConfirm(false);
                } catch (error) {
                  setCredentialError(String(error));
                }
              }}
              className="text-xs text-error/80 hover:text-error"
            >
              {clearKeyConfirm ? t('provider.confirmRemoveKey') : t('provider.removeStoredKey')}
            </button>
            {clearKeyConfirm && (
              <button
                type="button"
                onClick={() => setClearKeyConfirm(false)}
                className="text-xs text-text-tertiary hover:text-text-primary"
              >
                {t('common.cancel')}
              </button>
            )}
          </div>
        )}
        {credentialError && <p className="mt-1 text-xs text-error">{credentialError}</p>}
      </div>

      {/* Proxy URL */}
      <div>
        <label className="text-xs text-text-muted mb-1 block">{t('provider.proxyUrl')}</label>
        <input className={INPUT_CLASS} value={proxyUrl}
          onChange={(e) => handleProxyUrlChange(e.target.value)}
          placeholder={t('provider.proxyUrlPlaceholder')} />
        <p className="text-xs text-text-tertiary mt-1">{t('provider.proxyUrlHint')}</p>
      </div>

      {/* Model Mappings */}
      <div>
        <div className="mb-1 flex items-center justify-between gap-3">
          <label className="text-xs text-text-muted">{t('provider.modelMappings')}</label>
          <button
            type="button"
            onClick={() => { void discoverHighestModels(); }}
            disabled={!baseUrl || discoveryStatus === 'discovering' || testStatus === 'testing'}
            className="shrink-0 text-xs text-accent hover:underline disabled:cursor-not-allowed disabled:opacity-40"
          >
            {discoveryStatus === 'discovering'
              ? t('provider.modelDiscoveryRunning')
              : t('provider.modelDiscoveryAction')}
          </button>
        </div>
        <p className="text-xs text-text-tertiary mb-1.5">{t('provider.modelMappingsHint')}</p>
        {discoveryMessage && (
          <p className={`mb-1.5 break-words text-xs ${
            discoveryStatus === 'success' ? 'text-green-500' : 'text-amber-400'
          }`}>
            {discoveryMessage}
          </p>
        )}
        <div className="space-y-1.5">
          {MODEL_TIERS.map(({ tier, labelKey, placeholderKey }, index) => {
            const officialContextWindow = getOfficialContextWindow(getMapping(tier));
            return (
            <div key={tier} className="flex items-center gap-2">
              <span className="text-xs text-text-muted w-14 shrink-0">
                {provider.preset === 'anthropic' ? t(labelKey) : `${t('provider.modelChoice')} ${index + 1}`}
              </span>
              <input className={`flex-1 min-w-0 ${INPUT_BASE_CLASS}`}
                value={getMapping(tier)}
                onChange={(e) => updateMapping(tier, e.target.value)}
                placeholder={t(placeholderKey)} />
              <input className={`w-32 shrink-0 ${INPUT_BASE_CLASS}`}
                value={officialContextWindow ? String(officialContextWindow) : getContextWindow(tier)}
                inputMode="decimal"
                disabled={officialContextWindow !== undefined}
                onChange={(e) => setContextInputs((current) => ({ ...current, [tier]: e.target.value }))}
                onBlur={() => commitMappingContext(tier)}
                placeholder={t('provider.contextWindowAuto')}
                title={officialContextWindow
                  ? t('provider.contextWindowOfficial')
                  : t('provider.contextWindowHint')} />
            </div>
            );
          })}
          {extraMappings.map((m, i) => {
            const officialContextWindow = getOfficialContextWindow(m.providerModel);
            return (
            <div key={`extra-${i}`} className="flex items-center gap-1.5">
              <input className="flex-1 min-w-0 px-3 py-2 text-[13px] bg-bg-chat border border-border-subtle rounded-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent font-mono"
                value={m.providerModel}
                onChange={(e) => updateExtraModel(m.tier, e.target.value)}
                placeholder={t('provider.extraModelPlaceholder')} />
              <input className={`w-32 shrink-0 ${INPUT_BASE_CLASS}`}
                value={officialContextWindow ? String(officialContextWindow) : getContextWindow(m.tier)}
                inputMode="decimal"
                disabled={officialContextWindow !== undefined}
                onChange={(e) => setContextInputs((current) => ({ ...current, [m.tier]: e.target.value }))}
                onBlur={() => commitMappingContext(m.tier)}
                placeholder={t('provider.contextWindowAuto')}
                title={officialContextWindow
                  ? t('provider.contextWindowOfficial')
                  : t('provider.contextWindowHint')} />
              <button onClick={() => removeExtraMapping(m.tier)}
                className="text-text-tertiary hover:text-text-primary transition-smooth shrink-0 p-0.5">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
                  stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <path d="M4 4l8 8M12 4l-8 8" />
                </svg>
              </button>
            </div>
            );
          })}
          <button onClick={addExtraMapping}
            className="flex items-center gap-1 text-xs text-text-tertiary hover:text-text-muted transition-smooth mt-1">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M8 3v10M3 8h10" />
            </svg>
            {t('provider.addModelMapping')}
          </button>
        </div>
      </div>

      {/* Extra Env */}
      <div>
        <label className="text-xs text-text-muted mb-1 block">{t('provider.extraEnv')}</label>
        <p className="text-xs text-text-tertiary mb-1.5">{t('provider.extraEnvHint')}</p>
        <div className="space-y-1">
          {Object.entries(extraEnv).map(([key, value]) => (
            <div key={key} className="flex items-center gap-1">
              <input className={`${INPUT_CLASS} w-[140px] shrink-0`}
                value={key}
                onChange={(e) => {
                  const newEnv = { ...extraEnv };
                  delete newEnv[key];
                  newEnv[e.target.value] = value;
                  setExtraEnv(newEnv);
                  autoSave({ extraEnv: newEnv });
                }}
                placeholder="KEY" />
              <span className="text-xs text-text-tertiary">=</span>
              <input className={`${INPUT_CLASS} flex-1`}
                value={value}
                onChange={(e) => handleExtraEnvChange(key, e.target.value)}
                placeholder={t('provider.extraEnvValuePlaceholder')} />
              <button onClick={() => handleExtraEnvRemove(key)}
                className="p-1 text-text-tertiary hover:text-red-400 transition-smooth">
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none"
                  stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <path d="M2 2l6 6M8 2l-6 6" />
                </svg>
              </button>
            </div>
          ))}
          <button onClick={handleExtraEnvAdd}
            className="text-xs text-accent hover:text-accent/80 transition-smooth">
            + {t('provider.addEnvVar')}
          </button>
        </div>
      </div>
    </div>
  );
}
