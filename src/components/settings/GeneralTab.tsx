import { useRef, useCallback, useEffect, useState } from 'react';
import {
  useSettingsStore,
  type ColorTheme,
  type SurfaceTheme,
} from '../../stores/settingsStore';
import { useProviderStore } from '../../stores/providerStore';
import { getModelDisplayOptions, getSelectedModelOptionId } from '../../lib/api-provider';
import { useT } from '../../lib/i18n';
import { AiAvatar } from '../shared/AiAvatar';
import { UserAvatar } from '../shared/UserAvatar';
import { AvatarCropModal } from './AvatarCropModal';
import {
  bridge,
  type PowerAssertionStatus,
  type SessionOrganizationReport,
} from '../../lib/tauri-bridge';
import { ask, open, save } from '@tauri-apps/plugin-dialog';

interface SurfacePreviewPalette {
  canvas: string;
  sidebar: string;
  main: string;
  card: string;
  line: string;
}

const SURFACE_OPTIONS: Array<{
  id: SurfaceTheme;
  labelKey: string;
  light: SurfacePreviewPalette;
  dark: SurfacePreviewPalette;
}> = [
  {
    id: 'graphite',
    labelKey: 'settings.surface.graphite',
    light: { canvas: '#E8EAEE', sidebar: '#EFF1F4', main: '#FAFBFC', card: '#FFFFFF', line: '#CFD3DA' },
    dark: { canvas: '#090A0C', sidebar: '#101217', main: '#0C0D10', card: '#17191F', line: '#323640' },
  },
  {
    id: 'midnight',
    labelKey: 'settings.surface.midnight',
    light: { canvas: '#E5ECF7', sidebar: '#EAF0F8', main: '#F8FAFE', card: '#FFFFFF', line: '#C8D5E7' },
    dark: { canvas: '#070C15', sidebar: '#0C1421', main: '#09101B', card: '#111C2B', line: '#253752' },
  },
  {
    id: 'paper',
    labelKey: 'settings.surface.paper',
    light: { canvas: '#ECE4D7', sidebar: '#EEE7DB', main: '#FCFAF5', card: '#FFFCF7', line: '#D8CBBB' },
    dark: { canvas: '#15110E', sidebar: '#1B1612', main: '#17130F', card: '#251F1A', line: '#40352C' },
  },
  {
    id: 'forest',
    labelKey: 'settings.surface.forest',
    light: { canvas: '#E4EDE6', sidebar: '#E8F0E9', main: '#F8FBF8', card: '#FAFCFA', line: '#C9D9CD' },
    dark: { canvas: '#09110D', sidebar: '#0E1913', main: '#0B1510', card: '#15221A', line: '#294331' },
  },
];

const ACCENT_OPTIONS: Array<{
  id: ColorTheme;
  labelKey: string;
  light: string;
  dark: string;
}> = [
  { id: 'black', labelKey: 'settings.accent.black', light: '#303238', dark: '#D6D8DC' },
  { id: 'blue', labelKey: 'settings.accent.blue', light: '#416FC5', dark: '#78A3F3' },
  { id: 'purple', labelKey: 'settings.accent.purple', light: '#7B5AA6', dark: '#B493D5' },
  { id: 'green', labelKey: 'settings.accent.green', light: '#467E57', dark: '#80C985' },
];

function SurfacePreview({ palette, accent }: { palette: SurfacePreviewPalette; accent: string }) {
  return (
    <div className="flex aspect-[5/3] w-full overflow-hidden rounded-lg border" style={{ background: palette.canvas, borderColor: palette.line }}>
      <div className="flex w-[24%] flex-col gap-1.5 border-r p-2" style={{ background: palette.sidebar, borderColor: palette.line }}>
        <span className="h-1.5 w-8 rounded-full" style={{ background: palette.line }} />
        <span className="h-1.5 w-full rounded-full opacity-35" style={{ background: accent }} />
        <span className="h-1.5 w-3/4 rounded-full" style={{ background: palette.line }} />
      </div>
      <div className="flex flex-1 flex-col gap-2 p-2.5" style={{ background: palette.main }}>
        <div className="flex flex-1 flex-col justify-center gap-1.5">
          <span className="h-2 w-3/5 rounded-full" style={{ background: palette.line }} />
          <span className="h-2 w-2/5 rounded-full opacity-70" style={{ background: palette.line }} />
          <span className="ml-auto h-3 w-1/2 rounded-full opacity-85" style={{ background: accent }} />
        </div>
        <div className="flex items-center gap-1.5 rounded-md border p-1" style={{ background: palette.card, borderColor: palette.line }}>
          <span className="h-1.5 flex-1 rounded-full opacity-70" style={{ background: palette.line }} />
          <span className="h-3 w-3 rounded" style={{ background: accent }} />
        </div>
      </div>
    </div>
  );
}

function PowerSwitch({
  checked,
  disabled = false,
  label,
  testId,
  onToggle,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  testId: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      data-testid={testId}
      disabled={disabled}
      onClick={onToggle}
      className={`relative h-5 w-9 flex-shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40
        ${checked ? 'bg-accent' : 'bg-bg-tertiary'}`}
    >
      <span
        className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-text-inverse shadow-sm transition-transform"
        style={{ transform: `translateX(${checked ? 16 : 0}px)` }}
      />
    </button>
  );
}

export function GeneralTab() {
  const t = useT();
  const theme = useSettingsStore((s) => s.theme);
  const colorTheme = useSettingsStore((s) => s.colorTheme);
  const surfaceTheme = useSettingsStore((s) => s.surfaceTheme);
  const locale = useSettingsStore((s) => s.locale);
  const selectedModel = useSettingsStore((s) => s.selectedModel);
  const auxiliaryModel = useSettingsStore((s) => s.auxiliaryModel);
  const fontSize = useSettingsStore((s) => s.fontSize);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const setColorTheme = useSettingsStore((s) => s.setColorTheme);
  const setSurfaceTheme = useSettingsStore((s) => s.setSurfaceTheme);
  const setLocale = useSettingsStore((s) => s.setLocale);
  const setSelectedModel = useSettingsStore((s) => s.setSelectedModel);
  const setAuxiliaryModel = useSettingsStore((s) => s.setAuxiliaryModel);
  const providers = useProviderStore((s) => s.providers);
  const activeProviderId = useProviderStore((s) => s.activeProviderId);
  const setFontSize = useSettingsStore((s) => s.setFontSize);
  const aiAvatarUrl = useSettingsStore((s) => s.aiAvatarUrl);
  const setAiAvatarUrl = useSettingsStore((s) => s.setAiAvatarUrl);
  const userAvatarUrl = useSettingsStore((s) => s.userAvatarUrl);
  const setUserAvatarUrl = useSettingsStore((s) => s.setUserAvatarUrl);
  const userDisplayName = useSettingsStore((s) => s.userDisplayName);
  const setUserDisplayName = useSettingsStore((s) => s.setUserDisplayName);
  const keepSystemAwake = useSettingsStore((s) => s.keepSystemAwake);
  const keepDisplayAwake = useSettingsStore((s) => s.keepDisplayAwake);
  const setKeepSystemAwake = useSettingsStore((s) => s.setKeepSystemAwake);
  const setKeepDisplayAwake = useSettingsStore((s) => s.setKeepDisplayAwake);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const userFileInputRef = useRef<HTMLInputElement>(null);
  const [cropFile, setCropFile] = useState<File | null>(null);
  const [cropTarget, setCropTarget] = useState<'ai' | 'user'>('ai');
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  const [organizationBusy, setOrganizationBusy] = useState(false);
  const [organizationStatus, setOrganizationStatus] = useState<string | null>(null);
  const [organizationReport, setOrganizationReport] = useState<SessionOrganizationReport | null>(null);
  const [powerStatus, setPowerStatus] = useState<PowerAssertionStatus | null>(null);
  const [powerError, setPowerError] = useState<string | null>(null);
  const activeProvider = providers.find((provider) => provider.id === activeProviderId) ?? null;
  const modelOptions = getModelDisplayOptions(activeProvider);
  const selectedModelOption = getSelectedModelOptionId(selectedModel, modelOptions);
  const auxiliaryModelOption = getSelectedModelOptionId(auxiliaryModel, modelOptions);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setSystemDark(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const update = (event: Event) => {
      const detail = (event as CustomEvent<PowerAssertionStatus & { error?: string }>).detail;
      if (!detail) return;
      if (typeof detail.supported === 'boolean') {
        setPowerStatus({
          supported: detail.supported,
          keepSystemAwake: detail.keepSystemAwake,
          keepDisplayAwake: detail.keepDisplayAwake,
        });
      }
      setPowerError(detail.error || null);
    };
    window.addEventListener('blackbox:power-assertion-status', update);
    bridge.getPowerAssertionStatus()
      .then((status) => {
        if (!cancelled) {
          setPowerStatus(status);
          setPowerError(null);
        }
      })
      .catch((error) => {
        if (!cancelled) setPowerError(String(error));
      });
    return () => {
      cancelled = true;
      window.removeEventListener('blackbox:power-assertion-status', update);
    };
  }, []);

  const previewDark = theme === 'dark' || (theme === 'system' && systemDark);
  const activeAccent = ACCENT_OPTIONS.find((option) => option.id === colorTheme) || ACCENT_OPTIONS[0];
  const accentPreview = previewDark ? activeAccent.dark : activeAccent.light;

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>, target: 'ai' | 'user') => {
    const file = e.target.files?.[0];
    if (!file) return;
    setCropTarget(target);
    setCropFile(file);
    e.target.value = '';
  }, []);

  const reportSummary = useCallback((report: SessionOrganizationReport) => (
    t('settings.organization.summary')
      .replace('{referenced}', String(report.referencedSessions))
      .replace('{available}', String(report.availableSessions))
      .replace('{unavailable}', String(report.unavailableSessions))
  ), [t]);

  const handleOrganizationExport = useCallback(async () => {
    setOrganizationStatus(null);
    const outputPath = await save({
      title: t('settings.organization.export'),
      defaultPath: `BlackBox-session-organization-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (!outputPath) return;
    setOrganizationBusy(true);
    try {
      const report = await bridge.exportSessionOrganization(outputPath);
      setOrganizationReport(report);
      setOrganizationStatus(t('settings.organization.exported'));
    } catch (error) {
      setOrganizationStatus(`${t('settings.organization.error')} ${String(error)}`);
    } finally {
      setOrganizationBusy(false);
    }
  }, [t]);

  const handleOrganizationImport = useCallback(async () => {
    setOrganizationStatus(null);
    const selected = await open({
      title: t('settings.organization.import'),
      multiple: false,
      directory: false,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (!selected || Array.isArray(selected)) return;
    setOrganizationBusy(true);
    try {
      const preview = await bridge.previewSessionOrganizationImport(selected);
      setOrganizationReport(preview);
      const confirmed = await ask(
        t('settings.organization.confirm')
          .replace('{groups}', String(preview.groups))
          .replace('{members}', String(preview.groupMembers))
          .replace('{archived}', String(preview.archived))
          .replace('{names}', String(preview.customNames)),
        { title: t('settings.organization.confirmTitle'), kind: 'warning' },
      );
      if (!confirmed) return;
      const report = await bridge.importSessionOrganization(selected);
      setOrganizationReport(report);
      setOrganizationStatus(t('settings.organization.imported'));
      window.dispatchEvent(new CustomEvent('blackbox:session-organization-imported'));
    } catch (error) {
      setOrganizationStatus(`${t('settings.organization.error')} ${String(error)}`);
    } finally {
      setOrganizationBusy(false);
    }
  }, [t]);

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-border-subtle bg-bg-secondary/35 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-[13px] font-semibold text-text-primary">{t('settings.appearance')}</h3>
            <p className="mt-1 text-[11px] leading-5 text-text-muted">{t('settings.appearanceDesc')}</p>
          </div>
          <div className="inline-flex overflow-hidden rounded-lg border border-border-subtle bg-bg-card/70">
            {(['light', 'dark', 'system'] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setTheme(mode)}
                className={`border-r border-border-subtle px-3 py-1.5 text-[11px] font-medium transition-smooth last:border-r-0
                  ${theme === mode ? 'bg-accent/10 text-accent' : 'text-text-muted hover:bg-bg-secondary'}`}
              >
                {t(`settings.${mode}`)}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-4">
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <span className="text-[11px] font-semibold text-text-primary">{t('settings.surfaceTheme')}</span>
            <span className="text-[10px] text-text-tertiary">{t('settings.surfaceThemeHint')}</span>
          </div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {SURFACE_OPTIONS.map((option) => {
              const selected = option.id === surfaceTheme;
              const palette = previewDark ? option.dark : option.light;
              return (
                <button
                  key={option.id}
                  onClick={() => setSurfaceTheme(option.id)}
                  className={`rounded-xl p-2 text-left transition-smooth
                    ${selected
                      ? 'bg-accent/[0.05] ring-2 ring-accent ring-offset-2 ring-offset-bg-card'
                      : 'border border-border-subtle hover:-translate-y-0.5 hover:border-accent/30'}`}
                >
                  <SurfacePreview palette={palette} accent={accentPreview} />
                  <span className={`mt-2 block text-[11px] font-medium ${selected ? 'text-accent' : 'text-text-muted'}`}>
                    {t(option.labelKey)}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="mt-4 border-t border-border-subtle pt-4">
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <span className="text-[11px] font-semibold text-text-primary">{t('settings.accentColor')}</span>
            <span className="text-[10px] text-text-tertiary">{t('settings.accentColorHint')}</span>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {ACCENT_OPTIONS.map((option) => {
              const selected = option.id === colorTheme;
              const color = previewDark ? option.dark : option.light;
              return (
                <button
                  key={option.id}
                  onClick={() => setColorTheme(option.id)}
                  className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition-smooth
                    ${selected ? 'border-accent/50 bg-accent/[0.06] text-text-primary' : 'border-border-subtle text-text-muted hover:bg-bg-card'}`}
                >
                  <span className="h-4 w-4 rounded-full shadow-sm" style={{ background: color }} />
                  <span className="text-[11px] font-medium">{t(option.labelKey)}</span>
                  {selected && <span className="ml-auto text-accent">✓</span>}
                </button>
              );
            })}
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-border-subtle bg-bg-secondary/35 p-4" data-testid="power-settings-section">
        <div>
          <h3 className="text-[13px] font-semibold text-text-primary">{t('settings.power.title')}</h3>
          <p className="mt-1 text-[11px] leading-5 text-text-muted">{t('settings.power.description')}</p>
        </div>

        <div className="mt-4 divide-y divide-border-subtle overflow-hidden rounded-lg border border-border-subtle bg-bg-card/70">
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <div className="min-w-0">
              <div className="text-[12px] font-medium text-text-primary">{t('settings.power.keepSystemAwake')}</div>
              <p className="mt-1 text-[11px] leading-4 text-text-muted">{t('settings.power.keepSystemAwakeHint')}</p>
            </div>
            <PowerSwitch
              checked={keepSystemAwake}
              label={t('settings.power.keepSystemAwake')}
              testId="keep-system-awake-toggle"
              onToggle={() => setKeepSystemAwake(!keepSystemAwake)}
            />
          </div>

          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <div className="min-w-0">
              <div className="text-[12px] font-medium text-text-primary">{t('settings.power.keepDisplayAwake')}</div>
              <p className="mt-1 text-[11px] leading-4 text-text-muted">{t('settings.power.keepDisplayAwakeHint')}</p>
            </div>
            <PowerSwitch
              checked={keepDisplayAwake}
              disabled={!keepSystemAwake}
              label={t('settings.power.keepDisplayAwake')}
              testId="keep-display-awake-toggle"
              onToggle={() => setKeepDisplayAwake(!keepDisplayAwake)}
            />
          </div>
        </div>

        {powerStatus && !powerStatus.supported && (
          <p className="mt-3 text-[10px] leading-4 text-text-tertiary" data-testid="power-assertion-unsupported">
            {t('settings.power.unsupported')}
          </p>
        )}
        {powerStatus?.supported && (
          <p className="mt-3 text-[10px] leading-4 text-text-tertiary" data-testid="power-assertion-effective-status">
            {t('settings.power.effectiveStatus')
              .replace('{system}', t(powerStatus.keepSystemAwake ? 'settings.power.active' : 'settings.power.inactive'))
              .replace('{display}', t(powerStatus.keepDisplayAwake ? 'settings.power.active' : 'settings.power.inactive'))}
          </p>
        )}
        {powerError && (
          <p className="mt-2 text-[10px] leading-4 text-error" data-testid="power-assertion-error">
            {t('settings.power.applyFailed').replace('{error}', powerError)}
          </p>
        )}

        <p className="mt-3 text-[10px] leading-4 text-text-tertiary">{t('settings.power.limit')}</p>
      </section>

      <section
        className="rounded-xl border border-border-subtle bg-bg-secondary/35 p-4"
        data-testid="session-organization-transfer"
      >
        <div>
          <h3 className="text-[13px] font-semibold text-text-primary">
            {t('settings.organization.title')}
          </h3>
          <p className="mt-1 text-[11px] leading-5 text-text-muted">
            {t('settings.organization.description')}
          </p>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={organizationBusy}
            onClick={handleOrganizationExport}
            className="rounded-lg border border-border-subtle bg-bg-card/70 px-3 py-2 text-[11px] font-medium text-text-primary transition-smooth hover:border-accent/35 hover:bg-bg-card disabled:cursor-not-allowed disabled:opacity-45"
          >
            {t('settings.organization.export')}
          </button>
          <button
            type="button"
            disabled={organizationBusy}
            onClick={handleOrganizationImport}
            className="rounded-lg border border-accent/30 bg-accent/[0.08] px-3 py-2 text-[11px] font-medium text-accent transition-smooth hover:bg-accent/[0.13] disabled:cursor-not-allowed disabled:opacity-45"
          >
            {t('settings.organization.import')}
          </button>
        </div>
        <p className="mt-3 text-[10px] leading-4 text-text-tertiary">
          {t('settings.organization.contents')}
        </p>
        {organizationReport && (
          <p className="mt-2 rounded-lg border border-border-subtle bg-bg-card/60 px-3 py-2 text-[10px] leading-4 text-text-muted">
            {reportSummary(organizationReport)}
          </p>
        )}
        {organizationStatus && (
          <p
            className={`mt-2 text-[10px] leading-4 ${organizationStatus.startsWith(t('settings.organization.error')) ? 'text-red-400' : 'text-emerald-500'}`}
            role="status"
          >
            {organizationStatus}
          </p>
        )}
      </section>

      {/* Avatars — AI & User side by side */}
      <div>
        <h3 className="text-[13px] font-medium text-text-primary mb-3">{t('settings.aiAvatar')} / {t('settings.userAvatar')}</h3>
        <div className="flex items-start gap-6">
          {/* AI Avatar */}
          <div className="flex flex-col items-center gap-1.5">
            <button
              onClick={() => fileInputRef.current?.click()}
              className="group relative cursor-pointer"
              title={t('settings.aiAvatarChange')}
            >
              <AiAvatar size="w-14 h-14" rounded="rounded-2xl" />
              <div className="absolute inset-0 rounded-2xl bg-black/40 opacity-0 group-hover:opacity-100
                transition-smooth flex items-center justify-center">
                <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round">
                  <path d="M12 9v4H4V9M8 3v7M5 6l3-3 3 3" />
                </svg>
              </div>
            </button>
            <span className="text-[11px] text-text-tertiary">AI</span>
            {aiAvatarUrl && (
              <button
                onClick={() => setAiAvatarUrl('')}
                className="text-[11px] text-text-muted hover:text-red-500 transition-smooth"
              >
                {t('settings.aiAvatarReset')}
              </button>
            )}
          </div>

          {/* User Avatar + Name */}
          <div className="flex flex-col items-center gap-1.5">
            <button
              onClick={() => userFileInputRef.current?.click()}
              className="group relative cursor-pointer"
              title={t('settings.userAvatarChange')}
            >
              <UserAvatar size="w-14 h-14" rounded="rounded-2xl" />
              <div className="absolute inset-0 rounded-2xl bg-black/40 opacity-0 group-hover:opacity-100
                transition-smooth flex items-center justify-center">
                <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round">
                  <path d="M12 9v4H4V9M8 3v7M5 6l3-3 3 3" />
                </svg>
              </div>
            </button>
            <input
              type="text"
              value={userDisplayName}
              onChange={(e) => setUserDisplayName(e.target.value)}
              placeholder={t('settings.userNamePlaceholder')}
              className="w-24 px-2 py-1 rounded-md text-[11px] text-center bg-bg-secondary border border-border-subtle
                text-text-primary placeholder-text-tertiary focus:outline-none focus:border-accent/50 transition-smooth"
              maxLength={20}
            />
            {userAvatarUrl && (
              <button
                onClick={() => setUserAvatarUrl('')}
                className="text-[11px] text-text-muted hover:text-red-500 transition-smooth"
              >
                {t('settings.userAvatarReset')}
              </button>
            )}
          </div>

          <input ref={fileInputRef} type="file" accept="image/*" className="hidden"
            onChange={(e) => handleFileSelect(e, 'ai')} />
          <input ref={userFileInputRef} type="file" accept="image/*" className="hidden"
            onChange={(e) => handleFileSelect(e, 'user')} />
        </div>
      </div>

      {/* Avatar crop modal */}
      {cropFile && (
        <AvatarCropModal
          imageFile={cropFile}
          onSave={(dataUrl) => {
            if (cropTarget === 'ai') setAiAvatarUrl(dataUrl);
            else setUserAvatarUrl(dataUrl);
            setCropFile(null);
          }}
          onCancel={() => setCropFile(null)}
        />
      )}

      {/* Settings row */}
      <div className="flex items-start gap-8 flex-wrap">
        {/* Language */}
        <div>
          <h3 className="text-[13px] font-medium text-text-primary mb-2">{t('settings.language')}</h3>
          <div className="inline-flex rounded-md border border-border-subtle overflow-hidden">
            {(['zh', 'en'] as const).map((l) => (
              <button
                key={l}
                onClick={() => setLocale(l)}
                className={`py-1.5 px-3 text-[13px] font-medium transition-smooth
                  border-r border-border-subtle last:border-r-0
                  ${locale === l
                    ? 'bg-accent/10 text-accent'
                    : 'text-text-muted hover:bg-bg-secondary'
                  }`}
              >
                {l === 'zh' ? '中文' : 'EN'}
              </button>
            ))}
          </div>
        </div>

        {/* Font Size */}
        <div>
          <h3 className="text-[13px] font-medium text-text-primary mb-2">{t('settings.fontSize')}</h3>
          <div className="inline-flex items-center rounded-md border border-border-subtle
            overflow-hidden">
            <button
              onClick={() => setFontSize(fontSize - 1)}
              disabled={fontSize <= 10}
              className="w-8 h-8 text-[13px] font-bold text-text-primary
                hover:bg-bg-secondary transition-smooth
                disabled:opacity-30 disabled:cursor-not-allowed
                flex items-center justify-center border-r border-border-subtle"
            >-</button>
            <span className="w-12 text-center text-[13px] font-semibold text-text-primary">
              {fontSize}px
            </span>
            <button
              onClick={() => setFontSize(fontSize + 1)}
              disabled={fontSize >= 24}
              className="w-8 h-8 text-[13px] font-bold text-text-primary
                hover:bg-bg-secondary transition-smooth
                disabled:opacity-30 disabled:cursor-not-allowed
                flex items-center justify-center border-l border-border-subtle"
            >+</button>
          </div>
        </div>

        {/* Provider-native model roles */}
        <div className="space-y-3">
          <div>
            <h3 className="text-[13px] font-medium text-text-primary mb-1">{t('model.mainRole')}</h3>
            <p className="mb-2 text-[11px] text-text-tertiary">{activeProvider?.name ?? 'Claude'}</p>
            <div className="flex flex-wrap gap-2">
              {modelOptions.map((model) => (
              <button
                key={model.id}
                onClick={() => setSelectedModel(model.id)}
                className={`inline-flex items-center gap-1.5 px-3 py-2
                  rounded-md text-[13px] font-medium transition-smooth
                  ${selectedModelOption === model.id
                    ? 'bg-accent/10 text-accent border border-accent/30'
                    : 'text-text-muted hover:bg-bg-secondary border border-border-subtle'
                  }`}
              >
                {selectedModelOption === model.id && (
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
                    stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <path d="M3 8l4 4 6-7" />
                  </svg>
                )}
                {model.label}
              </button>
              ))}
            </div>
          </div>
          <div>
            <h3 className="text-[13px] font-medium text-text-primary mb-1">{t('model.auxiliaryRole')}</h3>
            <p className="mb-2 max-w-2xl text-[11px] leading-4 text-text-tertiary">
              {t('model.auxiliaryRoleHint')}
            </p>
            <div className="flex flex-wrap gap-2">
              {modelOptions.map((model) => (
                <button
                  key={`auxiliary:${model.id}`}
                  onClick={() => setAuxiliaryModel(model.id)}
                  className={`inline-flex items-center gap-1.5 px-3 py-2
                    rounded-md text-[13px] font-medium transition-smooth
                    ${auxiliaryModelOption === model.id
                      ? 'bg-accent/10 text-accent border border-accent/30'
                      : 'text-text-muted hover:bg-bg-secondary border border-border-subtle'
                    }`}
                >
                  {auxiliaryModelOption === model.id && (
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
                      stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                      <path d="M3 8l4 4 6-7" />
                    </svg>
                  )}
                  {model.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
