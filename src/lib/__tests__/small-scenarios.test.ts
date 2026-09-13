import { beforeEach, describe, expect, it } from 'vitest';
import { extractResponseArtifacts } from '../response-artifacts';
import { imageDetailTiles } from '../image-detail';
import { projectExecutionEvent } from '../execution-state';
import { planContextBudget, classifySessionSilence } from '../context-recovery';
import { parseSessionMessages } from '../session-loader';
import { useChatStore } from '../../stores/chatStore';

describe('execution ownership and delayed final delivery', () => {
  it('ignores duplicate terminal receipts after the next execution starts', () => {
    const first = projectExecutionEvent({}, { type: 'assistant', __executionId: 'process:1' });
    const terminal = projectExecutionEvent(first.next, { type: 'result', uuid: 'r1', __executionId: 'process:1' });
    const next = projectExecutionEvent(terminal.next, { type: 'assistant', __executionId: 'process:2' });
    expect(next.progress).toBe(true);
    const duplicate = projectExecutionEvent(next.next, { type: 'result', uuid: 'r1', __executionId: 'process:1' });
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.next.executionId).toBe('process:2');
    const supplement = projectExecutionEvent(next.next, { type: 'assistant', __executionId: 'process:1', message: { stop_reason: 'end_turn' } });
    expect(supplement.duplicate).toBe(false);
    expect(supplement.progress).toBe(false);
  });
  it('keeps the parent running when a child result arrives', () => {
    const result = projectExecutionEvent({ executionId: 'p:1' }, { type: 'result', parent_tool_use_id: 'tool-1', __executionId: 'p:1' });
    expect(result.next.closedExecutionIds).toEqual([]);
    expect(projectExecutionEvent(result.next, { type: 'stream_event', event: { type: 'content_block_delta' }, __executionId: 'p:1' }).progress).toBe(true);
  });
});

describe('provider-private reasoning stays out of product state', () => {
  beforeEach(() => useChatStore.setState({ tabs: new Map(), sessionCache: new Map() }));
  it('has identical visible final output live and after reloading native records', () => {
    const sentinel = 'PRIVATE_REASONING_SENTINEL_01453';
    const raw = [{ type: 'assistant', uuid: 'record-1', message: { id: 'm1', stop_reason: 'end_turn', content: [
      { type: 'thinking', thinking: sentinel, signature: sentinel }, { type: 'text', text: 'Public final answer' },
    ] } }, { type: 'assistant', uuid: 'late', message: { id: 'm1', content: [
      { type: 'thinking', thinking: sentinel }, { type: 'text', text: 'Public final answer' },
    ] } }];
    const loaded = parseSessionMessages(raw);
    expect(JSON.stringify(loaded)).not.toContain(sentinel);
    expect(loaded.messages).toHaveLength(1);
    expect(loaded.messages[0].isFinalResponse).toBe(true);
    const store = useChatStore.getState(); store.ensureTab('t1');
    store.addMessage('t1', { id: 'private', role: 'assistant', type: 'thinking', content: sentinel, timestamp: 1 });
    store.updatePartialThinking('t1', sentinel);
    store.addMessage('t1', loaded.messages[0]);
    store.addMessage('t1', { ...loaded.messages[0], isFinalResponse: false });
    store.updateMessage('t1', loaded.messages[0].id, { isFinalResponse: false });
    expect(store.getTab('t1')?.messages).toEqual(loaded.messages);
    expect(JSON.stringify(store.getTab('t1'))).not.toContain(sentinel);
  });
});

describe('long responses and dense screenshots', () => {
  it('delivers code losslessly with summaries, directory names and independent files', () => {
    const code = Array.from({ length: 40 }, (_, i) => `SELECT '${i} 中文';`).join('\n');
    const markdown = `Summary before.\n\n\`\`\`sql file=queries/report.sql\n${code}\n\`\`\`\n\nValidation passed.\n\n\`\`\`json file=config.json\n${' '.repeat(1801)}\n\`\`\``;
    const projected = extractResponseArtifacts(markdown);
    expect(projected.artifacts).toHaveLength(2);
    expect(projected.artifacts[0]).toMatchObject({ name: 'queries/report.sql', content: `${code}\n` });
    expect(projected.markdown).toContain('Summary before.');
    expect(projected.markdown).toContain('Validation passed.');
    expect(projected.markdown).not.toContain("SELECT '0");
  });
  it('keeps incomplete streaming blocks and short examples inline', () => {
    const incomplete = `\`\`\`typescript\n${'x'.repeat(2000)}`;
    expect(extractResponseArtifacts(incomplete)).toEqual({ markdown: incomplete, artifacts: [] });
    expect(extractResponseArtifacts('```js\nconsole.log(1)\n```').artifacts).toHaveLength(0);
  });
  it('covers every source pixel with 1:1 bounded detail crops and no skinny redundant strips', () => {
    const tiles = imageDetailTiles(3840, 2160);
    expect(tiles).toHaveLength(12);
    for (let y = 0; y < 2160; y += 11) for (let x = 0; x < 3840; x += 11) {
      expect(tiles.some((tile) => x >= tile.x && x < tile.x + tile.width && y >= tile.y && y < tile.y + tile.height)).toBe(true);
    }
    expect(tiles.every((tile) => tile.width <= 1024 && tile.height <= 1024)).toBe(true);
    expect(imageDetailTiles(1441, 3000)).toHaveLength(8);
    expect(imageDetailTiles(1200, 900)).toEqual([]);
    expect(imageDetailTiles(1536, 1536)).toHaveLength(4);
    expect(imageDetailTiles(100_000, 100_000)).toEqual([]);
  });
});

describe('context reserve and silence classification', () => {
  it('uses the last API window after reload, including cached input rather than cumulative result usage', () => {
    const loaded = parseSessionMessages([
      { type: 'assistant', message: { usage: { input_tokens: 100, cache_creation_input_tokens: 30000, cache_read_input_tokens: 120000, output_tokens: 200 }, content: [{ type: 'text', text: 'Done' }] } },
      { type: 'result', usage: { input_tokens: 900000, output_tokens: 50000 } },
    ]);
    expect(loaded.contextInputTokens).toBe(150100);
    expect(loaded.contextOutputTokens).toBe(200);
    expect(planContextBudget(loaded.contextInputTokens!, 'Continue', 160000).compact).toBe(true);
  });
  it('reserves enough space before sending and distinguishes a known dead process from silence', () => {
    expect(planContextBudget(150_000, '继续执行'.repeat(300), 160_000).compact).toBe(true);
    expect(planContextBudget(30_000, '继续', 160_000).compact).toBe(false);
    expect(planContextBudget(0, 'first message', 160_000).compact).toBe(false);
    expect(classifySessionSilence({ now: 500_000, lastProgressAt: 200_000, alive: true })).toBe('stalled');
    expect(classifySessionSilence({ now: 500_000, lastProgressAt: 200_000, waitingForUser: true })).toBe('waiting');
    expect(classifySessionSilence({ now: 500_000, lastProgressAt: 490_000, alive: false })).toBe('dead');
  });
});

describe('late final delivery during a newer execution', () => {
  it('updates the owned answer without clearing the current stream or completing its command', async () => {
    const { applyLateAssistantSupplement } = await import('../../hooks/useStreamProcessor');
    const store = useChatStore.getState(); store.ensureTab('late');
    store.setSessionStatus('late', 'running');
    store.setSessionMeta('late', { executionId: 'p:2', pendingCommandMsgId: 'new-command' });
    store.updatePartialMessage('late', 'Current output is still streaming');
    applyLateAssistantSupplement('late', { type: 'assistant', message: { id: 'old-answer', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Old final with supplement' }] } });
    applyLateAssistantSupplement('late', { type: 'assistant', message: { id: 'old-answer', content: [{ type: 'text', text: 'Old final' }] } });
    const tab = store.getTab('late')!;
    expect(tab.partialText).toBe('Current output is still streaming');
    expect(tab.sessionStatus).toBe('running'); expect(tab.isStreaming).toBe(true);
    expect(tab.sessionMeta.pendingCommandMsgId).toBe('new-command');
    expect(tab.messages[0].content).toBe('Old final with supplement');
    expect(tab.messages[0].isFinalResponse).toBe(true);
  });
});
