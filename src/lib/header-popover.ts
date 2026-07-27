export type HeaderPopoverId =
  | 'agent'
  | 'provider'
  | 'model'
  | 'mode'
  | 'workflow'
  | 'loop'
  | 'goal'
  | 'task-location';

const HEADER_POPOVER_EVENT = 'blackbox:header-popover-open';

export function announceHeaderPopover(id: HeaderPopoverId): void {
  window.dispatchEvent(new CustomEvent<HeaderPopoverId>(HEADER_POPOVER_EVENT, { detail: id }));
}

export function subscribeHeaderPopover(
  id: HeaderPopoverId,
  close: () => void,
): () => void {
  const listener = (event: Event) => {
    if ((event as CustomEvent<HeaderPopoverId>).detail !== id) close();
  };
  window.addEventListener(HEADER_POPOVER_EVENT, listener);
  return () => window.removeEventListener(HEADER_POPOVER_EVENT, listener);
}
