import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const read = (relative: string) => readFileSync(resolve(root, relative), 'utf8');

describe('per-conversation provider and model routing', () => {
  it('restores runtime preferences before every interactive switch path', () => {
    const app = read('App.tsx');
    const conversations = read('components/conversations/ConversationList.tsx');
    const ctrlTab = app.slice(
      app.indexOf('// Ctrl+Tab: quick-switch'),
      app.indexOf('// Load file tree', app.indexOf('// Ctrl+Tab: quick-switch')),
    );

    expect(conversations).toContain(
      'await restoreConversationRuntimePreference(sessionId)',
    );
    expect(ctrlTab).toContain(
      'await restoreConversationRuntimePreference(previousSessionId)',
    );
    expect(ctrlTab.indexOf('await restoreConversationRuntimePreference(previousSessionId)'))
      .toBeLessThan(ctrlTab.indexOf('restoreFromCache(previousSessionId)'));
  });

  it('does not persist credentials in the conversation preference schema', () => {
    const runtime = read('lib/conversation-runtime-preferences.ts');
    const metadata = read('../src-tauri/src/session_metadata.rs');
    expect(runtime).toContain('providerId');
    expect(runtime).not.toContain('apiKey');
    expect(runtime).not.toContain('credentialRef');
    expect(metadata).toContain('Credentials stay exclusively in providers.json');
  });
});
