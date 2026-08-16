export interface ScrollPosition {
  top: number;
  atBottom: boolean;
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

function filePositionKey(sessionId: string, filePath: string, mode: string): string {
  return `${sessionId}\u0000${filePath}\u0000${mode}`;
}

function fileTreePositionKey(sessionId: string, rootPath: string): string {
  return `${sessionId}\u0000${rootPath}`;
}

export function saveChatScrollPosition(sessionId: string, position: ScrollPosition): void {
  chatPositions.set(sessionId, position);
}

export function loadChatScrollPosition(sessionId: string): ScrollPosition | null {
  return chatPositions.get(sessionId) ?? null;
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

export function clearConversationViewStateForTests(): void {
  chatPositions.clear();
  filePositions.clear();
  fileTreePositions.clear();
  panelStates.clear();
}
