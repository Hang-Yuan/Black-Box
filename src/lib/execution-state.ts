export interface ExecutionState {
  executionId?: string;
  closedExecutionIds?: string[];
  terminalReceipts?: string[];
}

export function projectExecutionEvent(state: ExecutionState, event: any) {
  const id: string | undefined = event.__executionId;
  const rootResult = event.type === 'result' && !event.parent_tool_use_id;
  const receipt = rootResult && (event.uuid || (id && `${id}:result`));
  const closed = state.closedExecutionIds ?? [];
  const receipts = state.terminalReceipts ?? [];
  const alreadyClosed = Boolean(id && closed.includes(id));
  const olderExecution = Boolean(id && state.executionId && id !== state.executionId
    && id.slice(0, id.lastIndexOf(':')) === state.executionId.slice(0, state.executionId.lastIndexOf(':'))
    && Number(id.slice(id.lastIndexOf(':') + 1)) < Number(state.executionId.slice(state.executionId.lastIndexOf(':') + 1)));
  const duplicate = Boolean(rootResult && (alreadyClosed || olderExecution || (receipt && receipts.includes(receipt))));
  const kind = event.type === 'stream_event' ? event.event?.type : event.type;
  const activity = ['assistant', 'message_start', 'content_block_start', 'content_block_delta',
    'message_delta', 'blackbox_permission_request', 'tool_progress', 'tool_use_summary'].includes(kind);
  const progress = activity && !alreadyClosed && !olderExecution;
  const next: ExecutionState = {
    executionId: state.executionId,
    closedExecutionIds: closed,
    terminalReceipts: receipts,
    ...(id && progress ? { executionId: id } : {}),
    ...(rootResult && !duplicate ? {
      closedExecutionIds: id ? [...closed, id].slice(-128) : closed,
      terminalReceipts: receipt ? [...receipts, receipt].slice(-128) : receipts,
    } : {}),
  };
  // Old final supplements remain renderable, while their activity and terminal
  // receipts cannot mutate the current execution's running state.
  return { duplicate, progress, next };
}
