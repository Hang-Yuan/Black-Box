import { type ReactNode, useState, useRef, useEffect } from 'react';
import { useSettingsStore, type SessionMode } from '../../stores/settingsStore';
import { useChatStore, generateMessageId } from '../../stores/chatStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useT } from '../../lib/i18n';
import { announceHeaderPopover, subscribeHeaderPopover } from '../../lib/header-popover';

const MODES: { id: SessionMode; labelKey: string; icon: ReactNode }[] = [
  {
    id: 'ask',
    labelKey: 'mode.ask',
    icon: (
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
        stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <circle cx="8" cy="8" r="5.5" />
        <path d="M6 6.5a2 2 0 013.5 1.5c0 1-1.5 1.5-1.5 1.5M8 12v.5" />
      </svg>
    ),
  },
  {
    id: 'code',
    labelKey: 'mode.code',
    icon: (
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
        stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <path d="M5 4L1 8l4 4M11 4l4 4-4 4" />
      </svg>
    ),
  },
  {
    id: 'plan',
    labelKey: 'mode.plan',
    icon: (
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
        stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <path d="M4 4h8M4 8h6M4 12h4" />
      </svg>
    ),
  },
  {
    id: 'auto',
    labelKey: 'mode.auto',
    icon: (
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
        stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 1.75v2M8 12.25v2M1.75 8h2M12.25 8h2M3.58 3.58L5 5M11 11l1.42 1.42M12.42 3.58L11 5M5 11l-1.42 1.42" />
        <circle cx="8" cy="8" r="2.25" />
      </svg>
    ),
  },
  {
    id: 'bypass',
    labelKey: 'mode.bypass',
    icon: (
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
        stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 2l1.5 4H14l-3.5 2.5L12 13 8 10l-4 3 1.5-4.5L2 6h4.5L8 2z" />
      </svg>
    ),
  },
];

export function ModeSelector({
  disabled = false,
  placement = 'up',
  compact = false,
  iconOnly = false,
}: {
  disabled?: boolean;
  placement?: 'up' | 'down';
  compact?: boolean;
  iconOnly?: boolean;
}) {
  const t = useT();
  const sessionMode = useSettingsStore((s) => s.sessionMode);
  const setSessionMode = useSettingsStore((s) => s.setSessionMode);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  useEffect(() => subscribeHeaderPopover('mode', () => setOpen(false)), []);

  const current = MODES.find((m) => m.id === sessionMode) || MODES[0];
  const isBypass = sessionMode === 'bypass';

  const MODE_FEEDBACK: Record<SessionMode, { i18nKey: string; icon: string }> = {
    code: { i18nKey: 'cmd.switchedToCode', icon: '⚡' },
    ask: { i18nKey: 'cmd.switchedToAsk', icon: '💬' },
    plan: { i18nKey: 'cmd.switchedToPlan', icon: '📋' },
    auto: { i18nKey: 'cmd.switchedToAuto', icon: '✨' },
    bypass: { i18nKey: 'cmd.switchedToBypass', icon: '⭐' },
  };

  const switchMode = (mode: SessionMode) => {
    if (mode === sessionMode) return;
    setSessionMode(mode);
    const fb = MODE_FEEDBACK[mode];
    const modeTabId = useSessionStore.getState().selectedSessionId;
    if (modeTabId) {
      useChatStore.getState().addMessage(modeTabId, {
        id: generateMessageId(),
        role: 'system',
        type: 'text',
        content: t(fb.i18nKey),
        commandType: 'mode',
        commandData: { mode, icon: fb.icon },
        timestamp: Date.now(),
      });
    }
  };

  return (
    <div ref={ref} className={`relative ${disabled ? 'opacity-40 pointer-events-none' : ''}`}>
      {/* Trigger button — shows current mode */}
      <button
        onClick={() => setOpen((value) => {
          const next = !value;
          if (next) announceHeaderPopover('mode');
          return next;
        })}
        title={t(current.labelKey)}
        className={`inline-flex items-center gap-1.5 rounded-md
          border transition-smooth cursor-pointer
          ${compact ? 'px-1.5 py-0.5 text-[9px]' : 'px-2 py-1 text-xs'}
          ${isBypass
            ? 'border-warning/30 bg-warning/10 text-warning'
            : 'border-border-subtle bg-bg-secondary/50 text-text-muted hover:text-text-primary hover:bg-bg-secondary'
          }`}
      >
        {current.icon}
        {!iconOnly && <span className="font-medium">{t(current.labelKey)}</span>}
        <svg width="8" height="8" viewBox="0 0 8 8" fill="none"
          stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
          className={`transition-transform duration-150 ${open ? 'rotate-180' : ''}`}>
          <path d="M1.5 3L4 5.5 6.5 3" />
        </svg>
      </button>

      {/* Dropdown menu — placement follows the surrounding toolbar. */}
      {open && (
        <div className={`absolute left-0 min-w-[160px]
          bg-bg-card border border-border-subtle rounded-lg shadow-lg
          py-1 z-50 animate-fade-in
          ${placement === 'down' ? 'top-full mt-1' : 'bottom-full mb-1'}`}>
          {MODES.map((mode) => {
            const isActive = mode.id === sessionMode;
            return (
              <button
                key={mode.id}
                onClick={() => { switchMode(mode.id); setOpen(false); }}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs
                  transition-smooth cursor-pointer
                  ${isActive
                    ? mode.id === 'bypass'
                      ? 'bg-warning/10 text-warning font-medium'
                      : 'bg-accent/10 text-accent font-medium'
                    : 'text-text-muted hover:text-text-primary hover:bg-bg-secondary'
                  }`}
              >
                {mode.icon}
                {t(mode.labelKey)}
                {isActive && (
                  <svg width="10" height="10" viewBox="0 0 12 12" fill="none"
                    stroke="currentColor" strokeWidth="1.5" className="ml-auto">
                    <path d="M2.5 6l2.5 2.5 4.5-4.5" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
