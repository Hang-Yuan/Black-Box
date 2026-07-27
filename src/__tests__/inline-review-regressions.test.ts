import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const rust = readFileSync(resolve(root, '../src-tauri/src/lib.rs'), 'utf8');
const automations = readFileSync(resolve(root, 'components/settings/AutomationsTab.tsx'), 'utf8');
const conversations = readFileSync(resolve(root, 'components/conversations/ConversationList.tsx'), 'utf8');
const inlineReview = readFileSync(resolve(root, 'components/review/InlinePatchReview.tsx'), 'utf8');

describe('inline patch review safety', () => {
  it('persists comments atomically in bounded application metadata', () => {
    expect(rust).toContain('blackbox_data_path("review-comments.json")');
    expect(rust).toContain('Review comments payload exceeds the 2 MiB safety limit');
    expect(rust).toContain('Failed to atomically replace review comments file');
  });

  it('binds comments to real diff sides and line coordinates', () => {
    expect(inlineReview).toContain('reviewCoordinate(line)');
    expect(inlineReview).toContain('lineText: line.content');
    expect(inlineReview).toContain('data-testid="inline-review-comment"');
  });

  it('prefills the durable source task but never auto-sends review feedback', () => {
    expect(automations).toContain('continueAutomationRun(run, reviewFeedback)');
    expect(automations).toContain('detail: { sessionId: session.id, draftText }');
    expect(conversations).toContain('detail?.draftText?.trim()');
    expect(conversations).toContain('setInputDraft');
    expect(automations).not.toContain('bridge.sendMessage');
  });
});
