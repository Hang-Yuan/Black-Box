import { useEffect, useState } from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import { useChatStore } from '../../stores/chatStore';
import { useSessionStore } from '../../stores/sessionStore';
import { ConversationList } from '../conversations/ConversationList';
import { useT } from '../../lib/i18n';
import { useAgentStore } from '../../stores/agentStore';
import { useFileStore } from '../../stores/fileStore';
import { bridge } from '../../lib/tauri-bridge';

export function Sidebar() {
  const toggleSidebar = useSettingsStore((s) => s.toggleSidebar);
  const openSettings = useSettingsStore((s) => s.openSettings);
  const mainView = useSettingsStore((s) => s.mainView);
  const setMainView = useSettingsStore((s) => s.setMainView);
  const cliUpdateAvailable = useSettingsStore((s) => s.cliUpdateAvailable);
  const [scheduledStatus, setScheduledStatus] = useState({ unread: 0, running: false });
  const t = useT();

  // Scheduled is a first-class inbox, not a setting the user should have to
  // remember. Poll the durable backend summary so the sidebar remains useful
  // even when the Scheduled panel has never been opened in this app session.
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const items = await bridge.listAutomations();
        if (cancelled) return;
        setScheduledStatus({
          unread: items.reduce((total, item) => total + item.unreadRuns, 0),
          running: items.some((item) => item.running),
        });
      } catch {
        // Keep the last known badge on transient backend errors.
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <div className="flex flex-col h-full pt-7 pb-3">
      {/* Logo area */}
      <div
        className="flex items-center justify-between mb-4 mt-1 pl-5 pr-3.5 cursor-default">
        <span className="text-[15px] font-bold tracking-tight text-text-primary pointer-events-none">
          Black <span style={{color: 'var(--color-accent)'}}>Box</span>
        </span>
        <button onClick={toggleSidebar}
          className="p-1 rounded-md hover:bg-bg-tertiary text-text-tertiary
            transition-smooth" title={t('sidebar.hide')}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="1.5">
            <path d="M10 4L6 8L10 12" />
          </svg>
        </button>
      </div>

      {/* New Chat — ghost style */}
      <div className="px-3">
      <button onClick={() => {
        const currentTabId = useSessionStore.getState().selectedSessionId;
        if (currentTabId) {
          useChatStore.getState().saveToCache(currentTabId);
          useAgentStore.getState().saveToCache(currentTabId);
        }
        useAgentStore.getState().clearAgents();
        useSessionStore.getState().setSelectedSession(null);
        useSettingsStore.getState().setWorkingDirectory('');
        setMainView('chat');
      }}
        {...(import.meta.env.DEV && { 'data-testid': 'new-session-button' })}
        className="w-full py-1.5 px-3 rounded-md text-xs font-medium
          bg-transparent border border-border-subtle text-text-secondary
          hover:border-accent/40 hover:text-accent hover:bg-accent/5
          transition-smooth mb-2
          flex items-center justify-center gap-2">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none"
          stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M8 3v10M3 8h10" />
        </svg>
        {t('sidebar.newChat')}
      </button>
      </div>

      {/* Conversation History */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden min-h-0 no-scrollbar">
        <ConversationList />
      </div>

      {/* Footer */}
      <div className="pt-2 mt-2 border-t border-border-subtle px-3 space-y-0.5">
        <button
          onClick={() => {
            useFileStore.getState().closePreview();
            const settings = useSettingsStore.getState();
            if (settings.secondaryPanelOpen) settings.toggleSecondaryPanel();
            setMainView('taskCenter');
          }}
          data-testid="task-center-button"
          className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-smooth ${mainView === 'taskCenter'
            ? 'bg-accent/10 text-accent'
            : 'text-text-muted hover:bg-bg-secondary hover:text-text-primary'}`}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 3.5h10M3 8h10M3 12.5h10" />
            <circle cx="5" cy="3.5" r="1.25" fill="var(--color-bg-primary)" />
            <circle cx="10.5" cy="8" r="1.25" fill="var(--color-bg-primary)" />
            <circle cx="7" cy="12.5" r="1.25" fill="var(--color-bg-primary)" />
          </svg>
          <span className="min-w-0 flex-1 truncate text-left">{t('taskCenter.sidebar')}</span>
        </button>
        <button
          onClick={() => {
            useFileStore.getState().closePreview();
            const settings = useSettingsStore.getState();
            if (settings.secondaryPanelOpen) settings.toggleSecondaryPanel();
            setMainView('extensions');
          }}
          data-testid="extensions-button"
          className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-smooth ${mainView === 'extensions'
            ? 'bg-accent/10 text-accent'
            : 'text-text-muted hover:bg-bg-secondary hover:text-text-primary'}`}
        >
          <svg width="16" height="16" viewBox="0 0 18 18" fill="none"
            stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
            <path d="M7.2 2.2h3.6v3.1h3v3.5h-3v3h-3.6v-3h-3V5.3h3V2.2Z" />
            <path d="M7.2 2.2a1.8 1.8 0 0 1 3.6 0M13.8 5.3a1.75 1.75 0 0 1 0 3.5M10.8 11.8a1.8 1.8 0 0 1-3.6 0M4.2 8.8a1.75 1.75 0 0 1 0-3.5" />
          </svg>
          <span className="min-w-0 flex-1 truncate text-left">{t('extensions.sidebar')}</span>
        </button>
        <button
          onClick={() => {
            useFileStore.getState().closePreview();
            const settings = useSettingsStore.getState();
            if (settings.secondaryPanelOpen) settings.toggleSecondaryPanel();
            setMainView('automations');
          }}
          aria-label={scheduledStatus.unread > 0
            ? `${t('settings.tab.automations')} (${scheduledStatus.unread})`
            : t('settings.tab.automations')}
          {...(import.meta.env.DEV && { 'data-testid': 'scheduled-button' })}
          className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-smooth ${mainView === 'automations'
            ? 'bg-accent/10 text-accent'
            : 'text-text-muted hover:bg-bg-secondary hover:text-text-primary'}`}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <circle cx="8" cy="8" r="6" />
            <path d="M8 4.5V8l2.5 1.5M3 2.5l1.5 1M13 2.5l-1.5 1" />
          </svg>
          <span className="min-w-0 flex-1 truncate text-left">{t('settings.tab.automations')}</span>
          {scheduledStatus.running && (
            <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-accent animate-pulse" aria-hidden="true" />
          )}
          {scheduledStatus.unread > 0 && (
            <span className="h-2 w-2 flex-shrink-0 rounded-full bg-amber-500" aria-hidden="true" />
          )}
        </button>
        <button onClick={() => openSettings(cliUpdateAvailable ? 'cli' : 'general')}
          {...(import.meta.env.DEV && { 'data-testid': 'settings-button' })}
          aria-label={cliUpdateAvailable ? `${t('settings.title')} · ${t('update.available')}` : t('settings.title')}
          className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md
            text-sm text-text-muted hover:bg-bg-secondary hover:text-text-primary
            transition-smooth">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
          <span className="min-w-0 flex-1 truncate text-left">{t('settings.title')}</span>
          {cliUpdateAvailable && (
            <span className="h-2 w-2 flex-shrink-0 rounded-full bg-red-500" aria-hidden="true" />
          )}
        </button>
      </div>
    </div>
  );
}
