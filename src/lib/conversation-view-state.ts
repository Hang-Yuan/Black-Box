import type { ConversationViewportSnapshot } from './conversation-viewport';
export interface ScrollPosition {
  top: number;
  atBottom: boolean;
  viewport?: ConversationViewportSnapshot;
}

export interface ConversationPanelState {
  open: boolean;
  tab: 'activity' | 'files';
  width: number;
}

const chatPositions = new Map<string, ScrollPosition>();
const filePositions = new Map<string, number>();
const fileTreePositions = new Map<string, number>();
const panelStates = new Map<string, ConversationPanelState>();

function movePrefixedEntries<T>(
  entries: Map<string, T>,
  fromSessionId: string,
  toSessionId: string,
): void {
  const prefix = `${fromSessionId}\u0000`;
  for (const [key, value] of Array.from(entries.entries())) {
    if (!key.startsWith(prefix)) continue;
    entries.set(`${toSessionId}\u0000${key.slice(prefix.length)}`, value);
    entries.delete(key);
  }
}

function filePositionKey(sessionId: string, filePath: string, mode: string): string {
  return `${sessionId}\u0000${filePath}\u0000${mode}`;
}

function fileTreePositionKey(sessionId: string, rootPath: string): string {
  return `${sessionId}\u0000${rootPath}`;
}

export function saveChatScrollPosition(sessionId: string, position: ScrollPosition): void {
  chatPositions.set(sessionId, position);
  try {
    sessionStorage.setItem(`blackbox:reading:${sessionId}`, JSON.stringify(position));
  } catch { /* Storage pressure must not break scrolling. */ }
}

export function loadChatScrollPosition(sessionId: string): ScrollPosition | null {
  if (chatPositions.has(sessionId)) return chatPositions.get(sessionId)!;
  try {
    const value = JSON.parse(sessionStorage.getItem(`blackbox:reading:${sessionId}`) ?? 'null');
    if (value && Number.isFinite(value.top) && typeof value.atBottom === 'boolean') return value;
  } catch { /* Ignore obsolete view state. */ }
  return null;
}

export function saveFileScrollPosition(
  sessionId: string,
  filePath: string,
  mode: string,
  top: number,
): void {
  filePositions.set(filePositionKey(sessionId, filePath, mode), top);
}

export function loadFileScrollPosition(
  sessionId: string,
  filePath: string,
  mode: string,
): number | null {
  return filePositions.get(filePositionKey(sessionId, filePath, mode)) ?? null;
}

export function saveFileTreeScrollPosition(
  sessionId: string,
  rootPath: string,
  top: number,
): void {
  fileTreePositions.set(fileTreePositionKey(sessionId, rootPath), top);
}

export function loadFileTreeScrollPosition(
  sessionId: string,
  rootPath: string,
): number | null {
  return fileTreePositions.get(fileTreePositionKey(sessionId, rootPath)) ?? null;
}

export function saveConversationPanelState(
  sessionId: string,
  state: ConversationPanelState,
): void {
  panelStates.set(sessionId, { ...state });
}

export function loadConversationPanelState(
  sessionId: string,
): ConversationPanelState | null {
  const state = panelStates.get(sessionId);
  return state ? { ...state } : null;
}

/**
 * A draft_* id is replaced by the CLI's durable session id after the first
 * accepted turn. View state belongs to the conversation, so the identity
 * change must rename every key instead of making the promoted conversation
 * look like an unrelated tab.
 */
export function moveConversationViewState(
  fromSessionId: string,
  toSessionId: string,
): void {
  if (!fromSessionId || !toSessionId || fromSessionId === toSessionId) return;

  const chat = chatPositions.get(fromSessionId);
  if (chat) chatPositions.set(toSessionId, chat);
  chatPositions.delete(fromSessionId);

  movePrefixedEntries(filePositions, fromSessionId, toSessionId);
  movePrefixedEntries(fileTreePositions, fromSessionId, toSessionId);

  const panel = panelStates.get(fromSessionId);
  if (panel) panelStates.set(toSessionId, panel);
  panelStates.delete(fromSessionId);

  try {
    const fromKey = `blackbox:reading:${fromSessionId}`;
    const stored = sessionStorage.getItem(fromKey);
    if (stored !== null) sessionStorage.setItem(`blackbox:reading:${toSessionId}`, stored);
    sessionStorage.removeItem(fromKey);
  } catch { /* Storage pressure must not break identity promotion. */ }
}

export function clearConversationViewStateForTests(): void {
  chatPositions.clear();
  filePositions.clear();
  fileTreePositions.clear();
  panelStates.clear();
}
