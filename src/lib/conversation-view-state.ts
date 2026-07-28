export interface ScrollPosition {
  top: number;
  atBottom: boolean;
}

const chatPositions = new Map<string, ScrollPosition>();
const filePositions = new Map<string, number>();

function filePositionKey(sessionId: string, filePath: string, mode: string): string {
  return `${sessionId}\u0000${filePath}\u0000${mode}`;
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

export function clearConversationViewStateForTests(): void {
  chatPositions.clear();
  filePositions.clear();
}
