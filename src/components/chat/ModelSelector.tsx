import { useState, useRef, useEffect } from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import { useChatStore, generateMessageId } from '../../stores/chatStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useProviderStore } from '../../stores/providerStore';
import { getModelDisplayOptions, getSelectedModelOptionId } from '../../lib/api-provider';
import { announceHeaderPopover, subscribeHeaderPopover } from '../../lib/header-popover';
import { useT } from '../../lib/i18n';

export function ModelSelector({ disabled = false }: { disabled?: boolean }) {
  const selectedModel = useSettingsStore((s) => s.selectedModel);
  const auxiliaryModel = useSettingsStore((s) => s.auxiliaryModel);
  const setSelectedModel = useSettingsStore((s) => s.setSelectedModel);
  const setAuxiliaryModel = useSettingsStore((s) => s.setAuxiliaryModel);
  const providers = useProviderStore((s) => s.providers);
  const activeProviderId = useProviderStore((s) => s.activeProviderId);
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  useEffect(() => subscribeHeaderPopover('model', () => setOpen(false)), []);

  const activeProvider = providers.find((provider) => provider.id === activeProviderId) ?? null;
  const displayOptions = getModelDisplayOptions(activeProvider);
  const selectedOptionId = getSelectedModelOptionId(selectedModel, displayOptions);
  const auxiliaryOptionId = getSelectedModelOptionId(auxiliaryModel, displayOptions);

  const current = displayOptions.find((m) => m.id === selectedOptionId) || displayOptions[0];

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => {
          if (disabled) return;
          if (!open) announceHeaderPopover('model');
          setOpen(!open);
        }}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        {...(import.meta.env.DEV && { 'data-testid': 'model-selector' })}
        className="inline-flex max-w-[210px] items-center gap-1 px-2.5 py-1 rounded-md
          text-xs text-text-muted hover:text-text-primary
          hover:bg-bg-secondary transition-smooth
          disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
          stroke="currentColor" strokeWidth="1.5" className="flex-shrink-0">
          <circle cx="8" cy="8" r="5.5" />
          <path d="M8 5v3l2 1.5" strokeLinecap="round" />
        </svg>
        <span className="truncate">{current.short}</span>
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          {...(import.meta.env.DEV && { 'data-testid': 'model-menu' })}
          className="absolute bottom-full right-0 mb-1 w-72
          bg-bg-card border border-border-subtle rounded-lg shadow-lg
          p-2 z-50 animate-in fade-in slide-in-from-bottom-1 duration-150"
        >
          <div className="px-1 pb-2 text-[11px] text-text-tertiary truncate">
            {activeProvider?.name ?? 'Claude'}
          </div>
          <div className="px-1 pb-1 text-[11px] font-medium text-text-muted">
            {t('model.mainRole')}
          </div>
          <div className="space-y-0.5">
            {displayOptions.map((option) => (
              <button
                key={option.id}
                role="menuitemradio"
                aria-checked={option.id === selectedOptionId}
                {...(import.meta.env.DEV && { 'data-testid': `model-option-${option.id}` })}
                onClick={() => {
                  if (option.id !== selectedOptionId) {
                    const oldShort = current.short;
                    const newShort = option.short;
                    setSelectedModel(option.id);
                    // Insert model-switch tag into chat immediately
                    const msTabId = useSessionStore.getState().selectedSessionId;
                    if (msTabId) {
                      useChatStore.getState().addMessage(msTabId, {
                        id: generateMessageId(),
                        role: 'system',
                        type: 'text',
                        content: `${oldShort} → ${newShort}`,
                        commandType: 'model-switch',
                        timestamp: Date.now(),
                      });
                    }
                  }
                  setOpen(false);
                }}
                className={`w-full text-left px-3 py-2 text-xs
                  transition-smooth flex items-center justify-between
                  ${option.id === selectedOptionId
                    ? 'text-accent bg-accent/5'
                    : 'text-text-muted hover:text-text-primary hover:bg-bg-secondary'
                  }`}
              >
                <div className="min-w-0">
                  <div className="font-medium truncate">{option.label}</div>
                  {option.providerModel && option.label !== option.providerModel && (
                    <div className="mt-0.5 truncate text-[10px] text-text-tertiary">{option.providerModel}</div>
                  )}
                </div>
                {option.id === selectedOptionId && (
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none"
                    stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="shrink-0 ml-2">
                    <path d="M3 8l3.5 3.5L13 5" />
                  </svg>
                )}
              </button>
            ))}
          </div>

          <div className="mx-1 my-2 border-t border-border-subtle" />
          <div className="px-1 pb-1">
            <div className="text-[11px] font-medium text-text-muted">{t('model.auxiliaryRole')}</div>
            <div className="mt-0.5 text-[10px] leading-4 text-text-tertiary">
              {t('model.auxiliaryRoleHint')}
            </div>
          </div>
          <div className="space-y-0.5">
            {displayOptions.map((option) => (
              <button
                key={`auxiliary:${option.id}`}
                role="menuitemradio"
                aria-checked={option.id === auxiliaryOptionId}
                {...(import.meta.env.DEV && { 'data-testid': `auxiliary-model-option-${option.id}` })}
                onClick={() => {
                  setAuxiliaryModel(option.id);
                  setOpen(false);
                }}
                className={`w-full text-left px-3 py-2 text-xs
                  transition-smooth flex items-center justify-between rounded-md
                  ${option.id === auxiliaryOptionId
                    ? 'text-accent bg-accent/5'
                    : 'text-text-muted hover:text-text-primary hover:bg-bg-secondary'
                  }`}
              >
                <div className="min-w-0">
                  <div className="font-medium truncate">{option.label}</div>
                  {option.providerModel && option.label !== option.providerModel && (
                    <div className="mt-0.5 truncate text-[10px] text-text-tertiary">{option.providerModel}</div>
                  )}
                </div>
                {option.id === auxiliaryOptionId && (
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none"
                    stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="shrink-0 ml-2">
                    <path d="M3 8l3.5 3.5L13 5" />
                  </svg>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
