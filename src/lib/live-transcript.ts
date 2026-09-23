import type { ChatMessage } from '../stores/chatStore';

export function liveTranscriptRevisionKey(revision: {
  bytes: number;
  modifiedMs: number;
}): string {
  return `${revision.bytes}:${revision.modifiedMs}`;
}

export function sameTranscriptMessage(left: ChatMessage, right: ChatMessage): boolean {
  return left.type === right.type
    && left.role === right.role
    && left.content === right.content
    && left.toolResultContent === right.toolResultContent
    && left.toolCompleted === right.toolCompleted
    && left.isFinalResponse === right.isFinalResponse
    && left.isApiErrorMessage === right.isApiErrorMessage
    && left.resolved === right.resolved
    && left.interactionState === right.interactionState
    && left.cwd === right.cwd
    && Boolean(left.isSteer) === Boolean(right.isSteer)
    && left.steerState === right.steerState;
}

/** Match a durable JSONL message to the optimistic foreground message that
 * represents the same user send. Claude assigns its UUID after Black Box has
 * already rendered the local bubble, so ids alone are insufficient. */
export function findTranscriptMessageMatch(
  currentMessages: readonly ChatMessage[],
  durableMessage: ChatMessage,
  claimedMessageIds: ReadonlySet<string> = new Set(),
): ChatMessage | undefined {
  const exact = currentMessages.find((message) => message.id === durableMessage.id);
  if (exact) return exact;
  if (durableMessage.role !== 'user' || durableMessage.type !== 'text') return undefined;

  const checkpointMatch = currentMessages.find((message) => (
    !claimedMessageIds.has(message.id)
    && (
      message.checkpointUuid === durableMessage.id
      || (durableMessage.checkpointUuid && message.checkpointUuid === durableMessage.checkpointUuid)
    )
  ));
  if (checkpointMatch) return checkpointMatch;

  // The CLI can echo a replayed user record before the JSONL monitor runs.
  // That echo clears awaitingPersistence even though the foreground bubble
  // still has Black Box's local msg_* id. Match that local projection by
  // content and send time, then bind the durable UUID below. Attachment paths
  // are intentionally excluded: image preprocessing rewrites the original
  // attachment into a copied source plus detail crops.
  const candidates = currentMessages.filter((message) => (
    !claimedMessageIds.has(message.id)
    && message.role === 'user'
    && message.type === 'text'
    && (message.awaitingPersistence === true || message.id.startsWith('msg_'))
    && message.content === durableMessage.content
    && Math.abs((message.timestamp || 0) - (durableMessage.timestamp || 0)) <= 30_000
  ));
  return candidates.sort((left, right) => (
    Math.abs((left.timestamp || 0) - (durableMessage.timestamp || 0))
    - Math.abs((right.timestamp || 0) - (durableMessage.timestamp || 0))
  ))[0];
}

/** A persisted lead end-turn after the latest human input means the main reply
 * has finished even when asynchronous Agents still keep the CLI process open. */
export function hasLeadResponseAfterLatestUser(messages: readonly ChatMessage[]): boolean {
  let latestUserAt = 0;
  let latestLeadFinalAt = 0;
  let latestLeadErrorAt = 0;
  for (const message of messages) {
    if (message.role === 'user' && !message.isSteer) {
      latestUserAt = Math.max(latestUserAt, message.timestamp || 0);
    }
    if (
      message.role === 'assistant'
      && message.type === 'text'
      && message.isFinalResponse
      && (message.subAgentDepth ?? 0) === 0
    ) {
      latestLeadFinalAt = Math.max(latestLeadFinalAt, message.timestamp || 0);
    }
    if (
      message.role === 'assistant'
      && message.isApiErrorMessage
      && (message.subAgentDepth ?? 0) === 0
    ) {
      latestLeadErrorAt = Math.max(latestLeadErrorAt, message.timestamp || 0);
    }
  }
  return latestLeadFinalAt > 0
    && latestLeadFinalAt >= latestUserAt
    && latestLeadFinalAt > latestLeadErrorAt;
}
