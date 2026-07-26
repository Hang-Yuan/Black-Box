import { useEffect, useState } from 'react';
import {
  bridge,
  type AutomationActivitySummary,
} from '../../lib/tauri-bridge';
import { useSettingsStore } from '../../stores/settingsStore';
import { ActivityCenter } from './ActivityCenter';

const ACTIVITY_REFRESH_MS = 5_000;

export function TaskCenterView() {
  const [automations, setAutomations] = useState<AutomationActivitySummary[]>([]);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const next = await bridge.listAutomationActivitySummaries();
        if (!cancelled) setAutomations(next);
      } catch {
        // Retain the last metadata-only snapshot during transient backend
        // failures. The task center never falls back to full automation runs.
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), ACTIVITY_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const returnToChat = () => useSettingsStore.getState().setMainView('chat');

  const openThread = (threadId: string) => {
    returnToChat();
    // ConversationList owns hydration and loads exactly the selected session.
    // Deferring until the chat view mounts keeps task-center opening itself
    // metadata-only and prevents any background JSONL scan.
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('blackbox:open-session', {
        detail: { sessionId: threadId },
      }));
    }, 0);
  };

  return (
    <ActivityCenter
      automations={automations}
      onOpenThread={openThread}
      onClose={returnToChat}
    />
  );
}
