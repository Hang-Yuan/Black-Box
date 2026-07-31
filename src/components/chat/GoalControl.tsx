import { useEffect, useRef, useState } from 'react';
import { useCommandStore } from '../../stores/commandStore';
import { useT } from '../../lib/i18n';
import { announceHeaderPopover, subscribeHeaderPopover } from '../../lib/header-popover';

/**
 * Thin entry point for Claude Code's runtime-owned `/goal` command.
 * Black Box deliberately owns no Goal lifecycle, budget, continuation, or
 * persistence semantics.
 */
export function GoalControl({
  active = false,
  disabled = false,
  onSelect,
}: {
  active?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  const t = useT();
  const commands = useCommandStore((state) => state.commands);
  const nativeAvailable = commands.some((command) => (
    command.name.toLowerCase() === '/goal'
    && command.owner === 'claude'
    && command.runtime_available === true
  ));
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  useEffect(() => subscribeHeaderPopover('goal', () => setOpen(false)), []);

  const selectMode = () => {
    if (!nativeAvailable || disabled) return;
    setOpen(false);
    announceHeaderPopover('goal');
    onSelect();
  };

  return (
    <div ref={ref} className="relative mr-1 flex items-center">
      <button
        type="button"
        data-testid="goal-button"
        data-active={active ? 'true' : 'false'}
        data-runtime-available={nativeAvailable ? 'true' : 'false'}
        onClick={selectMode}
        disabled={disabled || !nativeAvailable}
        className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[10px]
          transition-smooth disabled:cursor-not-allowed disabled:opacity-40 ${active
            ? 'border-accent/40 bg-accent/15 text-accent'
            : 'border-border-subtle text-text-tertiary hover:bg-bg-secondary hover:text-text-primary'
          }`}
        title={nativeAvailable ? t('goal.nativeHint') : t('goal.unavailable')}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${active ? 'bg-accent' : 'bg-text-tertiary/40'}`} />
        <span className="blackbox-toolbar-full-label">Goal</span>
        <span className="blackbox-toolbar-compact-label" aria-hidden="true">G</span>
      </button>

      <button
        type="button"
        data-testid="goal-manage"
        onClick={() => setOpen((value) => {
          const next = !value;
          if (next) announceHeaderPopover('goal');
          return next;
        })}
        aria-label={t('goal.title')}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="ml-0.5 rounded-md p-1 text-text-tertiary hover:bg-bg-secondary hover:text-text-primary"
      >
        <svg width="9" height="9" viewBox="0 0 10 10" fill="none"
          stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
          <path d="M2 4l3 3 3-3" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-[400px] rounded-xl border
          border-border-subtle bg-bg-card p-3 shadow-xl" data-testid="goal-popover">
          <div className="text-sm font-semibold text-text-primary">{t('goal.create')}</div>
          <div data-testid="goal-explainer" className="mt-1 text-xs leading-relaxed text-text-tertiary">
            {nativeAvailable ? t('goal.nativeHint') : t('goal.unavailable')}
          </div>
          <button
            type="button"
            data-testid="goal-create-option"
            data-active={active ? 'true' : 'false'}
            data-runtime-available={nativeAvailable ? 'true' : 'false'}
            onClick={selectMode}
            disabled={active || disabled || !nativeAvailable}
            className="mt-3 flex w-full items-center justify-between rounded-lg border
              border-border-subtle bg-bg-secondary px-3 py-2 text-left text-[11px]
              text-text-primary hover:border-border-focus hover:bg-bg-tertiary
              disabled:cursor-default disabled:opacity-60"
          >
            <span>
              <span className="block font-medium">
                {t(active ? 'goal.modeActive' : 'goal.useMode')}
              </span>
              <span className="mt-0.5 block text-[10px] text-text-tertiary">
                {t('goal.useModeHint')}
              </span>
            </span>
            {!active && nativeAvailable && (
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
                stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 2l4 4-4 4" />
              </svg>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
