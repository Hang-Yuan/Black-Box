import { useEffect, useRef, useState } from 'react';
import { useCommandStore } from '../../stores/commandStore';
import { useT } from '../../lib/i18n';
import { announceHeaderPopover, subscribeHeaderPopover } from '../../lib/header-popover';
import type { NativeGoalState } from '../../lib/native-goal';

/**
 * Thin entry point for Claude Code's runtime-owned `/goal` command.
 * Black Box deliberately owns no Goal lifecycle, budget, continuation, or
 * persistence semantics.
 */
export function GoalControl({
  active = false,
  goal,
  disabled = false,
  onSelect,
}: {
  active?: boolean;
  goal?: NativeGoalState;
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
  const running = goal?.status === 'active';
  const achieved = goal?.status === 'achieved';
  const goalStatusLabel = goal
    ? t(goal.status === 'achieved' ? 'goal.status.completed' : `goal.status.${goal.status}`)
    : t('goal.none');

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
        data-goal-live={running ? 'true' : 'false'}
        data-goal-status={goal?.status || 'none'}
        data-runtime-available={nativeAvailable ? 'true' : 'false'}
        aria-busy={running}
        onClick={selectMode}
        disabled={disabled || !nativeAvailable}
        className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[10px]
          transition-smooth disabled:cursor-not-allowed disabled:opacity-40 ${active
            ? 'border-accent/40 bg-accent/15 text-accent'
            : running
            ? 'border-accent/25 bg-accent/10 text-accent'
            : achieved
            ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-400'
            : 'border-border-subtle text-text-tertiary hover:bg-bg-secondary hover:text-text-primary'
          }`}
        title={nativeAvailable ? t('goal.nativeHint') : t('goal.unavailable')}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${running
          ? 'bg-accent animate-pulse-soft'
          : active ? 'bg-accent'
          : achieved ? 'bg-emerald-400'
          : 'bg-text-tertiary/40'}`} />
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
          <div className="text-sm font-semibold text-text-primary">
            {goal ? t('goal.current') : t('goal.create')}
          </div>
          <div data-testid="goal-explainer" className="mt-1 text-xs leading-relaxed text-text-tertiary">
            {nativeAvailable ? t('goal.nativeHint') : t('goal.unavailable')}
          </div>
          {goal && (
            <div data-testid="goal-current" className="mt-3 rounded-lg border border-border-subtle bg-bg-secondary p-3">
              <div className="flex items-center justify-between gap-3 text-[10px]">
                <span className="text-text-tertiary">{t('goal.statusLabel')}</span>
                <span className={running ? 'text-accent' : achieved ? 'text-emerald-400' : 'text-text-tertiary'}>
                  {goalStatusLabel}
                </span>
              </div>
              <div className="mt-2 max-h-28 overflow-y-auto whitespace-pre-wrap text-[11px] leading-relaxed text-text-primary">
                {goal.condition}
              </div>
              {(goal.iterations !== undefined || goal.tokens !== undefined) && (
                <div className="mt-2 flex gap-3 text-[10px] text-text-tertiary">
                  {goal.iterations !== undefined && <span>{t('goal.turns')} {goal.iterations}</span>}
                  {goal.tokens !== undefined && <span>{t('goal.tokens')} {goal.tokens.toLocaleString()}</span>}
                </div>
              )}
            </div>
          )}
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
