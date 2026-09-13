/** A text offset survives line wrapping and replacement of Markdown DOM nodes. */
export interface ConversationViewportSnapshot {
  atBottom: boolean;
  scrollTop: number;
  anchorId?: string;
  anchorOffset?: number;
  textOffset?: number;
  textViewportOffset?: number;
}

function textNodes(root: Node): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node.textContent?.length) nodes.push(node as Text);
  }
  return nodes;
}

function characterRect(node: Text, offset: number): DOMRect {
  const range = document.createRange();
  range.setStart(node, Math.min(offset, node.length - 1));
  range.setEnd(node, Math.min(offset + 1, node.length));
  return range.getBoundingClientRect();
}

export function captureConversationViewport(container: HTMLElement): ConversationViewportSnapshot {
  const rect = container.getBoundingClientRect();
  const snapshot: ConversationViewportSnapshot = {
    atBottom: container.scrollHeight - container.scrollTop - container.clientHeight < 80,
    scrollTop: container.scrollTop,
  };
  const anchor = Array.from(container.querySelectorAll<HTMLElement>('[data-conversation-anchor-id]'))
    .find((element) => {
      const bounds = element.getBoundingClientRect();
      return bounds.bottom > rect.top + 2 && bounds.top < rect.bottom;
    });
  if (!anchor) return snapshot;
  snapshot.anchorId = anchor.dataset.conversationAnchorId;
  snapshot.anchorOffset = anchor.getBoundingClientRect().top - rect.top;
  let preceding = 0;
  for (const node of textNodes(anchor)) {
    const range = document.createRange();
    range.selectNodeContents(node);
    const bounds = range.getBoundingClientRect();
    if (bounds.height > 0 && bounds.bottom > rect.top + 2 && bounds.top < rect.bottom) {
      let lo = 0;
      let hi = node.length - 1;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (characterRect(node, mid).bottom <= rect.top + 2) lo = mid + 1;
        else hi = mid;
      }
      snapshot.textOffset = preceding + lo;
      snapshot.textViewportOffset = characterRect(node, lo).top - rect.top;
      break;
    }
    preceding += node.length;
  }
  return snapshot;
}

export function restoreConversationViewport(container: HTMLElement, snapshot: ConversationViewportSnapshot): void {
  if (snapshot.atBottom) { container.scrollTop = container.scrollHeight; return; }
  const anchor = Array.from(container.querySelectorAll<HTMLElement>('[data-conversation-anchor-id]'))
    .find((element) => element.dataset.conversationAnchorId === snapshot.anchorId);
  if (anchor) {
    let offset = snapshot.textOffset;
    if (offset !== undefined && snapshot.textViewportOffset !== undefined) {
      for (const node of textNodes(anchor)) {
        if (offset < node.length) {
          const bounds = characterRect(node, offset);
          if (bounds.height > 0) {
            container.scrollTop += bounds.top - container.getBoundingClientRect().top - snapshot.textViewportOffset;
            return;
          }
          break;
        }
        offset -= node.length;
      }
    }
    container.scrollTop += anchor.getBoundingClientRect().top - container.getBoundingClientRect().top
      - (snapshot.anchorOffset ?? 0);
    return;
  }
  container.scrollTop = snapshot.scrollTop;
}
