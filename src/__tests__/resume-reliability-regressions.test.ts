import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const read = (relative: string) => readFileSync(resolve(root, relative), 'utf8');

describe('durable resume reliability regressions', () => {
  it('persists the last real task beyond the lifetime of one webview window', () => {
    const source = read('stores/sessionStore.ts');
    expect(source).toContain("localStorage.setItem(LAST_SESSION_KEY, id)");
    expect(source).toContain("localStorage.getItem(LAST_SESSION_KEY)");
  });

  it('settles orphaned CLI children before the sidebar restores a task', () => {
    const lifecycle = read('lib/sessionLifecycle.ts');
    const conversations = read('components/conversations/ConversationList.tsx');
    const rustManager = read('../src-tauri/src/commands/claude_process.rs');
    expect(lifecycle).toContain('settleOrphanedBackendProcesses');
    expect(lifecycle).toContain('await bridge.gracefulStopSession(stdinId)');
    expect(lifecycle).toContain('await settleOrphanedBackendProcesses();');
    expect(lifecycle).toContain('throw error;');
    expect(conversations).toContain('settleOrphanedBackendProcesses()');
    expect(conversations).toContain('Session recovery barrier failed; disk restore is paused');
    expect(rustManager).toContain('claims.by_stdin.keys().cloned()');
    expect(rustManager).toContain('wait_for_exit_receiver_or_claim_release');
  });

  it('holds send/resume behind an exclusive disk-hydration generation', () => {
    const conversations = read('components/conversations/ConversationList.tsx');
    const input = read('components/chat/InputBar.tsx');
    expect(conversations).toContain('hydratingFromDisk: true');
    expect(conversations).toContain('sessionMeta.hydrationGeneration');
    expect(conversations).toContain('!== hydrationGeneration');
    expect(input).toContain('sessionMeta.hydratingFromDisk');
    expect(input).toContain('disabled={isAwaiting || isStopping || isHydratingFromDisk');
  });

  it('adopts a background draft identity before routing stream events', () => {
    const stream = read('hooks/useStreamProcessor.ts');
    const identity = read('lib/session-identity.ts');
    const backgroundBranch = stream.indexOf('const isBackground = Boolean(ownerTabId && ownerTabId !== activeTabId)');
    expect(stream.indexOf('captureCliSessionIdentity(ownerTabId, msg, msgStdinId)'))
      .toBeLessThan(backgroundBranch);
    expect(identity).toContain('sessions.promoteDraft(currentTabId, durableId)');
    expect(identity).toContain('useAgentStore.getState().moveCache(currentTabId, durableId)');
  });

  it('keeps slow auto-compact busy until a real CLI settlement event', () => {
    const stream = read('hooks/useStreamProcessor.ts');
    expect(stream).toContain('markPendingCommandSlow(tabId, compactMsgId');
    expect(stream).toContain('markPendingCommandSlow(tabId, bgCompactMsgId');
    expect(stream).not.toContain("completePendingCommand(tabId, { output: 'Compact timed out' })");
  });

  it('flushes live CLI sessions before native app exit', () => {
    const rust = read('../src-tauri/src/lib.rs');
    const capabilities = read('../src-tauri/capabilities/default.json');
    const app = read('App.tsx');
    expect(rust).toContain('async fn graceful_stop_all_sessions_inner(');
    expect(rust).toContain('futures_util::future::join_all(stops)');
    expect(rust).toContain('.filter_map(Result::err)');
    const windowClose = rust.indexOf('WindowEvent::CloseRequested');
    const windowSettlement = rust.indexOf(
      'let failures = graceful_stop_all_sessions_inner(',
      windowClose,
    );
    expect(windowSettlement)
      .toBeLessThan(rust.indexOf('app.exit(0);', windowClose));
    const quit = rust.indexOf('RunEvent::ExitRequested { api, code, .. }');
    const quitSettlement = rust.indexOf(
      'let failures = graceful_stop_all_sessions_inner(',
      quit,
    );
    expect(windowClose).toBeGreaterThan(-1);
    expect(windowSettlement).toBeGreaterThan(windowClose);
    expect(quit).toBeGreaterThan(-1);
    expect(quitSettlement).toBeGreaterThan(quit);
    expect(quitSettlement).toBeLessThan(rust.indexOf('app.exit(code.unwrap_or(0));', quit));
    expect(rust).toContain('api.prevent_exit();');
    expect(rust).toContain('app.exit(code.unwrap_or(0));');
    expect(capabilities).toContain('core:window:allow-close');
    expect(app).toContain('__blackbox_close_started');
    expect(app).toContain('__blackbox_mcp_listeners_started');
  });

  it('tracks a spawned CLI UUID before returning control to the webview', () => {
    const rust = read('../src-tauri/src/lib.rs');
    const tracking = rust.indexOf('track_managed_session(cli_session_id.clone()).await');
    const response = rust.indexOf('Ok(SessionInfo {', tracking);
    expect(tracking).toBeGreaterThan(-1);
    expect(response).toBeGreaterThan(tracking);
  });

  it('rewind persists the selected durable checkpoint and keeps the resume UUID', () => {
    const source = read('hooks/useRewind.ts');
    const rust = read('../src-tauri/src/lib.rs');
    expect(source).toContain('await bridge.rewindSessionConversation(durableSessionId, conversationCheckpoint)');
    expect(source).toContain('rewindInFlightTabs.has(tid)');
    expect(source).toContain('resolveFileRestoreRequest(turn, tid, state)');
    expect(source).toContain('await killProcess(tid)');
    expect(source).toContain('await bridge.rewindFilesStandalone');
    expect(source).toContain('await bridge.rewindAllTransaction');
    const transaction = source.slice(source.indexOf('const executeRewind'));
    expect(transaction.indexOf('await killProcess(tid)'))
      .toBeLessThan(transaction.indexOf('await bridge.rewindFilesStandalone'));
    expect(transaction.indexOf('await killProcess(tid)'))
      .toBeLessThan(transaction.indexOf('await bridge.rewindAllTransaction'));
    expect(source).not.toContain('getActiveTabState');
    expect(source).not.toContain('setCliResumeId(tid, null)');
    expect(source).not.toContain('sessionId: undefined');
    const checkpointConfig = rust.slice(
      rust.indexOf('// Enable CLI-managed file checkpoints for every SDK session.'),
      rust.indexOf('// For models with a 1M context window'),
    );
    expect(checkpointConfig).toContain('CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING');
    expect(checkpointConfig).not.toContain('if provider_caps.is_native_anthropic');
  });

  it('serializes manual and automatic compact ahead of pending follow-ups', () => {
    const input = read('components/chat/InputBar.tsx');
    const stream = read('hooks/useStreamProcessor.ts');
    expect(input).toContain("cmd === 'compact' && isSessionBusy(commandTab.sessionStatus)");
    expect(input).toContain("kind: 'command'");
    const backgroundStart = stream.indexOf('// Auto-compact must outrank pending follow-ups on background tabs');
    const backgroundDrain = stream.indexOf('drainPendingQueueAfterSettlement({', backgroundStart);
    expect(backgroundStart).toBeGreaterThan(-1);
    expect(backgroundDrain).toBeGreaterThan(backgroundStart);
    expect(stream).toContain("item.kind === 'command'");
    expect(stream).toContain('store.shiftPendingMessage(tabId)!');
  });

  it('treats disk, compacted, and tool-only transcripts as durable resume targets', () => {
    const input = read('components/chat/InputBar.tsx');
    const conversations = read('components/conversations/ConversationList.tsx');
    const evidence = read('lib/resume-evidence.ts');
    expect(input).toContain('shouldAttemptDurableResume');
    expect(input).toContain('sessionPath: sessionItem?.path');
    expect(evidence).toContain("'tool_use'");
    expect(evidence).toContain('Boolean(evidence.sessionPath?.trim())');
    expect(conversations).toContain('turnAcceptedForResume: messages.some');
  });

  it('never abandons a thread to hide a resume signature failure', () => {
    const stream = read('hooks/useStreamProcessor.ts');
    const start = stream.indexOf('// A provider/model switch can reject old cryptographic thinking');
    const end = stream.indexOf('// Code mode: Auto-restart when ExitPlanMode', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const guard = stream.slice(start, end);
    expect(guard).toContain('preserving the original resume target');
    expect(guard).toContain("t('error.resumeSignatureMismatch')");
    expect(guard).toContain('setInputDraft');
    expect(guard).not.toContain('setCliResumeId');
    expect(guard).not.toContain('sessionId: undefined');
    expect(guard).not.toContain('spawnSession');
    expect(guard).not.toContain('auto-retrying without resume');
  });

  it('uses graceful process settlement for internal restart paths', () => {
    const source = read('lib/sessionLifecycle.ts');
    expect(source).toContain("reason === 'stop' || reason === 'delete'");
    expect(source).toContain('bridge.gracefulStopSession(stdinId)');
  });

  it('keeps the Worktree rewind/compact tool-boundary matrix as a repeatable smoke', () => {
    const smoke = read('../scripts/resume-reliability-smoke.mjs');
    const nativeCloseSmoke = read('../scripts/native-close-resume-smoke.mjs');
    const isolation = read('../scripts/run-isolated.sh');
    const cli = read('../scripts/blackbox-cli.mjs');
    const input = read('components/chat/InputBar.tsx');
    const panel = read('components/chat/RewindPanel.tsx');
    expect(smoke).toContain("cli(['handoff-task', 'worktree'");
    expect(smoke).toContain("'rewind-conversation',");
    expect(smoke).toContain("cli(['type', '/compact'])");
    expect(smoke).toContain("cli(['restart', '--timeout', '30000']");
    expect(smoke).toContain("if (/opus|fable/i.test(report.resolvedModel))");
    expect(smoke).toContain('assertNoPrivateToolAccess(report.jsonlPath, privateRoots)');
    expect(isolation).toContain('Refusing unsafe model execution root');
    expect(isolation).toContain('BLACKBOX_PRIVATE_ROOTS');
    expect(isolation).toContain('BLACKBOX_EXTERNAL_EXECUTION_ROOT');
    expect(nativeCloseSmoke).toContain('localToolToNativeClose');
    expect(nativeCloseSmoke).toContain('worktreeToolToNativeClose');
    expect(nativeCloseSmoke).toContain("cli(['exec', 'window.__blackbox_test.closeWindow()'])");
    expect(nativeCloseSmoke).toContain("cli(['exec', 'window.__blackbox_test.quitApp()'])");
    expect(nativeCloseSmoke).toContain('RunEvent::ExitRequested settlement');
    expect(nativeCloseSmoke).toContain('report.checks.cmdQResume = true');
    expect(nativeCloseSmoke).toContain('report.checks.busyManualCompactQueued = true');
    expect(nativeCloseSmoke).toContain('report.checks.backgroundAutoCompactPriority = true');
    expect(nativeCloseSmoke).toContain('Plain text sent');
    expect(nativeCloseSmoke).toContain('Queued compact did not take stdin ownership');
    expect(nativeCloseSmoke).toContain('Compact-owned follow-up bypassed the queue');
    expect(nativeCloseSmoke).toContain('report.checks.hydrationSendBlocked = true');
    expect(nativeCloseSmoke).toContain('Background dispatch order was not compact-first');
    expect(nativeCloseSmoke).toContain('Hydration submit reached the CLI bridge');
    expect(nativeCloseSmoke).toContain("if (!finalSession.cliResumeId)");
    expect(nativeCloseSmoke).toContain("if (!finalSession.path)");
    expect(nativeCloseSmoke).not.toContain("finalSession?.cliResumeId || report.uiThreadId");
    expect(nativeCloseSmoke).toContain("'--action', 'restore_all'");
    expect(nativeCloseSmoke).toContain('restore_all left the discarded file');
    expect(nativeCloseSmoke).toContain("cli(['type', '/compact'])");
    expect(nativeCloseSmoke).toContain('Sidebar refresh changed CLI UUID');
    expect(nativeCloseSmoke).toContain('SIDEBAR_REFRESH_OK');
    expect(nativeCloseSmoke).toContain('compactSurvivesNativeRelaunch');
    expect(cli).toContain("async 'rewind-conversation'");
    expect(input).toContain('data-testid="rewind-button"');
    expect(panel).toContain('data-testid={`rewind-turn-${i}`}');
    expect(panel).toContain('data-testid={`rewind-action-${a.action}`}');
  });
});
