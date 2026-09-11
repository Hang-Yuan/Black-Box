import type { ChatMessage } from '../stores/chatStore';
import { generateMessageId } from '../stores/chatStore';
import type { AgentActivityEntry, AgentKind, AgentPhase } from '../stores/agentStore';
import {
  isForwardedSubagentEvent,
  isFailedAgentTaskStatus,
  messageTextContent,
  parseAgentTaskNotification,
  parseAsyncAgentLaunch,
} from './agent-lifecycle';
import {
  isCliPlaceholder,
  sanitizeAssistantTextForDisplay,
  sanitizeToolResultForDisplay,
} from './presentation-sanitizer';
import { unwrapInterruptedContinuationPrompt } from './interrupted-continuation';

export interface AgentData {
  id: string;
  parentId: string | null;
  description: string;
  phase: AgentPhase;
  startTime: number;
  endTime?: number;
  isMain: boolean;
  kind?: AgentKind;
  name?: string;
  model?: string;
  taskId?: string;
  toolUseIds?: string[];
  background?: boolean;
  activity?: AgentActivityEntry[];
}

export interface LoadedSession {
  messages: ChatMessage[];
  agents: AgentData[];
  mainAgentStartTime: number;
}

/** Claude JSONL timestamps may be epoch numbers or ISO strings. Chat UI needs epoch ms. */
export function normalizeSessionTimestamp(value: unknown, fallback = Date.now()): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date) {
    const parsed = value.getTime();
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

/** Detect system-injected content that should not be shown to users */
function isSystemText(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith('<')                            // XML tags like <system-reminder>
    || t.startsWith('This session is being continued') // continuation summaries
    || /^Analysis:\s*\n/.test(t)                       // continuation analysis blocks
    || /^Summary:\s*\n/.test(t)                        // continuation summary blocks
    || t.startsWith('In this environment you have access to') // tool definitions
    || t.startsWith('Human:')                          // raw conversation format leaks
    || t.includes('<system-reminder>')                 // embedded system reminders
    || t.includes('</system-reminder>');
}

function mergeLoadedThinkingContent(current: string, incoming: string): string {
  const base = current.trim();
  const next = incoming.trim();
  if (!base) return next;
  if (!next || next === base) return base;
  if (next.startsWith(base)) return next;
  if (base.startsWith(next)) return base;
  return `${base}\n\n${next}`;
}

/** Parse raw JSONL messages into structured session data */
export function parseSessionMessages(rawMessages: any[]): LoadedSession {
  const messages: ChatMessage[] = [];
  const agents: AgentData[] = [];

  // Create main agent with session start time
  const firstMsg = rawMessages[0];
  const sessionStartTime = normalizeSessionTimestamp(firstMsg?.timestamp);

  agents.push({
    id: 'main',
    parentId: null,
    description: 'Main',
    phase: 'completed',
    startTime: sessionStartTime,
    endTime: Date.now(),
    isMain: true,
    kind: 'main',
  });

  // Collect tool_use_id → index mapping for binding tool results
  const toolUseIdToIndex = new Map<string, number>();
  const agentIdToIndex = new Map<string, number>([['main', 0]]);

  const upsertLoadedAgent = (agent: AgentData) => {
    const existingIndex = agentIdToIndex.get(agent.id);
    if (existingIndex === undefined) {
      agentIdToIndex.set(agent.id, agents.length);
      agents.push(agent);
      return;
    }
    agents[existingIndex] = { ...agents[existingIndex], ...agent };
  };

  const resolveLoadedAgentId = (toolUseId?: string, taskId?: string) => {
    if (toolUseId && agentIdToIndex.has(toolUseId)) return toolUseId;
    if (toolUseId) {
      const aliasMatch = agents.find((agent) => agent.toolUseIds?.includes(toolUseId));
      if (aliasMatch) return aliasMatch.id;
    }
    if (!taskId) return undefined;
    return agents.find((agent) => agent.taskId === taskId)?.id;
  };

  const appendLoadedAgentActivity = (
    agentId: string | undefined,
    entry: AgentActivityEntry,
  ) => {
    if (!agentId) return;
    const index = agentIdToIndex.get(agentId);
    if (index === undefined || agents[index].isMain) return;
    const agent = agents[index];
    const activity = [...(agent.activity ?? [])];
    const last = activity[activity.length - 1];
    if (
      last
      && last.kind === entry.kind
      && last.content === entry.content
      && last.toolName === entry.toolName
    ) return;
    agents[index] = { ...agent, activity: [...activity, entry].slice(-24) };
  };

  const extractToolResultText = (payload: any): string => {
    if (typeof payload === 'string') return payload;
    if (Array.isArray(payload)) {
      return payload.map((item: any) => item?.text || item?.content || '').join('');
    }
    if (!payload || typeof payload !== 'object') return '';
    if (typeof payload.stdout === 'string') return payload.stdout;
    if (typeof payload.output === 'string') return payload.output;
    if (typeof payload.text === 'string') return payload.text;
    if (typeof payload.content === 'string') return payload.content;
    if (Array.isArray(payload.content)) {
      return payload.content.map((item: any) => item?.text || item?.content || '').join('');
    }
    if (payload.content && typeof payload.content === 'object' && 'text' in payload.content) {
      return String(payload.content.text ?? '');
    }
    return '';
  };

  const bindToolResult = (toolUseId: string | undefined, resultText: string) => {
    if (!toolUseId) return;
    const idx = toolUseIdToIndex.get(toolUseId);
    if (idx === undefined || !messages[idx]) return;
    const safeResult = sanitizeToolResultForDisplay(messages[idx].toolName, resultText);
    messages[idx] = {
      ...messages[idx],
      toolCompleted: true,
      ...(safeResult ? { toolResultContent: safeResult } : {}),
    };
  };

  for (const msg of rawMessages) {
    // Skip system-injected meta messages
    if (msg.isMeta) continue;

    const taskNotification = parseAgentTaskNotification(messageTextContent(msg));
    if (taskNotification) {
      const agentId = resolveLoadedAgentId(
        taskNotification.toolUseId,
        taskNotification.taskId,
      );
      if (agentId) {
        const index = agentIdToIndex.get(agentId)!;
        const agent = agents[index];
        const resultText = taskNotification.resultText
          ? sanitizeAssistantTextForDisplay(taskNotification.resultText).trim().slice(0, 6_000)
          : '';
        agents[index] = {
          ...agent,
          phase: isFailedAgentTaskStatus(taskNotification.status)
            ? 'error'
            : agent.kind === 'teammate'
              ? 'idle'
              : 'completed',
          endTime: normalizeSessionTimestamp(msg.timestamp),
          ...(resultText ? {
            activity: [
              ...(agent.activity ?? []),
              {
                id: `${msg.uuid || taskNotification.taskId || taskNotification.toolUseId}_result`,
                kind: 'text' as const,
                content: resultText,
                timestamp: normalizeSessionTimestamp(msg.timestamp),
              },
            ].slice(-24),
          } : {}),
        };
      }
    }

    // Claude Code persists streaming input sent while the agent loop is busy
    // as a queue-operation plus a queued_command attachment, not as a normal
    // user record. Rehydrate the attachment once so live Steer guidance stays
    // visible after WebView reload or native app restart. The attachment UUID
    // is not a file-checkpoint key, so deliberately omit checkpointUuid.
    if (
      msg.type === 'attachment'
      && msg.attachment?.type === 'queued_command'
      && msg.attachment?.commandMode === 'prompt'
      && typeof msg.attachment?.prompt === 'string'
    ) {
      const content = msg.attachment.prompt.trim();
      if (content && !isSystemText(content) && !isCliPlaceholder(content)) {
        messages.push({
          id: msg.uuid || generateMessageId(),
          role: 'user',
          type: 'text',
          content,
          timestamp: normalizeSessionTimestamp(msg.attachment.timestamp ?? msg.timestamp),
          isSteer: true,
          steerState: 'sent',
        });
      }
      continue;
    }

    const hasTopLevelToolUseResult = Object.prototype.hasOwnProperty.call(msg, 'tool_use_result')
      || Object.prototype.hasOwnProperty.call(msg, 'toolUseResult');
    const hasTopLevelToolResult = Object.prototype.hasOwnProperty.call(msg, 'tool_result')
      || Object.prototype.hasOwnProperty.call(msg, 'toolResult');

    // Handle tool_result messages: attach result to parent tool_use card
    if (hasTopLevelToolUseResult || hasTopLevelToolResult || msg.type === 'tool_result') {
      const blocks = Array.isArray(msg.message?.content)
        ? msg.message.content
        : Array.isArray(msg.content)
          ? msg.content
          : [];
      const topLevelToolUseResult = hasTopLevelToolUseResult
        ? (msg.tool_use_result ?? msg.toolUseResult)
        : undefined;
      const topLevelToolResult = hasTopLevelToolResult
        ? (msg.tool_result ?? msg.toolResult)
        : undefined;
      const topLevelResultText = extractToolResultText(
        hasTopLevelToolUseResult ? topLevelToolUseResult : topLevelToolResult,
      );
      const asyncLaunch = parseAsyncAgentLaunch(msg);
      if (asyncLaunch) {
        const agentId = resolveLoadedAgentId(asyncLaunch.toolUseId, asyncLaunch.taskId)
          ?? asyncLaunch.toolUseId
          ?? asyncLaunch.taskId;
        const existingIndex = agentIdToIndex.get(agentId);
        const existing = existingIndex === undefined ? undefined : agents[existingIndex];
        upsertLoadedAgent({
          id: agentId,
          parentId: existing?.parentId ?? 'main',
          description: asyncLaunch.description ?? existing?.description ?? 'Background Agent',
          // Disk hydration has no owning CLI process. An async launch without a
          // durable terminal notification is historical unfinished work, not a
          // live background Agent. Keep its process history visible while
          // preventing false "still running" banners after restart.
          phase: 'interrupted',
          startTime: existing?.startTime ?? normalizeSessionTimestamp(msg.timestamp),
          endTime: Date.now(),
          isMain: false,
          kind: existing?.kind ?? 'subagent',
          name: existing?.name,
          model: asyncLaunch.model ?? existing?.model,
          taskId: asyncLaunch.taskId,
          toolUseIds: Array.from(new Set([
            ...(existing?.toolUseIds ?? []),
            ...(asyncLaunch.toolUseId ? [asyncLaunch.toolUseId] : []),
          ])),
          background: true,
        });
      }
      for (const b of blocks) {
        if (b?.tool_use_id && (b?.type === 'tool_result' || hasTopLevelToolUseResult || hasTopLevelToolResult)) {
          const blockResultText = extractToolResultText(b.content ?? b.output);
          bindToolResult(
            b.tool_use_id,
            (hasTopLevelToolUseResult || hasTopLevelToolResult)
              ? (topLevelResultText || blockResultText)
              : blockResultText,
          );
        }
      }
      if (msg.type === 'tool_result') {
        bindToolResult(msg.tool_use_id, extractToolResultText(msg.content ?? msg.output));
      } else if (hasTopLevelToolUseResult || hasTopLevelToolResult) {
        bindToolResult(msg.tool_use_id ?? msg.toolUseId, topLevelResultText);
      }
      continue;
    }

    if (msg.type === 'human' || msg.type === 'user' || msg.role === 'user') {
      // Extract text blocks, filtering out system-injected content
      const blocks = Array.isArray(msg.message?.content) ? msg.message.content : [];
      const userTexts: string[] = [];
      for (const b of blocks) {
        const rawText = typeof b === 'string' ? b : b?.type === 'text' ? b.text : '';
        const text = typeof rawText === 'string'
          ? unwrapInterruptedContinuationPrompt(rawText)
          : '';
        if (text && !isSystemText(text) && !isCliPlaceholder(text)) userTexts.push(text);
      }
      // Fallback for plain string content
      if (blocks.length === 0 && typeof msg.message?.content === 'string') {
        const text = unwrapInterruptedContinuationPrompt(msg.message.content);
        if (!isSystemText(text) && !isCliPlaceholder(text)) userTexts.push(text);
      }
      let content = userTexts.join('');
      // Extract file attachments from text
      const attachments: Array<{ name: string; path: string; isImage: boolean }> = [];
      const attachRegex = /\n?\n?\[(?:附加的文件|Attached files)\]\n([\s\S]+)$/;
      const attachMatch = content.match(attachRegex);
      if (attachMatch) {
        content = content.slice(0, attachMatch.index!).trimEnd();
        const paths = attachMatch[1].split('\n').map(p => p.trim()).filter(Boolean);
        for (const p of paths) {
          const name = p.split(/[\\/]/).pop() || p;
          const ext = name.split('.').pop()?.toLowerCase() || '';
          const isImage = ['png','jpg','jpeg','gif','webp','bmp','svg'].includes(ext);
          attachments.push({ name, path: p, isImage });
        }
      }
      if (content.trim()) {
        messages.push({
          id: msg.uuid || generateMessageId(),
          role: 'user',
          type: 'text',
          content,
          timestamp: normalizeSessionTimestamp(msg.timestamp),
          // Claude's replayed user UUID is the native file-checkpoint key.
          // Preserve it across reload so restore_all / restore_code remain
          // available for durable history, not only for the live stream.
          checkpointUuid: msg.uuid || undefined,
          attachments: attachments.length > 0 ? attachments : undefined,
        });
      }
    } else if (msg.type === 'assistant') {
      const blocks = msg.message?.content;
      if (Array.isArray(blocks)) {
        const forwardedSubagentEvent = isForwardedSubagentEvent(msg);
        const forwardedAgentId = forwardedSubagentEvent
          ? resolveLoadedAgentId(msg.parent_tool_use_id)
          : undefined;
        const logicalMessageId = typeof msg.message?.id === 'string' && msg.message.id.trim()
          ? msg.message.id.trim()
          : msg.uuid;
        for (const [blockIdx, block] of blocks.entries()) {
          if (block.type === 'text') {
            if (forwardedSubagentEvent) {
              const displayText = sanitizeAssistantTextForDisplay(block.text).trim().slice(0, 6_000);
              if (displayText && !isSystemText(displayText)) {
                appendLoadedAgentActivity(forwardedAgentId, {
                  id: `${logicalMessageId || generateMessageId()}_agent_text_${blockIdx}`,
                  kind: 'text',
                  content: displayText,
                  timestamp: normalizeSessionTimestamp(msg.timestamp),
                });
              }
              continue;
            }
            const displayText = sanitizeAssistantTextForDisplay(block.text);
            if (!displayText.trim() || isSystemText(displayText)) continue;
            const textId = logicalMessageId
              ? `${logicalMessageId}_text_${blockIdx}`
              : generateMessageId();
            const textMessage: ChatMessage = {
              id: textId,
              role: 'assistant',
              type: 'text',
              content: displayText,
              isFinalResponse: msg.message?.stop_reason === 'end_turn',
              timestamp: normalizeSessionTimestamp(msg.timestamp),
            };
            const existingTextIndex = messages.findIndex((message) => message.id === textId);
            if (existingTextIndex >= 0) messages[existingTextIndex] = textMessage;
            else messages.push(textMessage);
          } else if (block.type === 'thinking') {
            // Subagent detail belongs in the Process panel. Main-agent
            // provider thinking remains available in the conversation as the
            // same compact, default-collapsed row used by the live stream.
            if (forwardedSubagentEvent) continue;
            const thinkingContent = typeof block.thinking === 'string'
              ? block.thinking.trim()
              : '';
            if (!thinkingContent) continue;
            const thinkingId = logicalMessageId
              ? `${logicalMessageId}__thinking_committed`
              : generateMessageId();
            const existingThinkingIndex = messages.findIndex(
              (message) => message.id === thinkingId && message.type === 'thinking',
            );
            if (existingThinkingIndex >= 0) {
              const existingThinking = messages[existingThinkingIndex];
              messages[existingThinkingIndex] = {
                ...existingThinking,
                content: mergeLoadedThinkingContent(
                  existingThinking.content,
                  thinkingContent,
                ),
              };
            } else {
              messages.push({
                id: thinkingId,
                role: 'assistant',
                type: 'thinking',
                content: thinkingContent,
                timestamp: normalizeSessionTimestamp(msg.timestamp),
              });
            }
          } else if (block.type === 'tool_use') {
            // Rebuild agent tree from Agent/Task tool_use blocks
            if (block.name === 'Task' || block.name === 'Agent') {
              const teammateName = typeof block.input?.name === 'string'
                ? block.input.name.trim()
                : '';
              upsertLoadedAgent({
                id: block.id || generateMessageId(),
                parentId: forwardedSubagentEvent
                  ? resolveLoadedAgentId(msg.parent_tool_use_id) ?? 'main'
                  : 'main',
                description: teammateName || block.input?.description || block.input?.prompt || 'Agent',
                phase: 'completed',
                startTime: normalizeSessionTimestamp(msg.timestamp),
                endTime: Date.now(),
                isMain: false,
                kind: teammateName ? 'teammate' : 'subagent',
                name: teammateName || undefined,
              });
            }

            if (forwardedSubagentEvent) {
              appendLoadedAgentActivity(forwardedAgentId, {
                id: `${block.id || logicalMessageId || generateMessageId()}_agent_tool_${blockIdx}`,
                kind: 'tool',
                content: block.name || 'Tool',
                toolName: block.name,
                timestamp: normalizeSessionTimestamp(msg.timestamp),
              });
              continue;
            }

            let chatMsg: ChatMessage;
            if (block.name === 'AskUserQuestion' && block.input?.questions) {
              chatMsg = {
                id: block.id || generateMessageId(),
                role: 'assistant',
                type: 'question',
                content: '',
                toolName: block.name,
                toolInput: block.input,
                questions: block.input.questions,
                resolved: true,
                timestamp: normalizeSessionTimestamp(msg.timestamp),
              };
            } else if (block.name === 'TodoWrite' && block.input?.todos) {
              chatMsg = {
                id: block.id || generateMessageId(),
                role: 'assistant',
                type: 'todo',
                content: '',
                toolName: block.name,
                toolInput: block.input,
                todoItems: block.input.todos,
                timestamp: normalizeSessionTimestamp(msg.timestamp),
              };
            } else {
              chatMsg = {
                id: block.id || generateMessageId(),
                role: 'assistant',
                type: 'tool_use',
                content: '',
                toolName: block.name,
                toolInput: block.input,
                timestamp: normalizeSessionTimestamp(msg.timestamp),
              };
            }
            // Record tool_use_id for later result binding
            if (block.id) {
              toolUseIdToIndex.set(block.id, messages.length);
            }
            messages.push(chatMsg);
          } else if (block.type === 'tool_result') {
            const resultText = Array.isArray(block.content)
              ? block.content.map((b: any) => b.text || b.content || '').join('')
              : typeof block.content === 'string'
                ? block.content
                : block.output || '';
            if (block.tool_use_id) {
              const idx = toolUseIdToIndex.get(block.tool_use_id);
              if (idx !== undefined && messages[idx]) {
                const safeResult = sanitizeToolResultForDisplay(
                  messages[idx].toolName,
                  resultText,
                );
                messages[idx] = {
                  ...messages[idx],
                  toolCompleted: true,
                  ...(safeResult ? { toolResultContent: safeResult } : {}),
                };
              }
            }
          }
        }
      }
    }
  }

  return { messages, agents, mainAgentStartTime: sessionStartTime };
}
