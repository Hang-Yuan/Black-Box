import { useEffect, useState } from 'react';
import { type SettingsTab, useSettingsStore } from '../../stores/settingsStore';
import { useT } from '../../lib/i18n';
import { APP_NAME } from '../../lib/edition';
import { GeneralTab } from './GeneralTab';
import { ProviderTab } from './ProviderTab';
import { CliTab } from './CliTab';
import { DesktopPetSetting } from './DesktopPetSetting';

const TAB_ICONS: Record<SettingsTab, React.ReactNode> = {
  general: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M3.05 12.95l1.41-1.41M11.54 4.46l1.41-1.41" />
    </svg>
  ),
  provider: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5 7V5a3 3 0 016 0v2" />
      <circle cx="8" cy="11" r="1" fill="currentColor" />
    </svg>
  ),
  cli: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1" y="2" width="14" height="12" rx="2" />
      <path d="M4 6l3 2.5L4 11M9 11h3" />
    </svg>
  ),
  desktopPet: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5.1 7.4C3.5 7.4 2.3 8.7 2.3 10.2c0 1.8 1.5 3.1 3.3 2.6.9-.2 1.5-.8 2.4-.8s1.5.6 2.4.8c1.8.5 3.3-.8 3.3-2.6 0-1.5-1.2-2.8-2.8-2.8-1.3 0-2.1.8-2.9 1.7-.8-.9-1.6-1.7-2.9-1.7Z" />
      <circle cx="3.2" cy="5.1" r="1.4" />
      <circle cx="6.4" cy="3.5" r="1.4" />
      <circle cx="9.6" cy="3.5" r="1.4" />
      <circle cx="12.8" cy="5.1" r="1.4" />
    </svg>
  ),
};

const TAB_ITEMS: { id: SettingsTab; labelKey: string }[] = [
  { id: 'general', labelKey: 'settings.tab.general' },
  { id: 'provider', labelKey: 'settings.tab.provider' },
  { id: 'cli', labelKey: 'settings.tab.cli' },
  { id: 'desktopPet', labelKey: 'settings.tab.desktopPet' },
];

export function SettingsPanel() {
  const t = useT();
  const toggleSettings = useSettingsStore((s) => s.toggleSettings);
  const activeTab = useSettingsStore((s) => s.settingsTab);
  const setActiveTab = useSettingsStore((s) => s.setSettingsTab);
  const cliUpdateAvailable = useSettingsStore((s) => s.cliUpdateAvailable);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') toggleSettings();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [toggleSettings]);

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center"
      onMouseDown={(e) => { if (e.target === e.currentTarget) toggleSettings(); }}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" />

      {/* Panel */}
      <div className="relative w-[min(90vw,960px)] max-h-[85vh] min-h-[500px]
        rounded-xl bg-bg-card border border-border-subtle shadow-2xl
        overflow-hidden animate-fade-in flex flex-col"
        {...(import.meta.env.DEV && { 'data-testid': 'settings-panel' })}>

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4
          border-b border-border-subtle flex-shrink-0">
          <h2 className="text-lg font-semibold text-text-primary">
            {t('settings.title')}
          </h2>
          <button onClick={toggleSettings}
            {...(import.meta.env.DEV && { 'data-testid': 'settings-close-button' })}
            className="p-1.5 rounded-md hover:bg-bg-tertiary
              text-text-tertiary transition-smooth">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.5">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>

        {/* Body: sidebar + content */}
        <div className="flex flex-1 min-h-0">
          {/* Tab sidebar */}
          <nav className="w-[160px] border-r border-border-subtle px-2 py-4 space-y-1 flex-shrink-0">
            {TAB_ITEMS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                {...(import.meta.env.DEV && { 'data-testid': `settings-tab-${tab.id}` })}
                className={`w-full flex items-center gap-1.5 px-2.5 py-2 rounded-md text-[13px]
                  font-medium transition-smooth text-left whitespace-nowrap
                  ${activeTab === tab.id
                    ? 'bg-accent/10 text-accent'
                    : 'text-text-muted hover:bg-bg-secondary hover:text-text-primary'
                  }`}
              >
                <span className="flex-shrink-0 opacity-70">{TAB_ICONS[tab.id]}</span>
                <span className="min-w-0 flex-1">{t(tab.labelKey)}</span>
                {tab.id === 'cli' && cliUpdateAvailable && (
                  <span className="h-2 w-2 flex-shrink-0 rounded-full bg-red-500" aria-label={t('update.available')} />
                )}
              </button>
            ))}
          </nav>

          {/* Content area */}
          <div className="flex-1 overflow-y-auto px-8 py-6">
            {activeTab === 'general' && <GeneralTab />}
            {activeTab === 'provider' && <ProviderTab />}
            {activeTab === 'cli' && <CliTab />}
            {activeTab === 'desktopPet' && <DesktopPetSetting />}
          </div>
        </div>

        {/* Footer: local build identity only. App updates stay disabled until
            this fork owns a signed release channel. */}
        <SettingsFooter />
      </div>
    </div>
  );
}

function SettingsFooter() {
  const [appVersion, setAppVersion] = useState('');

  useEffect(() => {
    import('@tauri-apps/api/app').then(({ getVersion }) =>
      getVersion().then(setAppVersion).catch(() => {})
    );
  }, []);

  return (
    <div className="flex h-10 flex-shrink-0 items-center px-6
      border-t border-border-subtle bg-bg-secondary/30">
      <span className="flex items-center gap-1.5 text-xs text-text-tertiary">
        <img src="/app-logo.png" alt="" className="h-[14px] w-[14px] flex-shrink-0 rounded-sm opacity-80" />
        {APP_NAME} {appVersion ? `v${appVersion}` : '...'}
      </span>
    </div>
  );
}
