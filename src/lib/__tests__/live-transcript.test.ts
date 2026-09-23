import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../stores/chatStore';
import { useChatStore } from '../../stores/chatStore';
import { useSessionStore } from '../../stores/sessionStore';
import { bridge } from '../tauri-bridge';
import { reconcileDurableSessionTranscript } from '../live-transcript-sync';
import {
  findTranscriptMessageMatch,
  hasLeadResponseAfterLatestUser,
  liveTranscriptRevisionKey,
  sameTranscriptMessage,
} from '../live-transcript';

function message(partial: Partial<ChatMessage>): ChatMessage {
  return {
    id: partial.id ?? crypto.randomUUID(),
    role: partial.role ?? 'assistant',
    type: partial.type ?? 'text',
    content: partial.content ?? '',
    timestamp: partial.timestamp ?? 1,
    ...partial,
  };
}

describe('live transcript projection', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useChatStore.setState({ tabs: new Map(), sessionCache: new Map() });
    useSessionStore.setState({ sessions: [], selectedSessionId: null });
  });

  it('recognizes a persisted lead final after the latest user turn', () => {
    expect(hasLeadResponseAfterLatestUser([
      message({ role: 'user', timestamp: 10 }),
      message({ role: 'assistant', timestamp: 20, isFinalResponse: true }),
    ])).toBe(true);
    expect(hasLeadResponseAfterLatestUser([
      message({ role: 'assistant', timestamp: 20, isFinalResponse: true }),
      message({ role: 'user', timestamp: 30 }),
    ])).toBe(false);
    expect(hasLeadResponseAfterLatestUser([
      message({ role: 'user', timestamp: 10 }),
      message({ role: 'assistant', timestamp: 20, isFinalResponse: true, subAgentDepth: 1 }),
    ])).toBe(false);
    expect(hasLeadResponseAfterLatestUser([
      message({ role: 'user', timestamp: 10 }),
      message({ role: 'assistant', timestamp: 20, isFinalResponse: true }),
      message({ role: 'assistant', timestamp: 30, isApiErrorMessage: true }),
    ])).toBe(false);
  });

  it('matches a durable user record to its optimistic foreground bubble', () => {
    const optimistic = message({
      id: 'local-message',
      role: 'user',
      content: '需要我和你讨论什么呢？',
      timestamp: 10_000,
      awaitingPersistence: true,
    });
    const durable = message({
      id: 'claude-uuid',
      checkpointUuid: 'claude-uuid',
      role: 'user',
      content: '需要我和你讨论什么呢？',
      timestamp: 11_000,
    });
    expect(findTranscriptMessageMatch([optimistic], durable)).toBe(optimistic);
    expect(findTranscriptMessageMatch([
      { ...optimistic, content: '另一条消息' },
    ], durable)).toBeUndefined();
    expect(findTranscriptMessageMatch([
      { ...optimistic, awaitingPersistence: false },
    ], durable)).toBeUndefined();
  });

  it('reconciles a replayed image prompt after the stream cleared its pending flag', () => {
    const optimistic = message({
      id: 'msg_1789895810000_1',
      role: 'user',
      content: '继续企业大脑的开发。看一下天璇那边的情况。',
      timestamp: 10_000,
      awaitingPersistence: false,
      attachments: [{ name: 'image.png', path: '/tmp/image.png', isImage: true }],
    });
    const durable = message({
      id: '8fa8532d-f0d4-44ea-a3dc-524551c9208c',
      role: 'user',
      content: optimistic.content,
      timestamp: 11_000,
      attachments: [
        { name: 'image_17898958180320.png', path: '/workspace/.blackbox/tmp/image_17898958180320.png', isImage: true },
        { name: 'image-detail-1-x0-y0.png', path: '/workspace/.blackbox/tmp/image-detail-1-x0-y0.png', isImage: true },
      ],
    });

    expect(findTranscriptMessageMatch([optimistic], durable)).toBe(optimistic);
  });

  it('does not claim one local bubble for two repeated durable messages', () => {
    const first = message({
      id: 'msg_10000_1', role: 'user', content: '继续', timestamp: 10_000,
    });
    const second = message({
      id: 'msg_20000_2', role: 'user', content: '继续', timestamp: 20_000,
    });
    const claimed = new Set<string>();
    const durableFirst = message({
      id: 'durable-1', role: 'user', content: '继续', timestamp: 10_100,
    });
    const firstMatch = findTranscriptMessageMatch([first, second], durableFirst, claimed);
    expect(firstMatch).toBe(first);
    claimed.add(firstMatch!.id);
    expect(findTranscriptMessageMatch([
      first, second,
    ], message({
      id: 'durable-2', role: 'user', content: '继续', timestamp: 20_100,
    }), claimed)).toBe(second);
  });

  it('matches when an optimistic steer persists as the next ordinary prompt', () => {
    const optimistic = message({
      id: 'local-steer',
      role: 'user',
      content: '需要我和你讨论什么呢？',
      timestamp: 10_000,
      isSteer: true,
      steerState: 'sent',
      awaitingPersistence: true,
    });
    const durable = message({
      id: 'claude-next-turn',
      role: 'user',
      content: '需要我和你讨论什么呢？',
      timestamp: 11_000,
    });

    expect(findTranscriptMessageMatch([optimistic], durable)).toBe(optimistic);
  });

  it('uses cheap file metadata as a stable revision key', () => {
    expect(liveTranscriptRevisionKey({ bytes: 42, modifiedMs: 99 })).toBe('42:99');
  });

  it('detects material transcript message changes', () => {
    const left = message({ id: 'final', content: 'done', isFinalResponse: true, cwd: '/a' });
    expect(sameTranscriptMessage(left, { ...left })).toBe(true);
    expect(sameTranscriptMessage(left, { ...left, cwd: '/b' })).toBe(false);
    expect(sameTranscriptMessage(left, { ...left, isApiErrorMessage: true })).toBe(false);
    expect(sameTranscriptMessage(left, { ...left, isSteer: true, steerState: 'sent' })).toBe(false);
  });

  it('repairs the final cwd after the turn has already completed', async () => {
    const sessionId = 'terminal-cwd-race';
    const root = '/Users/test/workspace';
    const deep = `${root}/Dev/project/streams/09-meta-agent`;
    useSessionStore.setState({
      sessions: [{
        id: sessionId,
        path: '/tmp/terminal-cwd-race.jsonl',
        project: root,
        projectDir: '-Users-test-workspace',
        modifiedAt: 1,
        preview: 'Terminal cwd race',
        cliResumeId: sessionId,
      }],
      selectedSessionId: sessionId,
    });
    const chat = useChatStore.getState();
    chat.ensureTab(sessionId);
    chat.addMessage(sessionId, message({
      id: 'answer_text_0',
      content: 'Open `README.md`.',
      cwd: root,
      isFinalResponse: true,
    }));
    chat.setSessionStatus(sessionId, 'completed');

    vi.spyOn(bridge, 'getSessionFileRevision').mockResolvedValue({ bytes: 100, modifiedMs: 200 });
    vi.spyOn(bridge, 'loadSession').mockResolvedValue([{
      type: 'assistant',
      cwd: deep,
      timestamp: 2,
      message: {
        id: 'answer',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Open `README.md`.' }],
      },
    }]);

    const result = await reconcileDurableSessionTranscript(sessionId);

    expect(result).toEqual({ revision: '100:200', changed: true });
    expect(chat.getTab(sessionId)?.sessionStatus).toBe('completed');
    expect(chat.getTab(sessionId)?.messages).toHaveLength(1);
    expect(chat.getTab(sessionId)?.messages[0]).toMatchObject({
      id: 'answer_text_0',
      cwd: deep,
      content: 'Open `README.md`.',
      isFinalResponse: true,
    });
  });

  it('keeps one foreground bubble when the durable image prompt contains generated crops', async () => {
    const sessionId = 'image-prompt-replay';
    const timestamp = Date.parse('2026-09-20T09:17:10.365Z');
    useSessionStore.setState({
      sessions: [{
        id: sessionId,
        path: '/tmp/image-prompt-replay.jsonl',
        project: '/workspace',
        projectDir: '-workspace',
        modifiedAt: 1,
        preview: 'Image prompt replay',
        cliResumeId: sessionId,
      }],
      selectedSessionId: sessionId,
    });
    const chat = useChatStore.getState();
    chat.ensureTab(sessionId);
    chat.addMessage(sessionId, message({
      id: 'msg_1789895830365_1',
      role: 'user',
      content: '继续企业大脑的开发。看一下天璇那边的情况。',
      timestamp,
      awaitingPersistence: false,
      attachments: [{
        name: 'image.png', path: '/tmp/image.png', isImage: true, preview: 'data:image/png;base64,abc',
      }],
    }));

    vi.spyOn(bridge, 'getSessionFileRevision').mockResolvedValue({ bytes: 200, modifiedMs: 300 });
    vi.spyOn(bridge, 'loadSession').mockResolvedValue([{
      type: 'user',
      uuid: '8fa8532d-f0d4-44ea-a3dc-524551c9208c',
      cwd: '/workspace',
      timestamp: '2026-09-20T09:17:10.365Z',
      message: {
        role: 'user',
        content: [{
          type: 'text',
          text: [
            '继续企业大脑的开发。看一下天璇那边的情况。',
            '',
            '[附加的文件]',
            '/workspace/.blackbox/tmp/image_17898958180320.png',
            'Read the original for layout. For small text, read only the relevant original-resolution detail crops (source x/y coordinates in filenames):',
            '/workspace/.blackbox/tmp/image-detail-1-x0-y0_17898958180671.png',
          ].join('\n'),
        }],
      },
    }]);

    await reconcileDurableSessionTranscript(sessionId);

    const messages = chat.getTab(sessionId)?.messages ?? [];
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: 'msg_1789895830365_1',
      checkpointUuid: '8fa8532d-f0d4-44ea-a3dc-524551c9208c',
      awaitingPersistence: false,
      content: '继续企业大脑的开发。看一下天璇那边的情况。',
      attachments: [{ name: 'image.png', path: '/tmp/image.png', isImage: true }],
    });
  });
});
