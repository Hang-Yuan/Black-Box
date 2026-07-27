import { useEffect, useRef, useState } from 'react';
import { useProviderStore, type ApiProvider } from '../../stores/providerStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useT } from '../../lib/i18n';
import { announceHeaderPopover, subscribeHeaderPopover } from '../../lib/header-popover';

export function maskedProviderKey(provider: ApiProvider): string {
  if (provider.credentialHint?.trim()) return provider.credentialHint.trim();
  const key = provider.apiKey?.trim() || '';
  if (!key) return '';
  const suffix = key.slice(-4);
  return `•••• ${suffix}`;
}

function KeyIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="5" cy="8" r="3" />
      <path d="M8 8h6M11 8v2M13 8v2" />
    </svg>
  );
}

export function ProviderQuickSelector({ compact = false }: { compact?: boolean }) {
  const t = useT();
  const providers = useProviderStore((state) => state.providers);
  const activeProviderId = useProviderStore((state) => state.activeProviderId);
  const loaded = useProviderStore((state) => state.loaded);
  const setActive = useProviderStore((state) => state.setActive);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!loaded) void useProviderStore.getState().load();
  }, [loaded]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  useEffect(() => subscribeHeaderPopover('provider', () => setOpen(false)), []);

  const active = providers.find((provider) => provider.id === activeProviderId) ?? null;
  const activeLabel = active?.name || (activeProviderId ? t('provider.unnamed') : t('provider.inheritShort'));

  const select = (providerId: string | null) => {
    setActive(providerId);
    setOpen(false);
  };

  return (
    <div ref={ref} className={`relative min-w-0 ${compact ? 'max-w-[92px]' : 'max-w-[190px]'}`}>
      <button
        type="button"
        data-testid="provider-quick-selector"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => {
          const next = !value;
          if (next) announceHeaderPopover('provider');
          return next;
        })}
        className={`inline-flex w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-0.5
          text-[9px] text-text-tertiary transition-smooth hover:bg-bg-secondary/50
          hover:text-text-primary ${compact ? 'max-w-[92px]' : 'max-w-[190px]'}`}
        title={activeLabel}
      >
        <span className="flex-shrink-0 text-text-tertiary"><KeyIcon /></span>
        <span className="truncate">{activeLabel}</span>
        <svg width="8" height="8" viewBox="0 0 8 8" fill="none"
          stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
          className={`flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}>
          <path d="M1.5 3L4 5.5 6.5 3" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          data-testid="provider-quick-menu"
          className="absolute left-0 top-full z-50 mt-1 w-[280px] overflow-hidden rounded-lg
            border border-border-subtle bg-bg-card py-1 shadow-xl animate-fade-in"
        >
          <div className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-text-tertiary">
            {t('provider.quickSwitch')}
          </div>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={!activeProviderId}
            onClick={() => select(null)}
            className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-smooth
              ${!activeProviderId
                ? 'bg-accent/10 text-accent'
                : 'text-text-muted hover:bg-bg-secondary hover:text-text-primary'}`}
          >
            <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-bg-tertiary">
              <KeyIcon />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{t('provider.inherit')}</span>
              <span className="block truncate text-[10px] text-text-tertiary">{t('provider.inheritDesc')}</span>
            </span>
            {!activeProviderId && <span className="text-accent">✓</span>}
          </button>

          {providers.map((provider) => {
            const selected = provider.id === activeProviderId;
            const keyHint = maskedProviderKey(provider);
            return (
              <button
                key={provider.id}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                data-provider-id={provider.id}
                onClick={() => select(provider.id)}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-smooth
                  ${selected
                    ? 'bg-accent/10 text-accent'
                    : 'text-text-muted hover:bg-bg-secondary hover:text-text-primary'}`}
              >
                <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-bg-tertiary">
                  <KeyIcon />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{provider.name || t('provider.unnamed')}</span>
                  <span className="block truncate text-[10px] text-text-tertiary">
                    {keyHint || t('provider.noStoredKey')}
                  </span>
                </span>
                {selected && <span className="text-accent">✓</span>}
              </button>
            );
          })}

          <div className="mx-2 my-1 border-t border-border-subtle" />
          <button
            type="button"
            onClick={() => {
              useSettingsStore.getState().openSettings('provider');
              setOpen(false);
            }}
            className="w-full px-3 py-2 text-left text-[11px] text-text-tertiary
              transition-smooth hover:bg-bg-secondary hover:text-text-primary"
          >
            {t('provider.manageKeys')}
          </button>
        </div>
      )}
    </div>
  );
}
