import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const rust = readFileSync(resolve(root, '../src-tauri/src/lib.rs'), 'utf8');
const rustParams = readFileSync(resolve(root, '../src-tauri/src/commands/claude_process.rs'), 'utf8');
const input = readFileSync(resolve(root, 'components/chat/InputBar.tsx'), 'utf8');
const stream = readFileSync(resolve(root, 'hooks/useStreamProcessor.ts'), 'utf8');
const conversations = readFileSync(resolve(root, 'components/conversations/ConversationList.tsx'), 'utf8');
const menu = readFileSync(resolve(root, 'components/conversations/SessionContextMenu.tsx'), 'utf8');
const chat = readFileSync(resolve(root, 'components/chat/ChatPanel.tsx'), 'utf8');
const smoke = readFileSync(resolve(root, '../scripts/fork-lifecycle-smoke.mjs'), 'utf8');
const identity = readFileSync(resolve(root, 'lib/session-identity.ts'), 'utf8');
const forkStore = readFileSync(resolve(root, 'stores/forkStore.ts'), 'utf8');
const historicalFork = readFileSync(resolve(root, 'lib/historical-fork.ts'), 'utf8');
const rewindPanel = readFileSync(resolve(root, 'components/chat/RewindPanel.tsx'), 'utf8');

describe('conversation fork safety and continuity', () => {
  it('uses Claude Code native deterministic fork semantics', () => {
    expect(rustParams).toContain('pub fork_session: Option<bool>');
    expect(rust).toContain('args.push("--resume".to_string())');
    expect(rust).toContain('args.push("--fork-session".to_string())');
    expect(rust).toContain('args.push("--session-id".to_string())');
    expect(rust).toContain('if params.model_switch.unwrap_or(false) && !fork_session');
  });

  it('forks only on the first child spawn and clears the source credential after promotion', () => {
    expect(input).toContain('const forkSourceId = resumeTab?.sessionMeta.forkSourceId');
    expect(input).toContain('fork_session: forkSourceId ? true : undefined');
    expect(stream).toContain('captureCliSessionIdentity');
    expect(identity).toContain('useForkStore.getState().moveFork(currentTabId, durableId)');
    expect(identity).toContain('forkSourceId: undefined');
  });

  it('clones visible history without cloning a Goal or Plan control plane', () => {
    expect(conversations).toContain('parseSessionMessages(rawMessages)');
    expect(conversations).toContain('createPendingFork(draftId, parentThreadId, parentTitle, cwd)');
    expect(conversations).not.toContain('moveGoal(session.id');
    expect(conversations).not.toContain('movePlan(session.id');
  });

  it('blocks running and managed-Worktree sources and exposes durable lineage', () => {
    expect(menu).toContain('forkDisabled');
    expect(conversations).toContain("location.currentLocation === 'worktree'");
    expect(rust).toContain('blackbox_data_path("forks.json")');
    expect(rust).toContain('Failed to atomically replace forks file');
    expect(chat).toContain('data-testid="fork-banner"');
    expect(chat).toContain('data-testid="open-fork-parent"');
  });

  it('opens any other completed conversation in a resizable read-only side-by-side pane', () => {
    expect(menu).toContain('data-testid={`compare-session-${session.id}`}');
    expect(conversations).toContain('openComparison(session.id)');
    expect(forkStore).toContain('comparisonThreadId?: string');
    expect(chat).toContain('data-testid="compare-fork-parent"');
    expect(chat).toContain('data-testid="conversation-compare-pane"');
    expect(chat).toContain('data-testid="conversation-compare-resize"');
    expect(chat).toContain('parseSessionMessages(rawMessages).messages');
    expect(chat).not.toContain('<InputBar comparison');
  });

  it('creates arbitrary historical forks through a native child and rewinds only that child', () => {
    expect(rewindPanel).toContain('data-testid={`rewind-action-${a.action}`}');
    expect(rewindPanel).toContain("action: 'fork'");
    expect(historicalFork).toContain('resume_session_id: request.parentSessionId');
    expect(historicalFork).toContain('fork_session: true');
    expect(historicalFork).toContain("await api.sendStdin(process.stdin_id, '/cost')");
    expect(historicalFork).toContain('await api.gracefulStopSession(process.stdin_id)');
    expect(historicalFork).toContain('await api.rewindSessionConversation(childSessionId, request.checkpointUuid)');
    expect(forkStore).toContain("forkPoint: 'tip' | 'checkpoint'");
  });

  it('keeps a Haiku/Sonnet-only immutable-parent lifecycle smoke', () => {
    expect(smoke).toContain("cli(['switch-model', 'haiku'])");
    expect(smoke).toContain('/opus|fable/i');
    expect(smoke).toContain('parentHashAfterFork');
    expect(smoke).toContain('nativeForkFlagsObserved');
    expect(smoke).toContain('nativeRelaunchPersisted');
    expect(smoke).toContain('configuredPrivateRoots(projectRoot)');
    expect(smoke).toContain('assertNoPrivateToolAccess(report.parentJsonl, privateRoots)');
  });
});
