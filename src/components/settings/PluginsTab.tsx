import { useEffect, useMemo, useState } from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import { usePluginStore } from '../../stores/pluginStore';
import { useT } from '../../lib/i18n';
import type {
  PluginDiagnosticRecord,
  PluginDiagnosticsReport,
  PluginRecord,
  PluginScope,
} from '../../lib/tauri-bridge';
import {
  compareCatalogPlugins,
  formatInstallCount,
  pluginAudience,
  pluginCategory,
  pluginHue,
  pluginInitials,
  searchablePluginText,
  type PluginAudience,
} from '../../lib/plugin-catalog';

const ACTION = 'rounded-md border border-border-subtle px-2.5 py-1.5 text-[11px] font-medium text-text-muted transition-smooth hover:bg-bg-secondary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40';

function pluginInstanceKey(plugin: PluginRecord): string {
  return `${plugin.id}:${plugin.scope || 'available'}`;
}

function diagnosticInstanceKey(plugin: PluginDiagnosticRecord): string {
  return `${plugin.pluginId}:${plugin.scope || 'unknown'}`;
}

function formatDiagnosticBytes(bytes: number | null): string {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function DiagnosticStatus({ value, kind }: { value: string; kind: 'validation' | 'source' | 'signature' }) {
  const t = useT();
  const danger = value === 'failed' || value === 'differentRevision';
  const success = value === 'passed' || value === 'matched' || value === 'local';
  const tone = danger
    ? 'border-red-500/25 bg-red-500/5 text-red-400'
    : success
      ? 'border-emerald-500/25 bg-emerald-500/5 text-emerald-500'
      : 'border-border-subtle bg-bg-tertiary/60 text-text-muted';
  return (
    <span className={`rounded-full border px-2 py-0.5 text-[9px] font-medium ${tone}`}>
      {t(`plugins.diagnostics.${kind}.${value}`)}
    </span>
  );
}

function PluginDiagnosticsPanel({
  report,
  loading,
  error,
  onRun,
}: {
  report: PluginDiagnosticsReport | null;
  loading: boolean;
  error: string;
  onRun: () => void;
}) {
  const t = useT();
  return (
    <section
      className="space-y-3 rounded-2xl border border-border-subtle bg-bg-secondary/20 p-4"
      data-testid="plugin-security-diagnostics"
      data-diagnostics-ready={report ? 'true' : 'false'}
      data-plugin-count={report?.plugins.length ?? 0}
      data-conflict-count={report?.conflicts.length ?? 0}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-[13px] font-semibold text-text-primary">{t('plugins.diagnostics.title')}</h3>
          <p className="mt-1 max-w-2xl text-[10px] leading-4 text-text-tertiary">{t('plugins.diagnostics.description')}</p>
        </div>
        <button className={ACTION} onClick={onRun} disabled={loading} data-testid="run-plugin-diagnostics">
          {loading ? t('plugins.diagnostics.running') : t('plugins.diagnostics.run')}
        </button>
      </div>

      {error && (
        <div className="rounded-xl border border-red-500/25 bg-red-500/5 p-3 text-[10px] leading-5 text-red-400">
          {error}
        </div>
      )}

      {!report && !error && !loading && (
        <div className="rounded-xl border border-dashed border-border-subtle py-6 text-center text-[10px] text-text-tertiary">
          {t('plugins.diagnostics.empty')}
        </div>
      )}

      {report && (
        <>
          {!report.signatureVerificationAvailable && (
            <div className="rounded-xl border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-[10px] leading-5 text-amber-500" data-testid="plugin-signature-disclaimer">
              {t('plugins.diagnostics.signatureUnavailable')}
            </div>
          )}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              [t('plugins.diagnostics.plugins'), report.plugins.length],
              [t('plugins.diagnostics.passed'), report.validationPassed],
              [t('plugins.diagnostics.failed'), report.validationFailed],
              [t('plugins.diagnostics.warnings'), report.warningCount],
            ].map(([label, value]) => (
              <div key={String(label)} className="rounded-xl border border-border-subtle bg-bg-chat/65 px-3 py-2">
                <div className="text-[9px] text-text-tertiary">{label}</div>
                <div className="mt-0.5 text-[14px] font-semibold text-text-primary">{value}</div>
              </div>
            ))}
          </div>

          {report.conflicts.length > 0 && (
            <div className="space-y-1.5" data-testid="plugin-conflict-list">
              <h4 className="text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">{t('plugins.diagnostics.conflicts')}</h4>
              {report.conflicts.map((conflict) => (
                <div
                  key={conflict.id}
                  className={`rounded-xl border px-3 py-2 text-[10px] leading-4 ${conflict.severity === 'error'
                    ? 'border-red-500/25 bg-red-500/5 text-red-400'
                    : 'border-amber-500/25 bg-amber-500/5 text-amber-500'}`}
                >
                  <div className="font-medium">{t(`plugins.diagnostics.conflict.${conflict.kind}`)}</div>
                  <div className="mt-0.5 opacity-80">{conflict.pluginIds.join(' · ')}</div>
                </div>
              ))}
            </div>
          )}

          <div className="space-y-2">
            {report.plugins.map((plugin) => (
              <details key={diagnosticInstanceKey(plugin)} className="group rounded-xl border border-border-subtle bg-bg-chat/55">
                <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5">
                  <span className="text-text-tertiary transition-transform group-open:rotate-90">›</span>
                  <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-text-primary">{plugin.pluginName}</span>
                  <ScopeBadge scope={plugin.scope} />
                  <DiagnosticStatus kind="validation" value={plugin.validationStatus} />
                </summary>
                <div className="space-y-3 border-t border-border-subtle px-3 py-3">
                  <div className="flex flex-wrap gap-1.5">
                    <DiagnosticStatus kind="source" value={plugin.sourcePinStatus} />
                    <DiagnosticStatus kind="signature" value={plugin.signatureStatus} />
                  </div>
                  <dl className="grid grid-cols-[118px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[10px]">
                    <dt className="text-text-tertiary">{t('plugins.diagnostics.namespace')}</dt>
                    <dd className="break-all text-text-muted">{plugin.manifestName || '—'}</dd>
                    <dt className="text-text-tertiary">SHA-256</dt>
                    <dd className="break-all font-mono text-text-muted">{plugin.contentSha256 || '—'}</dd>
                    <dt className="text-text-tertiary">{t('plugins.diagnostics.content')}</dt>
                    <dd className="text-text-muted">{plugin.fileCount ?? '—'} {t('plugins.diagnostics.files')} · {formatDiagnosticBytes(plugin.totalBytes)}</dd>
                    <dt className="text-text-tertiary">{t('plugins.diagnostics.revision')}</dt>
                    <dd className="break-all font-mono text-text-muted">{plugin.installedRevision || '—'}</dd>
                    <dt className="text-text-tertiary">{t('plugins.diagnostics.path')}</dt>
                    <dd className="break-all text-text-muted">{plugin.installPath || '—'}</dd>
                  </dl>
                  <pre className="whitespace-pre-wrap break-words rounded-lg border border-border-subtle bg-bg-secondary/50 p-2 text-[9px] leading-4 text-text-muted">{plugin.validationMessage}</pre>
                  {plugin.warnings.length > 0 && (
                    <ul className="space-y-1 text-[9px] leading-4 text-amber-500">
                      {plugin.warnings.map((warning) => <li key={warning}>• {warning}</li>)}
                    </ul>
                  )}
                </div>
              </details>
            ))}
          </div>
          <p className="text-right text-[9px] text-text-tertiary">{new Date(report.generatedAt).toLocaleString()}</p>
        </>
      )}
    </section>
  );
}

function ScopeBadge({ scope }: { scope: PluginScope | null }) {
  return (
    <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[10px] font-medium uppercase text-text-tertiary">
      {scope || 'available'}
    </span>
  );
}

function PluginGlyph({ plugin, compact = false }: { plugin: PluginRecord; compact?: boolean }) {
  const hue = pluginHue(plugin);
  const size = compact ? 'h-9 w-9 rounded-[10px] text-[10px]' : 'h-11 w-11 rounded-xl text-[11px]';
  return (
    <div
      className={`flex shrink-0 items-center justify-center border font-semibold tracking-wide shadow-sm ${size}`}
      style={{
        color: `hsl(${hue} 72% 72%)`,
        background: `linear-gradient(145deg, hsl(${hue} 44% 24% / .92), hsl(${(hue + 28) % 360} 38% 14% / .96))`,
        borderColor: `hsl(${hue} 56% 44% / .34)`,
      }}
      aria-hidden="true"
    >
      {pluginInitials(plugin)}
    </div>
  );
}

function catalogDetailText(plugin: PluginRecord, t: (key: string) => string): string {
  const lines = [
    `${t('plugins.detail.id')}: ${plugin.id}`,
    `${t('plugins.detail.marketplace')}: ${plugin.marketplaceName || '—'}`,
    `${t('plugins.detail.source')}: ${plugin.source || plugin.repository || plugin.homepage || '—'}`,
    `${t('plugins.detail.category')}: ${plugin.category || t('plugins.categoryOther')}`,
    `${t('plugins.detail.author')}: ${plugin.authorName || '—'}`,
    `${t('plugins.detail.components')}: ${plugin.components.length > 0 ? plugin.components.join(', ') : t('plugins.componentsUndeclared')}`,
  ];
  if (plugin.tags.length > 0) lines.push(`${t('plugins.detail.tags')}: ${plugin.tags.join(', ')}`);
  if (plugin.homepage) lines.push(`${t('plugins.detail.homepage')}: ${plugin.homepage}`);
  if (plugin.repository) lines.push(`${t('plugins.detail.repository')}: ${plugin.repository}`);
  if (plugin.strict != null) lines.push(`strict: ${plugin.strict}`);
  return lines.join('\n');
}

function PluginCard({
  plugin,
  cwd,
  installScope,
  keepData,
  onDetails,
  onInstall,
}: {
  plugin: PluginRecord;
  cwd?: string;
  installScope: PluginScope;
  keepData: boolean;
  onDetails: (plugin: PluginRecord) => void;
  onInstall: (plugin: PluginRecord) => void;
}) {
  const t = useT();
  const busyKey = usePluginStore((state) => state.busyKey);
  const setEnabled = usePluginStore((state) => state.setEnabled);
  const update = usePluginStore((state) => state.update);
  const uninstall = usePluginStore((state) => state.uninstall);
  const busy = busyKey?.endsWith(`:${plugin.id}`) ?? false;
  const mutable = plugin.scope !== 'managed';
  const popularity = formatInstallCount(plugin.installCount);

  const confirmUninstall = async () => {
    if (!plugin.scope || !mutable) return;
    const { ask } = await import('@tauri-apps/plugin-dialog');
    const confirmed = await ask(
      t('plugins.uninstallConfirm').replace('{name}', plugin.name),
      { kind: 'warning', title: t('plugins.title') },
    );
    if (confirmed) await uninstall(plugin.id, plugin.scope, keepData, cwd).catch(() => {});
  };

  return (
    <article
      className="rounded-xl border border-border-subtle bg-bg-secondary/35 p-3.5 transition-smooth hover:border-accent/25 hover:bg-bg-secondary/50"
      data-plugin-id={plugin.id}
      style={{ contentVisibility: 'auto', containIntrinsicSize: '170px' }}
    >
      <div className="flex items-start justify-between gap-3">
        <PluginGlyph plugin={plugin} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-[13px] font-semibold text-text-primary">{plugin.name}</span>
            <ScopeBadge scope={plugin.scope} />
            {plugin.installed && (
              <span className={`text-[10px] font-medium ${plugin.enabled ? 'text-emerald-500' : 'text-text-tertiary'}`}>
                {plugin.enabled ? t('plugins.enabled') : t('plugins.disabled')}
              </span>
            )}
            {plugin.updateAvailable && (
              <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-500">
                {t('plugins.updateAvailable')}
              </span>
            )}
          </div>
          <p className="mt-1 line-clamp-2 text-[11px] leading-5 text-text-muted">
            {plugin.description || plugin.id}
          </p>
          <div className="mt-1 flex flex-wrap gap-x-3 text-[10px] text-text-tertiary">
            {plugin.marketplaceName && <span>{plugin.marketplaceName}</span>}
            {plugin.category && <span>{plugin.category}</span>}
            {plugin.authorName && <span>{plugin.authorName}</span>}
            {popularity && <span>{popularity} {t('plugins.installs')}</span>}
            {plugin.version && <span>v{plugin.version}</span>}
            {plugin.availableVersion && plugin.availableVersion !== plugin.version && (
              <span>→ v{plugin.availableVersion}</span>
            )}
          </div>
          {plugin.tags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {plugin.tags.slice(0, 3).map((tag) => (
                <span key={tag} className="rounded-full border border-border-subtle px-1.5 py-0.5 text-[9px] text-text-tertiary">{tag}</span>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        <button className={ACTION} onClick={() => onDetails(plugin)} disabled={busy}>
          {t('plugins.details')}
        </button>
        {!plugin.installed ? (
          <button
            className={`${ACTION} border-accent/30 bg-accent/10 text-accent`}
            onClick={() => onInstall(plugin)}
            disabled={busy || ((installScope === 'project' || installScope === 'local') && !cwd)}
          >
            {busy ? t('plugins.working') : t('plugins.install')}
          </button>
        ) : (
          <>
            <button
              className={ACTION}
              onClick={() => plugin.scope && setEnabled(plugin.id, !plugin.enabled, plugin.scope, cwd).catch(() => {})}
              disabled={busy || !mutable || !plugin.scope}
            >
              {plugin.enabled ? t('plugins.disable') : t('plugins.enable')}
            </button>
            {plugin.marketplaceName !== 'skills-dir' && (
              <button
                className={ACTION}
                onClick={() => plugin.scope && update(plugin.id, plugin.scope, cwd).catch(() => {})}
                disabled={busy || !mutable || !plugin.scope}
              >
                {t('plugins.update')}
              </button>
            )}
            <button
              className={`${ACTION} hover:border-red-500/40 hover:text-red-400`}
              onClick={confirmUninstall}
              disabled={busy || !mutable || !plugin.scope}
            >
              {t('plugins.uninstall')}
            </button>
          </>
        )}
      </div>
    </article>
  );
}

export function PluginsTab({ standalone = false }: { standalone?: boolean }) {
  const t = useT();
  const workingDirectory = useSettingsStore((state) => state.workingDirectory);
  const cwd = workingDirectory || undefined;
  const plugins = usePluginStore((state) => state.plugins);
  const marketplaces = usePluginStore((state) => state.marketplaces);
  const loading = usePluginStore((state) => state.loading);
  const loaded = usePluginStore((state) => state.loaded);
  const busyKey = usePluginStore((state) => state.busyKey);
  const error = usePluginStore((state) => state.error);
  const diagnostics = usePluginStore((state) => state.diagnostics);
  const diagnosticsLoading = usePluginStore((state) => state.diagnosticsLoading);
  const diagnosticsError = usePluginStore((state) => state.diagnosticsError);
  const load = usePluginStore((state) => state.load);
  const loadMarketplaces = usePluginStore((state) => state.loadMarketplaces);
  const diagnose = usePluginStore((state) => state.diagnose);
  const addMarketplace = usePluginStore((state) => state.addMarketplace);
  const updateMarketplace = usePluginStore((state) => state.updateMarketplace);
  const removeMarketplace = usePluginStore((state) => state.removeMarketplace);
  const details = usePluginStore((state) => state.details);
  const install = usePluginStore((state) => state.install);
  const clearError = usePluginStore((state) => state.clearError);

  const [query, setQuery] = useState('');
  const [installScope, setInstallScope] = useState<PluginScope>(cwd ? 'local' : 'user');
  const [keepData, setKeepData] = useState(true);
  const [marketplaceSource, setMarketplaceSource] = useState('');
  const [showAvailable, setShowAvailable] = useState(standalone);
  const [audience, setAudience] = useState<PluginAudience>('public');
  const [category, setCategory] = useState('all');
  const [detailsTitle, setDetailsTitle] = useState('');
  const [detailsText, setDetailsText] = useState('');
  const [installPreview, setInstallPreview] = useState<PluginRecord | null>(null);

  useEffect(() => {
    load(cwd, standalone);
    loadMarketplaces(cwd);
  }, [cwd, load, loadMarketplaces, standalone]);

  useEffect(() => {
    if (!cwd && installScope !== 'user') setInstallScope('user');
  }, [cwd, installScope]);

  const normalizedQuery = query.trim().toLowerCase();
  const filtered = useMemo(() => plugins
    .filter((plugin) => !normalizedQuery || searchablePluginText(plugin).includes(normalizedQuery))
    .sort(compareCatalogPlugins), [plugins, normalizedQuery]);
  const installed = useMemo(
    () => (standalone ? plugins : filtered).filter((plugin) => plugin.installed).sort(compareCatalogPlugins),
    [filtered, plugins, standalone],
  );
  const available = filtered.filter((plugin) => !plugin.installed);
  const audiencePlugins = useMemo(() => filtered
    .filter((plugin) => pluginAudience(plugin, marketplaces) === audience), [audience, filtered, marketplaces]);
  const categories = useMemo(() => Array.from(new Set(audiencePlugins.map(pluginCategory))).sort(), [audiencePlugins]);
  const catalog = useMemo(() => audiencePlugins
    .filter((plugin) => category === 'all' || pluginCategory(plugin) === category), [audiencePlugins, category]);

  useEffect(() => {
    if (category !== 'all' && !categories.includes(category)) setCategory('all');
  }, [categories, category]);

  const openDetails = async (plugin: PluginRecord) => {
    setDetailsTitle(plugin.id);
    if (!plugin.installed) {
      setDetailsText(catalogDetailText(plugin, t));
      return;
    }
    setDetailsText(t('plugins.loadingDetails'));
    try {
      setDetailsText(await details(plugin.id, cwd));
    } catch (reason) {
      setDetailsText(String(reason));
    }
  };

  const discover = async () => {
    setShowAvailable(true);
    await load(cwd, true);
  };

  const confirmRemoveMarketplace = async (name: string) => {
    const { ask } = await import('@tauri-apps/plugin-dialog');
    const confirmed = await ask(
      t('plugins.removeMarketplaceConfirm').replace('{name}', name),
      { kind: 'warning', title: t('plugins.marketplaces') },
    );
    if (confirmed) await removeMarketplace(name, cwd).catch(() => {});
  };

  const installDialog = installPreview && (
    <div
      className="fixed inset-0 z-[10030] flex items-center justify-center bg-black/45 p-8"
      onMouseDown={(event) => { if (event.target === event.currentTarget && !busyKey) setInstallPreview(null); }}
      data-testid="plugin-install-preview"
    >
      <div className="max-h-[78vh] w-[min(680px,92vw)] overflow-hidden rounded-2xl border border-border-subtle bg-bg-card shadow-2xl">
        <div className="flex items-start gap-3 border-b border-border-subtle px-5 py-4">
          <PluginGlyph plugin={installPreview} />
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-[14px] font-semibold text-text-primary">{installPreview.name}</h3>
            <p className="mt-1 text-[10px] text-text-tertiary">{installPreview.marketplaceName || installPreview.id}</p>
          </div>
          <button className="text-text-tertiary hover:text-text-primary disabled:opacity-40" disabled={!!busyKey} onClick={() => setInstallPreview(null)}>×</button>
        </div>
        <div className="max-h-[58vh] space-y-4 overflow-y-auto p-5">
          <div className="rounded-xl border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-[11px] leading-5 text-amber-500">
            {t('plugins.installRisk')}
          </div>
          <dl className="grid grid-cols-[120px_minmax(0,1fr)] gap-x-4 gap-y-2 text-[11px]">
            <dt className="text-text-tertiary">{t('plugins.installScope')}</dt>
            <dd className="text-text-primary">{t(`plugins.scope.${installScope}`)}</dd>
            <dt className="text-text-tertiary">{t('plugins.detail.source')}</dt>
            <dd className="break-words text-text-primary">{installPreview.source || installPreview.repository || installPreview.homepage || '—'}</dd>
            <dt className="text-text-tertiary">{t('plugins.detail.components')}</dt>
            <dd className="text-text-primary">{installPreview.components.length > 0 ? installPreview.components.join(', ') : t('plugins.componentsUndeclared')}</dd>
            <dt className="text-text-tertiary">{t('plugins.detail.category')}</dt>
            <dd className="text-text-primary">{installPreview.category || t('plugins.categoryOther')}</dd>
            <dt className="text-text-tertiary">{t('plugins.detail.author')}</dt>
            <dd className="text-text-primary">{installPreview.authorName || '—'}</dd>
          </dl>
          <div>
            <h4 className="mb-2 text-[10px] font-medium uppercase tracking-wide text-text-tertiary">{t('plugins.catalogDeclaration')}</h4>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border-subtle bg-bg-chat p-3 text-[10px] leading-5 text-text-muted">{catalogDetailText(installPreview, t)}</pre>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border-subtle px-5 py-3">
          <button className={ACTION} disabled={!!busyKey} onClick={() => setInstallPreview(null)}>{t('common.cancel')}</button>
          <button
            className={`${ACTION} border-accent/30 bg-accent/10 text-accent`}
            disabled={!!busyKey || ((installScope === 'project' || installScope === 'local') && !cwd)}
            onClick={async () => {
              try {
                await install(installPreview.id, installScope, cwd);
                setInstallPreview(null);
              } catch {
                // Store owns the surfaced error; keep the preview open for review.
              }
            }}
          >
            {busyKey ? t('plugins.working') : t('plugins.confirmInstall')}
          </button>
        </div>
      </div>
    </div>
  );

  if (standalone) {
    return (
      <div
        className="space-y-8 pb-10"
        data-testid="extension-plugin-catalog"
        data-plugin-loaded={loaded ? 'true' : 'false'}
      >
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-[280px] flex-1">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary">
              <circle cx="7" cy="7" r="5" />
              <path d="m11 11 3 3" />
            </svg>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('plugins.search')}
              className="w-full rounded-xl border border-border-subtle bg-bg-secondary/45 py-2.5 pl-9 pr-3 text-[12px] text-text-primary outline-none transition-smooth placeholder:text-text-tertiary focus:border-accent/60 focus:bg-bg-secondary"
              data-testid="plugin-catalog-search"
            />
          </div>
          <div className="flex items-center gap-2">
            <button className={ACTION} onClick={() => diagnose(cwd)} disabled={diagnosticsLoading}>
              {diagnosticsLoading ? t('plugins.diagnostics.running') : t('plugins.diagnostics.run')}
            </button>
            <button className={ACTION} onClick={() => load(cwd, true)} disabled={loading}>
              {loading ? t('plugins.loading') : t('plugins.refresh')}
            </button>
          </div>
        </div>

        {error && (
          <div
            className="flex items-start justify-between gap-3 rounded-xl border border-red-500/25 bg-red-500/5 p-3 text-[11px] text-red-400"
            data-testid="plugin-catalog-error"
          >
            <span className="break-words">{error}</span>
            <button onClick={clearError} className="shrink-0">×</button>
          </div>
        )}

        <section className="space-y-3" aria-labelledby="installed-plugins-title">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h3 id="installed-plugins-title" className="text-[14px] font-semibold text-text-primary">{t('plugins.installed')}</h3>
              <p className="mt-1 text-[10px] text-text-tertiary">{t('plugins.newSessionHint')}</p>
            </div>
            <div className="flex items-center gap-3 text-[10px] text-text-muted">
              <label className="flex items-center gap-1.5">
                {t('plugins.installScope')}
                <select
                  value={installScope}
                  onChange={(event) => setInstallScope(event.target.value as PluginScope)}
                  className="rounded-lg border border-border-subtle bg-bg-chat px-2 py-1.5 text-text-primary"
                >
                  <option value="user">{t('plugins.scope.user')}</option>
                  <option value="project" disabled={!cwd}>{t('plugins.scope.project')}</option>
                  <option value="local" disabled={!cwd}>{t('plugins.scope.local')}</option>
                </select>
              </label>
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={keepData} onChange={(event) => setKeepData(event.target.checked)} />
                {t('plugins.keepDataShort')}
              </label>
            </div>
          </div>
          {installed.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border-subtle py-7 text-center text-[11px] text-text-tertiary">
              {loaded ? t('plugins.noneInstalled') : t('plugins.loading')}
            </div>
          ) : (
            <div className="flex flex-wrap gap-2.5 rounded-2xl border border-border-subtle bg-bg-secondary/25 p-3.5" data-testid="installed-plugin-strip">
              {installed.map((plugin) => (
                <button
                  key={pluginInstanceKey(plugin)}
                  type="button"
                  onClick={() => openDetails(plugin)}
                  title={`${plugin.name} · ${plugin.marketplaceName || plugin.scope || ''}`}
                  className={`rounded-xl p-1 transition-smooth hover:bg-bg-tertiary ${plugin.enabled ? '' : 'opacity-45 grayscale'}`}
                >
                  <PluginGlyph plugin={plugin} compact />
                </button>
              ))}
            </div>
          )}
        </section>

        <PluginDiagnosticsPanel
          report={diagnostics}
          loading={diagnosticsLoading}
          error={diagnosticsError}
          onRun={() => diagnose(cwd)}
        />

        <section className="space-y-5" aria-labelledby="plugin-directory-title">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle pb-3">
            <div className="flex items-center gap-1 rounded-xl bg-bg-secondary/55 p-1" role="tablist" aria-label={t('plugins.directory')}>
              {(['public', 'personal'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={audience === value}
                  onClick={() => { setAudience(value); setCategory('all'); }}
                  data-testid={`plugin-audience-${value}`}
                  className={`rounded-lg px-3 py-1.5 text-[11px] font-medium transition-smooth ${audience === value
                    ? 'bg-bg-card text-text-primary shadow-sm'
                    : 'text-text-tertiary hover:text-text-primary'}`}
                >
                  {t(`plugins.audience.${value}`)}
                </button>
              ))}
            </div>
            <p className="max-w-xl text-right text-[10px] leading-4 text-text-tertiary">
              {audience === 'public' ? t('plugins.publicHint') : t('plugins.personalHint')}
            </p>
          </div>

          {categories.length > 1 && (
            <div className="flex flex-wrap gap-1.5" data-testid="plugin-category-filter">
              {['all', ...categories].map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setCategory(value)}
                  className={`rounded-full border px-2.5 py-1 text-[10px] transition-smooth ${category === value
                    ? 'border-accent/35 bg-accent/10 text-accent'
                    : 'border-border-subtle text-text-tertiary hover:bg-bg-secondary hover:text-text-primary'}`}
                >
                  {value === 'all' ? t('plugins.categoryAll') : value}
                </button>
              ))}
            </div>
          )}

          <div className="flex items-end justify-between gap-4">
            <div>
              <h3 id="plugin-directory-title" className="text-[15px] font-semibold text-text-primary">
                {normalizedQuery ? t('plugins.results') : t('plugins.popular')}
              </h3>
              <p className="mt-1 text-[10px] text-text-tertiary">{t('plugins.popularHint')}</p>
            </div>
          </div>

          {loading && plugins.length === 0 ? (
            <div className="flex justify-center py-16"><div className="h-6 w-6 animate-spin rounded-full border-2 border-accent/25 border-t-accent" /></div>
          ) : catalog.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border-subtle py-14 text-center text-[11px] leading-5 text-text-tertiary">
              {normalizedQuery ? t('plugins.noMatches') : t('plugins.noAudiencePlugins')}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-2" data-testid="plugin-directory-grid">
              {catalog.map((plugin) => (
                <PluginCard key={pluginInstanceKey(plugin)} plugin={plugin} cwd={cwd} installScope={installScope} keepData={keepData} onDetails={openDetails} onInstall={setInstallPreview} />
              ))}
            </div>
          )}
        </section>

        <details className="group rounded-2xl border border-border-subtle bg-bg-secondary/20" data-testid="plugin-marketplace-sources">
          <summary className="cursor-pointer list-none px-4 py-3 text-[12px] font-medium text-text-primary">
            <span className="inline-flex items-center gap-2">
              <span className="text-text-tertiary transition-transform group-open:rotate-90">›</span>
              {t('plugins.marketplaces')}
            </span>
          </summary>
          <div className="space-y-3 border-t border-border-subtle p-4">
            <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-[11px] leading-5 text-amber-500">
              {t('plugins.trustWarning')}
            </div>
            <p className="text-[10px] text-text-tertiary">{t('plugins.marketplacesHint')}</p>
            <div className="flex gap-2">
              <input
                value={marketplaceSource}
                onChange={(event) => setMarketplaceSource(event.target.value)}
                placeholder={t('plugins.marketplaceSource')}
                className="min-w-0 flex-1 rounded-md border border-border-subtle bg-bg-chat px-3 py-2 text-[11px] text-text-primary outline-none focus:border-accent"
              />
              <button
                className={`${ACTION} border-accent/30 bg-accent/10 text-accent`}
                disabled={!marketplaceSource.trim() || !!busyKey}
                onClick={async () => {
                  await addMarketplace(marketplaceSource.trim(), cwd).catch(() => {});
                  if (!usePluginStore.getState().error) setMarketplaceSource('');
                }}
              >
                {t('plugins.addMarketplace')}
              </button>
              <button className={ACTION} onClick={() => updateMarketplace(undefined, cwd).catch(() => {})} disabled={!!busyKey}>
                {t('plugins.updateAll')}
              </button>
            </div>
            <div className="space-y-1.5">
              {marketplaces.length === 0 ? (
                <p className="text-[11px] text-text-tertiary">{t('plugins.noMarketplaces')}</p>
              ) : marketplaces.map((marketplace) => (
                <div key={marketplace.name} className="flex items-center gap-3 rounded-md border border-border-subtle px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[11px] font-medium text-text-primary">{marketplace.name}</div>
                    <div className="truncate text-[10px] text-text-tertiary" title={marketplace.path || marketplace.source}>
                      {marketplace.source}{marketplace.path ? ` · ${marketplace.path}` : ''}
                    </div>
                  </div>
                  <button className={ACTION} onClick={() => updateMarketplace(marketplace.name, cwd).catch(() => {})} disabled={!!busyKey}>
                    {t('plugins.update')}
                  </button>
                  <button className={`${ACTION} hover:text-red-400`} onClick={() => confirmRemoveMarketplace(marketplace.name)} disabled={!!busyKey}>
                    {t('plugins.remove')}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </details>

        {detailsTitle && (
          <div className="fixed inset-0 z-[10020] flex items-center justify-center bg-black/40 p-8" onMouseDown={(event) => { if (event.target === event.currentTarget) setDetailsTitle(''); }}>
            <div className="max-h-[70vh] w-[min(720px,90vw)] overflow-hidden rounded-xl border border-border-subtle bg-bg-card shadow-2xl">
              <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
                <span className="text-[13px] font-semibold text-text-primary">{detailsTitle}</span>
                <button className="text-text-tertiary hover:text-text-primary" onClick={() => setDetailsTitle('')}>×</button>
              </div>
              <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words p-4 text-[11px] leading-5 text-text-muted">{detailsText}</pre>
            </div>
          </div>
        )}
        {installDialog}
      </div>
    );
  }

  return (
    <div className={`space-y-6 ${standalone ? 'pb-10' : ''}`} data-testid={standalone ? 'extension-plugin-catalog' : undefined}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-[13px] font-semibold text-text-primary">{t('plugins.title')}</h3>
          <p className="mt-1 max-w-2xl text-[11px] leading-5 text-text-muted">{t('plugins.description')}</p>
        </div>
        <div className="flex items-center gap-2">
          <button className={ACTION} onClick={() => diagnose(cwd)} disabled={diagnosticsLoading}>
            {diagnosticsLoading ? t('plugins.diagnostics.running') : t('plugins.diagnostics.run')}
          </button>
          <button className={ACTION} onClick={() => load(cwd, showAvailable)} disabled={loading}>
            {loading ? t('plugins.loading') : t('plugins.refresh')}
          </button>
        </div>
      </div>

      <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-[11px] leading-5 text-amber-500">
        {t('plugins.trustWarning')}
      </div>

      {error && (
        <div
          className="flex items-start justify-between gap-3 rounded-lg border border-red-500/25 bg-red-500/5 p-3 text-[11px] text-red-400"
          data-testid="plugin-catalog-error"
        >
          <span className="break-words">{error}</span>
          <button onClick={clearError} className="shrink-0">×</button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('plugins.search')}
          className="min-w-[220px] flex-1 rounded-md border border-border-subtle bg-bg-chat px-3 py-2 text-[12px] text-text-primary outline-none focus:border-accent"
        />
        <label className="flex items-center gap-2 text-[11px] text-text-muted">
          {t('plugins.installScope')}
          <select
            value={installScope}
            onChange={(event) => setInstallScope(event.target.value as PluginScope)}
            className="rounded-md border border-border-subtle bg-bg-chat px-2 py-2 text-text-primary"
          >
            <option value="user">user</option>
            <option value="project" disabled={!cwd}>project</option>
            <option value="local" disabled={!cwd}>local</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-[11px] text-text-muted">
          <input type="checkbox" checked={keepData} onChange={(event) => setKeepData(event.target.checked)} />
          {t('plugins.keepData')}
        </label>
      </div>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="text-[12px] font-semibold text-text-primary">{t('plugins.installed')} ({installed.length})</h4>
          <span className="text-[10px] text-text-tertiary">{t('plugins.newSessionHint')}</span>
        </div>
        {installed.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border-subtle py-8 text-center text-[11px] text-text-tertiary">
            {loaded ? t('plugins.noneInstalled') : t('plugins.loading')}
          </div>
        ) : installed.map((plugin) => (
          <PluginCard key={pluginInstanceKey(plugin)} plugin={plugin} cwd={cwd} installScope={installScope} keepData={keepData} onDetails={openDetails} onInstall={setInstallPreview} />
        ))}
      </section>

      <PluginDiagnosticsPanel
        report={diagnostics}
        loading={diagnosticsLoading}
        error={diagnosticsError}
        onRun={() => diagnose(cwd)}
      />

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="text-[12px] font-semibold text-text-primary">{t('plugins.discover')}</h4>
          <button className={ACTION} onClick={discover} disabled={loading}>
            {showAvailable ? t('plugins.reloadCatalog') : t('plugins.loadCatalog')}
          </button>
        </div>
        {showAvailable && (available.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border-subtle py-6 text-center text-[11px] text-text-tertiary">
            {loading ? t('plugins.loading') : t('plugins.noneAvailable')}
          </div>
        ) : available.map((plugin) => (
          <PluginCard key={pluginInstanceKey(plugin)} plugin={plugin} cwd={cwd} installScope={installScope} keepData={keepData} onDetails={openDetails} onInstall={setInstallPreview} />
        )))}
      </section>

      <section className="space-y-3 border-t border-border-subtle pt-5">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="text-[12px] font-semibold text-text-primary">{t('plugins.marketplaces')}</h4>
            <p className="mt-1 text-[10px] text-text-tertiary">{t('plugins.marketplacesHint')}</p>
          </div>
          <button className={ACTION} onClick={() => updateMarketplace(undefined, cwd).catch(() => {})} disabled={!!busyKey}>
            {t('plugins.updateAll')}
          </button>
        </div>
        <div className="flex gap-2">
          <input
            value={marketplaceSource}
            onChange={(event) => setMarketplaceSource(event.target.value)}
            placeholder={t('plugins.marketplaceSource')}
            className="min-w-0 flex-1 rounded-md border border-border-subtle bg-bg-chat px-3 py-2 text-[11px] text-text-primary outline-none focus:border-accent"
          />
          <button
            className={`${ACTION} border-accent/30 bg-accent/10 text-accent`}
            disabled={!marketplaceSource.trim() || !!busyKey}
            onClick={async () => {
              await addMarketplace(marketplaceSource.trim(), cwd).catch(() => {});
              if (!usePluginStore.getState().error) setMarketplaceSource('');
            }}
          >
            {t('plugins.addMarketplace')}
          </button>
        </div>
        <div className="space-y-1.5">
          {marketplaces.length === 0 ? (
            <p className="text-[11px] text-text-tertiary">{t('plugins.noMarketplaces')}</p>
          ) : marketplaces.map((marketplace) => (
            <div key={marketplace.name} className="flex items-center gap-3 rounded-md border border-border-subtle px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[11px] font-medium text-text-primary">{marketplace.name}</div>
                <div className="truncate text-[10px] text-text-tertiary" title={marketplace.path || marketplace.source}>
                  {marketplace.source}{marketplace.path ? ` · ${marketplace.path}` : ''}
                </div>
              </div>
              <button className={ACTION} onClick={() => updateMarketplace(marketplace.name, cwd).catch(() => {})} disabled={!!busyKey}>
                {t('plugins.update')}
              </button>
              <button className={`${ACTION} hover:text-red-400`} onClick={() => confirmRemoveMarketplace(marketplace.name)} disabled={!!busyKey}>
                {t('plugins.remove')}
              </button>
            </div>
          ))}
        </div>
      </section>

      {detailsTitle && (
        <div className="fixed inset-0 z-[10020] flex items-center justify-center bg-black/40 p-8" onMouseDown={(event) => { if (event.target === event.currentTarget) setDetailsTitle(''); }}>
          <div className="max-h-[70vh] w-[min(720px,90vw)] overflow-hidden rounded-xl border border-border-subtle bg-bg-card shadow-2xl">
            <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
              <span className="text-[13px] font-semibold text-text-primary">{detailsTitle}</span>
              <button className="text-text-tertiary hover:text-text-primary" onClick={() => setDetailsTitle('')}>×</button>
            </div>
            <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words p-4 text-[11px] leading-5 text-text-muted">{detailsText}</pre>
          </div>
        </div>
      )}
      {installDialog}
    </div>
  );
}
